import { chromium, type Browser, type BrowserContext, type CDPSession, type Frame, type Locator, type Page } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { DemoAction } from "@demomotion/schema";
import { ScreencastCapture } from "./capture-adapter.js";
import { NetworkPolicy, type Decision, type LookupFn } from "./network-policy.js";

/**
 * Capture mode.
 *
 * `screencast` (default) is the deterministic CDP adapter: events and frames
 * share one time base (spec §4). `record-video` is the legacy Playwright
 * `recordVideo` path, kept ONLY so the misalignment it causes stays observable
 * — its events are stamped with wall-clock `Date.now()` while the video is a
 * variable-framerate webm whose start instant is not exposed.
 */
type CaptureMode = "screencast" | "record-video";

function captureMode(): CaptureMode {
  return process.env.DEMOMOTION_CAPTURE === "record-video" ? "record-video" : "screencast";
}

/** How a request was stopped, and what it was. Reported by `session_status` and `session_stop`. */
export interface BlockedRequest {
  /** Monotonic within the session, so a caller can tell "since my call" apart. */
  seq: number;
  url: string;
  host: string;
  port: number;
  /**
   * `navigation`: a top-level or frame document load (a `goto`, a click on a
   * link, `window.open`). `redirect`: an HTTP redirect hop. `subresource`:
   * fetch/XHR/script/image/... `websocket`: a WebSocket handshake.
   */
  kind: "navigation" | "redirect" | "subresource" | "websocket";
  reason: string;
  message: string;
  atMs: number;
}

/** Blocked requests kept per session; a page that hammers a forbidden host must not grow memory. */
const BLOCKED_REQUESTS_KEPT = 200;

export interface Session {
  id: string;
  dir: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  startedAt: number;
  width: number;
  height: number;
  fps: number;
  mode: CaptureMode;
  capture?: ScreencastCapture;
  actions: DemoAction[];
  policy: NetworkPolicy;
  /** The most recent `BLOCKED_REQUESTS_KEPT` blocks; `blockedCount` is the true total. */
  blockedRequests: BlockedRequest[];
  blockedCount: number;
}

const sessions = new Map<string, Session>();

/**
 * Current time on the session's capture time base, in ms.
 *
 * In screencast mode this is the timestamp of the most-recent screencast frame
 * (`sourceMs`, spec §3/§4) — the SAME line the frames live on, so an event's
 * `atMs` maps to a frame index by construction. In legacy record-video mode it
 * falls back to wall-clock elapsed, which is exactly the mismatch being fixed.
 */
function nowSourceMs(s: Session): number {
  if (s.mode === "screencast" && s.capture) return s.capture.nowSourceMs();
  return Date.now() - s.startedAt;
}

/**
 * Launches the capture browser.
 *
 * By default Playwright's bundled Chromium is used so CI stays deterministic.
 * Setting DEMOMOTION_BROWSER_CHANNEL (e.g. "chrome" or "msedge") makes Playwright
 * drive a locally installed browser instead — useful on hosts where the bundled
 * Chromium build is unavailable.
 */
async function launchBrowser(headless: boolean, args: string[]): Promise<Browser> {
  const channel = process.env.DEMOMOTION_BROWSER_CHANNEL?.trim() || undefined;
  try {
    return await chromium.launch(channel ? { headless, channel, args } : { headless, args });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const hint = channel
      ? `Browser channel "${channel}" could not be launched; install that browser or unset DEMOMOTION_BROWSER_CHANNEL to fall back to the bundled Chromium.`
      : `Failed to launch Playwright's bundled Chromium; if it is missing or unsupported on this host, set DEMOMOTION_BROWSER_CHANNEL=chrome to drive the locally installed Google Chrome instead.`;
    throw new Error(`${hint}\n\nOriginal launch error: ${detail}`, { cause: error });
  }
}

