import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { DemoAction } from "@demomotion/schema";
import { ScreencastCapture } from "./capture-adapter.js";

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
async function launchBrowser(headless: boolean): Promise<Browser> {
  const channel = process.env.DEMOMOTION_BROWSER_CHANNEL?.trim() || undefined;
  try {
    return await chromium.launch(channel ? { headless, channel } : { headless });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const hint = channel
      ? `Browser channel "${channel}" could not be launched; install that browser or unset DEMOMOTION_BROWSER_CHANNEL to fall back to the bundled Chromium.`
      : `Failed to launch Playwright's bundled Chromium; if it is missing or unsupported on this host, set DEMOMOTION_BROWSER_CHANNEL=chrome to drive the locally installed Google Chrome instead.`;
    throw new Error(`${hint}\n\nOriginal launch error: ${detail}`, { cause: error });
  }
}

export async function startSession(opts: {
  width: number;
  height: number;
  headless: boolean;
  fps?: number;
  deviceScaleFactor?: number;
}) {
  const id = crypto.randomUUID();
  const dir = path.resolve("data/sessions", id);
  await fs.mkdir(dir, { recursive: true });

  const mode = captureMode();
  const fps = opts.fps ?? (Number(process.env.DEMOMOTION_FPS) || 30);
  const deviceScaleFactor =
    opts.deviceScaleFactor ?? (Number(process.env.DEMOMOTION_DSF) || 1);

  const browser = await launchBrowser(opts.headless);
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor,
    // Legacy path records a VFR webm; screencast path captures via CDP instead.
    ...(mode === "record-video"
      ? { recordVideo: { dir, size: { width: opts.width, height: opts.height } } }
      : {})
  });
  const page = await context.newPage();

  let capture: ScreencastCapture | undefined;
  if (mode === "screencast") {
    capture = await ScreencastCapture.start({
      page,
      dir,
      fps,
      width: opts.width,
      height: opts.height,
      deviceScaleFactor
    });
  }

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
    capture,
    actions: []
  };
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

function assertAllowedUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  const configured = (process.env.DEMOMOTION_ALLOWED_HOSTS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (configured.length && !configured.includes(url.hostname)) {
    throw new Error(`Host not allowed by DEMOMOTION_ALLOWED_HOSTS: ${url.hostname}`);
  }
  return url.toString();
}

export async function goto(id: string, url: string) {
  const safeUrl = assertAllowedUrl(url);
  const s = getSession(id);
  const atMs = nowSourceMs(s);
  await s.page.goto(safeUrl, { waitUntil: "networkidle" });
  s.actions.push({ id: crypto.randomUUID(), type: "goto", atMs, durationMs: nowSourceMs(s) - atMs, url: safeUrl });
}

export async function click(id: string, selector: string, label?: string) {
  const s = getSession(id);
  // sourceMs = timestamp of the most-recent screencast frame (spec §4). Anchored
  // BEFORE the click so it shares the frames' time base by construction.
  const atMs = nowSourceMs(s);
  const locator = s.page.locator(selector).first();
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

export async function fill(id: string, selector: string, value: string, label?: string) {
  const s = getSession(id);
  const atMs = nowSourceMs(s);
  const locator = s.page.locator(selector).first();
  const box = await locator.boundingBox();
  await locator.fill(value);
  s.actions.push({
    id: crypto.randomUUID(),
    type: "fill",
    atMs,
    durationMs: nowSourceMs(s) - atMs,
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
    actions: s.actions
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
    viewport: { width: s.width, height: s.height }
  };
}

export async function scroll(id: string, deltaY: number, deltaX = 0) {
  const s = getSession(id);
  const atMs = nowSourceMs(s);
  await s.page.mouse.wheel(deltaX, deltaY);
  await s.page.waitForTimeout(150);
  s.actions.push({ id: crypto.randomUUID(), type: "scroll", atMs, durationMs: nowSourceMs(s) - atMs, deltaX, deltaY });
}

export async function keypress(id: string, key: string) {
  const s = getSession(id);
  const atMs = nowSourceMs(s);
  await s.page.keyboard.press(key);
  s.actions.push({ id: crypto.randomUUID(), type: "keypress", atMs, durationMs: nowSourceMs(s) - atMs, key });
}

export async function inspectPage(id: string, limit = 80) {
  const s = getSession(id);
  const elements = await s.page.locator("a,button,input,textarea,select,[role],[data-testid]").evaluateAll((nodes) => {
    const cssEscape = (value: string) => {
      const css = (globalThis as any).CSS;
      return css?.escape ? css.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    };
    return nodes.map((node: Element) => {
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
      return {tag, text, role, selector};
    }).filter((x) => x.text || x.role || ["input","button","a","select","textarea"].includes(x.tag));
  });
  return {
    url: s.page.url(),
    title: await s.page.title(),
    elements: elements.slice(0, Math.max(1, Math.min(limit, 200)))
  };
}