// ---------------------------------------------------------------------------
// Network policy enforcement
// ---------------------------------------------------------------------------
//
// ONE policy (`NetworkPolicy`), enforced at TWO points, because no single hook
// sees every request:
//
//  1. A raw CDP `Fetch` session on the BROWSER target (`installHttpGuard`),
//     deciding EVERY http(s) request of EVERY target in the browser — the
//     page, a cross-process <iframe> (its own target under site isolation), an
//     iframe nested inside that one, a popup, a dedicated or shared worker —
//     from the network layer in the browser process. A new target is therefore
//     covered before its first request goes out, with nothing to install per
//     target. Navigations, fetch/XHR, images, scripts, iframes AND redirect
//     hops all surface here. This is the whole enforcement surface for http(s);
//     it is deliberately the ONLY one (see below).
//  2. `context.routeWebSocket("**/*")` (`installWebSocketGuard`) — WebSocket
//     handshakes, which the Fetch domain does not intercept.
//
// Why a BROWSER-target Fetch session, and why it is the only http(s) layer —
// all verified by execution (Chrome 152, playwright-core 1.63):
//   - A `Fetch` session attached to a PAGE (`context.newCDPSession(page)`) sees
//     that one target; an out-of-process iframe's requests never reach it, so a
//     redirect hop issued inside an OOPIF escaped it at PORT granularity (the
//     resolver rules below still stopped it at HOST granularity). Playwright
//     already auto-attaches to OOPIFs on its own internal sessions, but not on
//     a session the user opens. The browser-target session sees them all.
//   - A popup (`window.open`) is a new target whose first navigation — and a
//     302 answering it — goes out before Playwright reports the popup to a
//     `context.on("page")` handler, so a per-page guard attached there is too
//     late. The browser session is already watching when the popup is created.
//   - `context.route` (Playwright's own page-level interception) was the first
//     http(s) layer here. Kept ALONGSIDE the browser Fetch session, the two
//     intercepting the same keepalive request (a `sendBeacon` whose response
//     redirects) deadlock the load — `goto` hangs to its timeout even though
//     the forbidden host is never reached. The browser Fetch session alone has
//     no such interaction and is strictly more capable (it also sees shared-
//     worker requests, which `context.route` did not), so it replaced it.
//   - A redirect hop is NOT reliably marked as one. A cross-origin 302 on a
//     fetch()/XHR is restarted by Chromium's CORS loader as a fresh request
//     with no `redirectedRequestId` (an <img> or a navigation hop IS marked).
//     So this layer decides EVERY request it sees, and uses the mark — plus a
//     memory of recently seen network ids — only to LABEL a block `redirect`.
//
// Underneath, Chromium's own resolver is closed with `--host-resolver-rules`
// (see `NetworkPolicy.chromiumArgs`): unlisted hostnames and literals cannot
// resolve at all, and listed names are pinned to the address WE resolved. That
// covers service workers (also blocked outright) and anything else that bypasses
// interception, at host granularity.

function recordBlock(s: Session, decision: Extract<Decision, { allowed: false }>, kind: BlockedRequest["kind"]): BlockedRequest {
  const record: BlockedRequest = {
    seq: ++s.blockedCount,
    url: decision.url,
    host: decision.host,
    port: decision.port,
    kind,
    reason: decision.reason,
    message: decision.message,
    atMs: nowSourceMs(s)
  };
  s.blockedRequests.push(record);
  if (s.blockedRequests.length > BLOCKED_REQUESTS_KEPT) s.blockedRequests.shift();
  return record;
}

/**
 * The WebSocket layer (point 3 above). Neither the route nor the Fetch domain
 * intercepts a WebSocket handshake; Playwright's `routeWebSocket` does.
 */
async function installWebSocketGuard(s: Session) {
  await s.context.routeWebSocket("**/*", async (ws) => {
    // The policy speaks http(s); a WebSocket is the same host:port over ws(s).
    const asHttp = ws.url().replace(/^ws(s?):/, "http$1:");
    const decision = await s.policy.check(asHttp);
    if (decision.allowed) {
      ws.connectToServer();
      return;
    }
    recordBlock(s, { ...decision, url: ws.url() }, "websocket");
    ws.close({ code: 1008, reason: "blocked by DemoMotion network policy" });
  });
}

/**
 * How many Network request ids the Fetch layer remembers, to recognise an
 * unmarked redirect hop (see `installHttpGuard`). A page that makes more
 * requests than this between a request and its hop only loses the LABEL
 * (`redirect` becomes `subresource`); the hop is refused either way.
 */
const NETWORK_IDS_REMEMBERED = 4096;

/** A bounded set that forgets its oldest member first. */
class RecentSet<T> {
  private readonly items = new Set<T>();
  constructor(private readonly capacity: number) {}
  has(item: T): boolean { return this.items.has(item); }
  add(item: T): void {
    if (this.items.has(item)) return;
    this.items.add(item);
    if (this.items.size > this.capacity) {
      const oldest = this.items.values().next().value as T;
      this.items.delete(oldest);
    }
  }
}

/**
 * The http(s) layer (point 1 above): one CDP `Fetch` session on the browser
 * target, deciding every http(s) request of every target.
 *
 * Labelling a block: a hop is `redirect` when Chromium marks it
 * (`redirectedRequestId`) OR when its Network request id was already seen on
 * an earlier request — Chromium keeps that id across the restart it performs
 * for a cross-origin fetch()/XHR redirect, which is the hop it does not mark.
 * A `Document` load is a `navigation` and is aborted (the page stays where it
 * was, no `chrome-error://` frame); anything else is a `subresource`, failed as
 * an ad blocker would (a rejected fetch the page already knows how to handle).
 */
async function installHttpGuard(s: Session) {
  const cdp: CDPSession = await s.browser.newBrowserCDPSession();
  const seen = new RecentSet<string>(NETWORK_IDS_REMEMBERED);
  cdp.on("Fetch.requestPaused", (event) => {
    const requestId = event.requestId;
    const isHop = event.redirectedRequestId !== undefined || (event.networkId !== undefined && seen.has(event.networkId));
    if (event.networkId !== undefined) seen.add(event.networkId);
    void s.policy.check(event.request.url).then(async (decision) => {
      if (decision.allowed) {
        await cdp.send("Fetch.continueRequest", { requestId });
        return;
      }
      const isNavigation = event.resourceType === "Document";
      recordBlock(s, decision, isHop ? "redirect" : isNavigation ? "navigation" : "subresource");
      await cdp.send("Fetch.failRequest", { requestId, errorReason: isNavigation ? "Aborted" : "BlockedByClient" });
    }).catch(() => {
      // Request already gone (target navigated or closed).
    });
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
}

export async function startSession(opts: {
  width: number;
  height: number;
  headless: boolean;
  fps?: number;
  deviceScaleFactor?: number;
  /**
   * Overrides for the network allowlist. Absent, the policy is read from
   * `DEMOMOTION_ALLOWED_HOSTS` and names are resolved with `dns.lookup`.
   * Tests inject both so they never touch the network.
   */
  network?: { allowedHosts?: string; lookup?: LookupFn };
}) {
  const id = crypto.randomUUID();
  const dir = path.resolve("data/sessions", id);
  await fs.mkdir(dir, { recursive: true });

  const mode = captureMode();
  const fps = opts.fps ?? (Number(process.env.DEMOMOTION_FPS) || 30);
  const deviceScaleFactor =
    opts.deviceScaleFactor ?? (Number(process.env.DEMOMOTION_DSF) || 1);

  // The policy is fixed BEFORE the browser exists: its listed names are
  // resolved now, once, and the browser is launched pinned to those answers.
  const policy = new NetworkPolicy({
    allowedHosts: opts.network?.allowedHosts ?? process.env.DEMOMOTION_ALLOWED_HOSTS,
    lookup: opts.network?.lookup
  });
  await policy.prepare();

  const browser = await launchBrowser(opts.headless, policy.chromiumArgs());
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor,
    // A service worker's fetches bypass request interception (Playwright
    // documents this); the policy cannot see them, so they do not run.
    serviceWorkers: "block",
    // Legacy path records a VFR webm; screencast path captures via CDP instead.
    ...(mode === "record-video"
      ? { recordVideo: { dir, size: { width: opts.width, height: opts.height } } }
      : {})
  });
  const page = await context.newPage();

  const session: Session = {
    id,
    dir,
    browser,
    context,
    page,
    startedAt: Date.now(),
    width: opts.width,
    height: opts.height,
    fps,
    mode,
    actions: [],
    policy,
    blockedRequests: [],
    blockedCount: 0
  };

  // Guards go in before the first navigation can happen — and before the
  // screencast, so nothing the capture does is ever outside the policy. The
  // http guard is browser-wide, so a popup or a cross-process frame created
  // later is covered from its first request with nothing more to install.
  await installHttpGuard(session);
  await installWebSocketGuard(session);

  if (mode === "screencast") {
    session.capture = await ScreencastCapture.start({
      page,
      dir,
      fps,
      width: opts.width,
      height: opts.height,
      deviceScaleFactor
    });
  }

  sessions.set(id, session);
  return session;
}

export function getSession(id: string) {
  const session = sessions.get(id);
  if (!session) throw new Error(`Unknown session: ${id}`);
  return session;
}

/**
 * Current time on the session's capture time base, in ms — the same base events
 * are stamped in. Exported so a test can read the adapter's clock at the exact
 * instant it triggers an independent visual signal, without duplicating the
 * private time-base logic.
 */
export function captureTimeMs(id: string): number {
  return nowSourceMs(getSession(id));
}

/**
 * Navigates. The http guard is the authority; the check up front only spares
 * the agent a navigation that would be aborted anyway, and gives it the
 * policy's own message instead of Playwright's `net::ERR_ABORTED`. A refusal
 * is recorded like any other block, so `session_status` shows it.
 *
 * When the navigation itself is stopped by the http guard (a 302 to a forbidden
 * host, say), Playwright rejects with a generic network error; that is
 * translated back into the recorded block's message, which names the host that
 * was refused and the variable to set.
 */
export async function goto(id: string, url: string) {
  const s = getSession(id);
  const decision = await s.policy.check(url);
  if (!decision.allowed) {
    recordBlock(s, decision, "navigation");
    throw new Error(decision.message);
  }
  const safeUrl = decision.url;
  const atMs = nowSourceMs(s);
  const blockedBefore = s.blockedCount;
  try {
    await s.page.goto(safeUrl, { waitUntil: "networkidle" });
  } catch (error) {
    const blocked = s.blockedRequests.find(
      (b) => b.seq > blockedBefore && (b.kind === "navigation" || b.kind === "redirect")
    );
    if (blocked) throw new Error(blocked.message, { cause: error });
    throw error;
  }
  s.actions.push({ id: crypto.randomUUID(), type: "goto", atMs, durationMs: nowSourceMs(s) - atMs, url: safeUrl });
}

// ---------------------------------------------------------------------------
// Running code inside the page
// ---------------------------------------------------------------------------

/**
 * Serializes a CALL to `fn` into a self-invoking expression for Playwright to
 * evaluate inside the browser.
 *
 * Why a string, and not the function itself. Playwright ships the SOURCE of a
 * callback into the page. Under `tsx` — the way the README tells MCP clients to
 * launch this server — that source has already been through esbuild, whose
 * `keepNames` rewrites every *named* function expression into
 * `__name(fn, "fn")`. `__name` is a module-local helper that exists in Node and
 * never in the page, so the callback dies the instant it runs in the browser:
 *
 *     locator.evaluateAll: ReferenceError: __name is not defined
 *
 * Compiled `dist/` (plain `tsc`, no esbuild) carries no such helper, which is
 * why the defect only ever appeared on the documented tsx path.
 *
 * Building the expression here fixes the class, not the instance: the evaluated
 * scope gets its own identity `__name`, so any injected `__name(...)` — today's
 * or one a future edit introduces — resolves lexically to it. Nothing is written
 * to the page's globals: the target application is left exactly as it was found.
 * Under `tsc` there are no injected calls and the binding is simply unused.
 *
 * Arguments are embedded as JSON literals instead of going through Playwright's
 * `arg` channel because Playwright never INVOKES a string expression (it hands
 * back whatever the expression evaluates to, and `isFunction` is `false` for a
 * string) — the call has to happen inside the expression. Every argument must
 * therefore be JSON-serializable.
 */
function inPage<A extends readonly unknown[], R>(fn: (...args: A) => R, ...args: A): string {
  const argumentList = args.map((value) => JSON.stringify(value)).join(", ");
  return `(() => { const __name = (target) => target; return (${fn.toString()})(${argumentList}); })()`;
}

/** The element kinds worth offering an agent as a click/fill target. */
const INTERACTIVE_SELECTOR = "a,button,input,textarea,select,[role],[data-testid]";

/** One interactive element, as an agent sees it. */
export interface InspectedElement {
  tag: string;
  text: string;
  role?: string;
  selector: string;
  /** URL of the frame the element lives in; the page URL for main-frame elements. */
  frameUrl: string;
}

/**
 * Runs INSIDE the browser. Self-contained by necessity: no closure, no imports,
 * JSON in and JSON out.
 *
 * `cssEscape` is deliberately left as a NAMED local function expression. That is
 * exactly the shape esbuild rewrites into `__name(...)`, so the regression test
 * for that bug keeps having something real to bite on; remove the name and the
 * test would still pass with `inPage` deleted.
 *
 * Exported for that test alone: it reads this function's TRANSPILED source to
 * prove the `__name` hazard is actually present in the runtime it is running
 * under. Without that check the regression test could pass vacuously, on a
 * toolchain that never injected the helper in the first place.
 */
export function collectInteractive(selector: string): Array<Omit<InspectedElement, "frameUrl">> {
  const cssEscape = (value: string) => {
    const css = (globalThis as any).CSS;
    return css?.escape ? css.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };
  return Array.from(document.querySelectorAll(selector)).map((node: Element) => {
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const testId = el.getAttribute("data-testid");
    const id = el.id;
    const name = el.getAttribute("name");
    const role = el.getAttribute("role") || undefined;
    const aria = el.getAttribute("aria-label") || "";
    const text = (aria || el.innerText || (el as HTMLInputElement).placeholder || "").trim().replace(/\s+/g, " ").slice(0, 160);
    let selector = tag;
    if (testId) selector = `[data-testid="${testId.replace(/"/g, '\\"')}"]`;
    else if (id) selector = `#${cssEscape(id)}`;
    else if (name) selector = `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
    return { tag, text, role, selector };
  }).filter((x) => x.text || x.role || ["input", "button", "a", "select", "textarea"].includes(x.tag));
}

/** Runs INSIDE the browser: can this document still scroll on the asked axis? */
function documentCanScroll(deltaX: number, deltaY: number): boolean {
  const el = (document.scrollingElement || document.documentElement) as Element;
  const vertical = deltaY !== 0 && el.scrollHeight > el.clientHeight + 1;
  const horizontal = deltaX !== 0 && el.scrollWidth > el.clientWidth + 1;
  return vertical || horizontal;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * Every live frame of the page, MAIN FRAME FIRST, then the rest in Playwright's
 * attachment order (document order, for static markup).
 *
 * This order IS the documented cross-frame rule: **first match wins**. A
 * selector that matches in several frames resolves in the main frame when it
 * matches there, otherwise in the first-attached frame that matches; inside a
 * frame `.first()` picks the first match, exactly as it always did.
 */
function framesInResolutionOrder(page: Page): Frame[] {
  const main = page.mainFrame();
  return [main, ...page.frames().filter((frame) => frame !== main)].filter((frame) => !frame.isDetached());
}

/** How long a selector may stay unfound anywhere before the main frame takes over. */
const FRAME_RESOLVE_TIMEOUT_MS = Number(process.env.DEMOMOTION_FRAME_RESOLVE_TIMEOUT_MS) || 5_000;
const FRAME_RESOLVE_POLL_MS = 100;

/**
 * Resolves a selector across every frame, so the tool signature stays what the
 * agent already knows: a selector, nothing more.
 *
 * When nothing matches anywhere before the deadline, the MAIN-frame locator is
 * returned unresolved on purpose: the caller's action then auto-waits and fails
 * with Playwright's own "waiting for locator" message, which is the behaviour
 * that existed before frames were considered at all.
 */
async function resolveAcrossFrames(s: Session, selector: string): Promise<Locator> {
  const deadline = Date.now() + FRAME_RESOLVE_TIMEOUT_MS;
  for (;;) {
    for (const frame of framesInResolutionOrder(s.page)) {
      const locator = frame.locator(selector).first();
      try {
        if ((await locator.count()) > 0) return locator;
      } catch {
        // Frame detached or navigating mid-scan: it is simply not the one.
      }
    }
    if (Date.now() >= deadline) return s.page.locator(selector).first();
    await s.page.waitForTimeout(FRAME_RESOLVE_POLL_MS);
  }
}

export async function click(id: string, selector: string, label?: string) {
  const s = getSession(id);
  // sourceMs = timestamp of the most-recent screencast frame (spec §4). Anchored
  // BEFORE the click so it shares the frames' time base by construction.
  const atMs = nowSourceMs(s);
  const locator = await resolveAcrossFrames(s, selector);
  // boundingBox() is relative to the MAIN frame's viewport even when the element
  // lives inside an <iframe> — Playwright adds the frame offset itself — so the
  // normalized x/y the zoom and cursor model consume stay correct one frame
  // deeper. Verified against the fixture: an element whose in-frame rect starts
  // at 1027,190 inside a frame whose box starts at 48,72 reports 1075,262.
  const box = await locator.boundingBox();
  await locator.click();
  s.actions.push({
    id: crypto.randomUUID(),
    type: "click",
    atMs,
    durationMs: nowSourceMs(s) - atMs,
    selector,
    label,
    x: box ? (box.x + box.width / 2) / s.width : undefined,
    y: box ? (box.y + box.height / 2) / s.height : undefined
  });
}

/**
 * Fills a field, optionally TYPING it one character at a time.
 *
 * Why this exists. `locator.fill()` sets the value in a single operation: on
 * screen the field goes from empty to complete inside one frame, and the demo
 * reads as rushed no matter how long the pauses around it are — the keystrokes
 * never happened. `typeDelayMs` sends real key events instead, `delay` ms apart,
 * which is what a viewer recognizes as a person filling a form.
 *
 * `pressSequentially` is Playwright's current API for that (`locator.type()` is
 * deprecated); it is declared on `Locator` in playwright-core 1.63.0's
 * types.d.ts, the version this package pins.
 *
 * Absent or 0, nothing changes: the old instant `.fill()` runs, so no existing
 * caller and no existing capture is affected.
 *
 * The field is cleared BEFORE typing — `pressSequentially` appends to whatever
 * is already there, so without this a second fill of the same field would end
 * up holding both values.
 */
export async function fill(
  id: string,
  selector: string,
  value: string,
  label?: string,
  typeDelayMs?: number
) {
  const s = getSession(id);
  const atMs = nowSourceMs(s);
  // Wall clock alongside the capture's own clock: see the `durationMs` note
  // below. Both tick at real-time rate, so they measure the same quantity.
  const startedWallMs = Date.now();
  const locator = await resolveAcrossFrames(s, selector);
  const box = await locator.boundingBox();
  if (typeDelayMs && typeDelayMs > 0) {
    await locator.fill("");
    await locator.pressSequentially(value, { delay: typeDelayMs });
  } else {
    await locator.fill(value);
  }
  s.actions.push({
    id: crypto.randomUUID(),
    type: "fill",
    atMs,
    // The capture's clock only advances when a screencast frame arrives, so on
    // the last keystroke it can still sit up to one frame interval behind. The
    // wall-clock elapsed is a floor under that: typing time is what the
    // compositor's zoom and caption windows are derived from, and a typed fill
    // reported as instant would desynchronize both. Never a ceiling — `atMs`
    // stays on the frame line, which is the invariant that matters.
    durationMs: Math.max(nowSourceMs(s) - atMs, Date.now() - startedWallMs),
    selector,
    value: "[redacted]",
    label,
    x: box ? (box.x + box.width / 2) / s.width : undefined,
    y: box ? (box.y + box.height / 2) / s.height : undefined
  });
}

export async function wait(id: string, ms: number) {
  const s = getSession(id);
  const atMs = nowSourceMs(s);
  await s.page.waitForTimeout(ms);
  s.actions.push({ id: crypto.randomUUID(), type: "wait", atMs, durationMs: ms });
}

export async function screenshot(id: string, name = "screen.png") {
  const s = getSession(id);
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const file = path.join(s.dir, safe);
  await s.page.screenshot({ path: file, fullPage: false });
  s.actions.push({ id: crypto.randomUUID(), type: "screenshot", atMs: nowSourceMs(s), durationMs: 0, label: safe });
  return file;
}

export async function stopSession(id: string) {
  const s = getSession(id);

  let videoPath: string | null;
  let durationMs: number;
  let width = s.width;
  let height = s.height;
  let fps = s.fps;
  let frameCount: number | undefined;

  if (s.mode === "screencast" && s.capture) {
    // Assemble the CFR artifact BEFORE tearing the browser down (the CDP
    // session and the on-disk frames both need the context alive).
    const result = await s.capture.stop();
    videoPath = result.artifact.path;
    durationMs = result.durationMs;
    width = result.width;
    height = result.height;
    fps = result.fps;
    frameCount = result.frameCount;
    await s.context.close();
    await s.browser.close();
  } else {
    const video = s.page.video();
    durationMs = nowSourceMs(s);
    await s.context.close();
    videoPath = video ? await video.path() : null;
    await s.browser.close();
  }

  const manifest = {
    id: s.id,
    width,
    height,
    fps,
    frameCount,
    durationMs,
    videoPath,
    actions: s.actions,
    allowedHosts: s.policy.describe(),
    blockedRequests: s.blockedRequests,
    blockedCount: s.blockedCount
  };
  const manifestPath = path.join(s.dir, "capture.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  sessions.delete(id);

  return { ...manifest, manifestPath };
}

export function status(id: string) {
  const s = getSession(id);
  return {
    id: s.id,
    elapsedMs: nowSourceMs(s),
    url: s.page.url(),
    actions: s.actions.length,
    viewport: { width: s.width, height: s.height },
    allowedHosts: s.policy.describe(),
    blockedRequests: s.blockedRequests,
    blockedCount: s.blockedCount
  };
}

/**
 * Points the wheel at something that can actually scroll.
 *
 * `mouse.wheel` is POSITIONAL: the browser routes it to whichever frame sits
 * under the pointer, and the pointer starts at 0,0. On a page whose content is
 * an <iframe>, that corner belongs to the host document — which usually has
 * nothing to scroll — so the wheel does nothing at all and the agent is blind
 * again, this time to everything below the fold.
 *
 * If the main document can still scroll on the requested axis, nothing changes.
 * Otherwise the pointer moves to the centre of the largest visible frame that
 * can — a real mouse move, the same thing a person does before scrolling.
 */
async function aimWheelAtScrollableFrame(s: Session, deltaX: number, deltaY: number) {
  const main = s.page.mainFrame();
  try {
    if (await main.evaluate<boolean>(inPage(documentCanScroll, deltaX, deltaY))) return;
  } catch {
    return; // Cannot read the main document: leave the pointer where it is.
  }

  let best: { x: number; y: number; area: number } | undefined;
  for (const frame of framesInResolutionOrder(s.page)) {
    if (frame === main) continue;
    try {
      if (!(await frame.evaluate<boolean>(inPage(documentCanScroll, deltaX, deltaY)))) continue;
      const element = await frame.frameElement();
      const box = await element.boundingBox();
      await element.dispose();
      if (!box || box.width <= 0 || box.height <= 0) continue;
      const area = box.width * box.height;
      if (!best || area > best.area) best = { x: box.x + box.width / 2, y: box.y + box.height / 2, area };
    } catch {
      // Cross-origin, detached or navigating frame: skip it, keep scanning.
    }
  }
  if (best) await s.page.mouse.move(best.x, best.y);
}

export async function scroll(id: string, deltaY: number, deltaX = 0) {
  const s = getSession(id);
  const atMs = nowSourceMs(s);
  await aimWheelAtScrollableFrame(s, deltaX, deltaY);
  await s.page.mouse.wheel(deltaX, deltaY);
  await s.page.waitForTimeout(150);
  s.actions.push({ id: crypto.randomUUID(), type: "scroll", atMs, durationMs: nowSourceMs(s) - atMs, deltaX, deltaY });
}

/**
 * Keyboard input needs no frame handling: the key goes to whatever has focus,
 * and focus follows the last click — so a click resolved inside an <iframe>
 * leaves the focus there and the keys land in that frame, exactly as they would
 * for a person. With nothing clicked yet, the host document has focus, which is
 * also what a person would get.
 */
export async function keypress(id: string, key: string) {
  const s = getSession(id);
  const atMs = nowSourceMs(s);
  await s.page.keyboard.press(key);
  s.actions.push({ id: crypto.randomUUID(), type: "keypress", atMs, durationMs: nowSourceMs(s) - atMs, key });
}

/**
 * Every interactive element on the page, from EVERY frame, each tagged with the
 * frame it came from.
 *
 * A single-frame inspection is how an agent goes blind on a real site: on the
 * page that exposed this, the host document held three controls (a cookie
 * banner) and the whole product lived one frame deeper. `frameUrl` is what lets
 * the agent tell the two apart; the selectors are usable as-is, because `click`
 * and `fill` resolve across frames too.
 *
 * A frame that cannot be read — cross-origin without access, detached, or
 * navigating — is reported in `skippedFrames` and skipped. Being unable to see
 * one frame must not blind the agent to the rest of the page.
 *
 * `limit` caps the MERGED list, main frame first.
 */
export async function inspectPage(id: string, limit = 80) {
  const s = getSession(id);
  const elements: InspectedElement[] = [];
  const skippedFrames: Array<{ frameUrl: string; reason: string }> = [];

  for (const frame of framesInResolutionOrder(s.page)) {
    const frameUrl = frame.url();
    try {
      const found = await frame.evaluate<Array<Omit<InspectedElement, "frameUrl">>>(
        inPage(collectInteractive, INTERACTIVE_SELECTOR)
      );
      for (const element of found) elements.push({ ...element, frameUrl });
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      skippedFrames.push({ frameUrl, reason });
    }
  }

  return {
    url: s.page.url(),
    title: await s.page.title(),
    frameCount: framesInResolutionOrder(s.page).length,
    elements: elements.slice(0, Math.max(1, Math.min(limit, 200))),
    skippedFrames
  };
}
