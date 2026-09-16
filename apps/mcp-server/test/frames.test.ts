import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  startSession, goto, click, fill, scroll, inspectPage, getSession, collectInteractive
} from "../src/session-manager.ts";

// ---------------------------------------------------------------------------
// Two defects that only a REAL page could show, both reproduced against the
// local fixture — no network, ever.
//
// 1. `browser_inspect` died under `tsx` with `ReferenceError: __name is not
//    defined`. Playwright ships a callback's SOURCE into the browser; esbuild
//    (which tsx transpiles with) had already rewritten the named inner function
//    into a call to its own `__name` helper, and that helper only exists in
//    Node. Compiled `dist/` was fine, so nothing caught it — while the README
//    tells every MCP client to launch the server with `tsx`.
//
//    THIS FILE MUST KEEP RUNNING UNDER tsx. `apps/mcp-server`'s test script is
//    `node --import tsx --test test/*.test.ts`; run it any other way and the
//    first assertion below (the `__name` hazard is present) fails loudly rather
//    than passing vacuously.
//
// 2. Everything was blind to <iframe> content. `page.locator(...)` only ever
//    sees the main frame, so on a site whose whole product sits in a frame the
//    agent saw a cookie banner and nothing else.
//
// Unlike the other browser-driven tests here these are NOT gated behind an env
// var: a suite that stays green while the product's eyes are shut is exactly
// the gap that let (1) ship. They need a browser but no ffmpeg — the capture is
// torn down directly instead of through `stopSession`, which would assemble a
// video. CI installs Chromium; on macOS 13, where the bundled Chromium cannot
// install, the locally installed Google Chrome is driven instead.
// ---------------------------------------------------------------------------

if (process.platform === "darwin" && !process.env.AUTODEMO_BROWSER_CHANNEL) {
  process.env.AUTODEMO_BROWSER_CHANNEL = "chrome";
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = path.resolve(HERE, "../../../fixtures/target-app/server.mjs");

const WIDTH = 1280;
const HEIGHT = 720;
const NEW_CLIENT = '[data-testid="new-client-button"]';
const NAME_INPUT = '[data-testid="client-name-input"]';
const CRM_FORM = '[data-testid="client-form"]';
const COOKIE_BANNER = '[data-testid="host-cookie-banner"]';
const COOKIE_ACCEPT = '[data-testid="host-cookie-accept"]';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** The REAL `pnpm fixture` server, so the /embedded route is the one it ships. */
async function startFixtureServer(): Promise<{ origin: string; stop: () => void }> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [FIXTURE_SERVER], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, FIXTURE_PORT: String(port) }
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(origin);
      if (response.ok) {
        await response.text();
        return { origin, stop: () => { child.stderr?.destroy(); child.kill("SIGKILL"); child.unref(); } };
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill("SIGKILL");
  throw new Error(`fixture server never came up on ${origin}`);
}

/**
 * A session plus its teardown.
 *
 * The browser is closed directly and the session directory removed: going through
 * `stopSession` would assemble the capture with ffmpeg, which these tests have no
 * use for and CI does not install.
 */
async function openSession(t: any, height = HEIGHT) {
  const fixture = await startFixtureServer();
  const session = await startSession({ width: WIDTH, height, headless: true });
  t.after(async () => {
    await session.context.close().catch(() => {});
    await session.browser.close().catch(() => {});
    fixture.stop();
    await fs.rm(session.dir, { recursive: true, force: true }).catch(() => {});
  });
  return { session, origin: fixture.origin };
}

/** The frame the CRM lives in on /embedded. */
function crmFrame(id: string) {
  const frame = getSession(id).page.frames().find((f) => f.url().includes("index.html"));
  assert.ok(frame, "the embedded fixture did not attach a frame for the CRM");
  return frame!;
}

// ---------------------------------------------------------------------------
// BUG 1 — the in-page callback under tsx
// ---------------------------------------------------------------------------

test("browser_inspect's in-page code survives the tsx/esbuild transpile", { timeout: 120_000 }, async (t) => {
  // ASSERTION ZERO. The defect only exists where esbuild's `keepNames` rewrote a
  // named function expression into `__name(...)`. Prove that rewrite really
  // happened in THIS runtime before claiming the fix survives it — otherwise the
  // test would be green on a toolchain that never posed the hazard at all.
  assert.match(
    collectInteractive.toString(),
    /__name\(/,
    "esbuild did not inject its __name helper here — this file must run under tsx " +
    "(node --import tsx), or the assertion below proves nothing"
  );

  const { session, origin } = await openSession(t);
  await goto(session.id, `${origin}/`);

  // The bare CRM: one frame, no iframe. This is the exact call that threw
  // `locator.evaluateAll: ReferenceError: __name is not defined`.
  const inspected = await inspectPage(session.id);

  // The frame was READ, not skipped. This is where the defect lands now that a
  // frame that cannot be read is reported instead of thrown: without the fix the
  // note here is the `ReferenceError: __name is not defined` itself.
  assert.deepEqual(inspected.skippedFrames, [], "the only frame on the page could not be read");

  // The positive half: it does not merely fail to throw, it returns the page.
  assert.equal(inspected.url, `${origin}/`);
  assert.equal(inspected.title, "Acme CRM — Demo Fixture");
  const selectors = inspected.elements.map((e) => e.selector);
  assert.ok(selectors.includes(NEW_CLIENT), `inspect did not find ${NEW_CLIENT}: ${selectors.join(", ")}`);
  assert.ok(selectors.includes(NAME_INPUT), `inspect did not find ${NAME_INPUT}`);

  // The in-page code ran to COMPLETION, not just past the statement that used to
  // throw: every control the fixture documents came back, mapped and filtered.
  for (const expected of [
    NEW_CLIENT, NAME_INPUT, '[data-testid="client-email-input"]', '[data-testid="client-phone-input"]',
    '[data-testid="save-button"]', '[data-testid="cancel-button"]', '[data-testid="corner-tl"]'
  ]) {
    assert.ok(selectors.includes(expected), `inspect did not find ${expected}`);
  }
  assert.ok(inspected.elements.every((e) => e.frameUrl === `${origin}/`),
    "an element came back tagged with a frame the page does not have");
  assert.ok(inspected.elements.some((e) => e.text === "New client"),
    "no element carried its text, so the mapping never finished");
});

// ---------------------------------------------------------------------------
// BUG 2 — iframe content
// ---------------------------------------------------------------------------

test("inspect returns elements from every frame, tagged with the frame they came from",
  { timeout: 120_000 }, async (t) => {
  const { session, origin } = await openSession(t);
  await goto(session.id, `${origin}/embedded`);
  const page = getSession(session.id).page;

  // SEED FIRST. Prove the CRM controls exist on this page at all, straight from
  // the browser, before asserting anything about who can and cannot see them.
  const crm = crmFrame(session.id);
  assert.equal(await crm.locator(NEW_CLIENT).count(), 1, "the CRM is not inside the embedded page");
  assert.ok(await crm.locator("a,button,input,textarea,select,[role],[data-testid]").count() > 10,
    "the embedded CRM has almost nothing in it — the rest of this test would prove little");

  // The pre-fix view, reproduced verbatim: `page.locator` is main-frame only.
  const mainFrameOnly = await page.locator("a,button,input,textarea,select,[role],[data-testid]").all();
  const mainFrameSelectors: string[] = [];
  for (const locator of mainFrameOnly) mainFrameSelectors.push((await locator.getAttribute("data-testid")) ?? "");
  assert.ok(mainFrameSelectors.includes("host-cookie-accept"), "the host banner is not in the main frame");
  assert.equal(mainFrameSelectors.includes("new-client-button"), false,
    "the main-frame-only view already saw into the iframe — the defect cannot be reproduced");

  // ...and the fixed view.
  const inspected = await inspectPage(session.id, 200);
  assert.equal(inspected.frameCount, 2, `expected host + CRM frames, got ${inspected.frameCount}`);
  assert.deepEqual(inspected.skippedFrames, []);

  const byFrame = new Map<string, string[]>();
  for (const element of inspected.elements) {
    if (!byFrame.has(element.frameUrl)) byFrame.set(element.frameUrl, []);
    byFrame.get(element.frameUrl)!.push(element.selector);
  }
  const hostSelectors = byFrame.get(`${origin}/embedded`) ?? [];
  const crmSelectors = byFrame.get(`${origin}/index.html`) ?? [];

  // Both halves: the frame that already worked still works...
  assert.ok(hostSelectors.includes(COOKIE_ACCEPT), `host frame lost its banner: ${hostSelectors.join(", ")}`);
  // ...and the one that was invisible is now visible, correctly attributed.
  assert.ok(crmSelectors.includes(NEW_CLIENT), `the CRM's controls are still invisible: ${crmSelectors.join(", ")}`);
  assert.ok(crmSelectors.includes(NAME_INPUT), "the CRM's form fields are still invisible");
  assert.ok(crmSelectors.length > hostSelectors.length,
    `the product frame reported ${crmSelectors.length} controls against the host's ${hostSelectors.length}`);
  // The tag is a real discriminator, not a constant.
  assert.equal(hostSelectors.includes(NEW_CLIENT), false, "a CRM control was attributed to the host frame");
});

test("click and fill reach into an iframe, and the recorded coordinates stay viewport-normalized",
  { timeout: 120_000 }, async (t) => {
  const { session, origin } = await openSession(t);
  await goto(session.id, `${origin}/embedded`);
  const page = getSession(session.id).page;
  const crm = crmFrame(session.id);

  // SEED: the control is there, and the effect it produces is NOT already true.
  assert.equal(await crm.locator(NEW_CLIENT).count(), 1);
  assert.equal(await crm.locator(CRM_FORM).isVisible(), false, "the CRM form was already open");

  // An INDEPENDENT oracle for the coordinates, read from the browser before the
  // click: the element's rect inside its own frame, plus where that frame sits
  // in the viewport. Nothing here goes through session-manager's arithmetic.
  const rect = await crm.evaluate((selector: string) => {
    const el = document.querySelector(selector) as HTMLElement;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, NEW_CLIENT);
  const frameBox = await page.locator("#app-frame").boundingBox();
  assert.ok(frameBox, "the fixture's iframe has no box");
  assert.ok(frameBox!.x > 0 && frameBox!.y > 0,
    `the iframe sits at ${frameBox!.x},${frameBox!.y} — an origin-aligned frame would make this assertion vacuous`);

  const expectedX = (frameBox!.x + rect.x + rect.width / 2) / WIDTH;
  const expectedY = (frameBox!.y + rect.y + rect.height / 2) / HEIGHT;
  // What the numbers would look like if the frame offset were dropped. The two
  // must be far enough apart that the assertion below can tell them apart.
  const frameRelativeX = (rect.x + rect.width / 2) / WIDTH;
  const frameRelativeY = (rect.y + rect.height / 2) / HEIGHT;
  assert.ok(Math.abs(expectedX - frameRelativeX) > 0.02 && Math.abs(expectedY - frameRelativeY) > 0.02,
    "frame-relative and viewport-relative coordinates are too close to distinguish");

  await click(session.id, NEW_CLIENT, "New client");

  // The EFFECT, read in a separate command from the one that caused it.
  assert.equal(await crm.locator(CRM_FORM).isVisible(), true, "the click never reached the iframe");

  const clicked = session.actions.at(-1)!;
  assert.equal(clicked.type, "click");
  assert.ok(clicked.x !== undefined && clicked.y !== undefined, "the click recorded no coordinates");
  assert.ok(clicked.x! > 0 && clicked.x! < 1 && clicked.y! > 0 && clicked.y! < 1,
    `normalized coordinates escaped 0..1: ${clicked.x}, ${clicked.y}`);
  assert.ok(Math.abs(clicked.x! - expectedX) < 0.002,
    `recorded x ${clicked.x} is not the element's place in the viewport (${expectedX})`);
  assert.ok(Math.abs(clicked.y! - expectedY) < 0.002,
    `recorded y ${clicked.y} is not the element's place in the viewport (${expectedY})`);

  // fill, one frame deep, and the typed value really landed in the input.
  await fill(session.id, NAME_INPUT, "Ada Lovelace", "Client name");
  assert.equal(await crm.locator(NAME_INPUT).inputValue(), "Ada Lovelace");
  const filled = session.actions.at(-1)!;
  assert.equal(filled.value, "[redacted]", "the typed value survived into the timeline");
  assert.ok(filled.x! > 0 && filled.x! < 1 && filled.y! > 0 && filled.y! < 1);

  // The other half: a control in the HOST frame is still reachable, and still
  // resolves there rather than being shadowed by the frame scan.
  assert.equal(await page.locator(COOKIE_BANNER).count(), 1);
  await click(session.id, COOKIE_ACCEPT, "Accept cookies");
  assert.equal(await page.locator(COOKIE_BANNER).count(), 0, "the host-frame click did nothing");
});

/**
 * This one was NEVER RED: before the fix nothing looked past the main frame, so
 * "resolves in the main frame" was true by construction. It is here to pin the
 * documented rule — first match wins, main frame first — against a future change
 * that lets a frame win an ambiguous selector.
 */
test("an ambiguous selector resolves in the main frame first", { timeout: 120_000 }, async (t) => {
  const { session, origin } = await openSession(t);
  await goto(session.id, `${origin}/embedded`);
  const page = getSession(session.id).page;
  const crm = crmFrame(session.id);

  // SEED: `button` matches in BOTH frames, so the rule has something to decide.
  assert.ok(await page.locator("button").count() >= 2, "the host frame has no buttons");
  assert.ok(await crm.locator("button").count() >= 2, "the CRM frame has no buttons");
  assert.equal(await crm.locator(CRM_FORM).isVisible(), false);

  await click(session.id, "button", "First button");

  // The documented rule: main frame first, then `.first()` within it — the host
  // banner's Decline button, which removes the banner...
  assert.equal(await page.locator(COOKIE_BANNER).count(), 0,
    "the ambiguous selector did not resolve in the main frame");
  // ...and NOT the CRM's first button, which would have opened the form.
  assert.equal(await crm.locator(CRM_FORM).isVisible(), false,
    "the ambiguous selector reached into the iframe instead of the main frame");
});

test("scrolling reaches the frame that can actually scroll", { timeout: 120_000 }, async (t) => {
  const { session, origin } = await openSession(t);
  await goto(session.id, `${origin}/embedded`);
  const page = getSession(session.id).page;
  const crm = crmFrame(session.id);

  const metrics = "(() => { const e = document.scrollingElement || document.documentElement;" +
    " return { top: e.scrollTop, scrollHeight: e.scrollHeight, clientHeight: e.clientHeight }; })()";

  // SEED / CONTROL: the host document has nothing to scroll and the CRM does, so
  // a wheel that stays in the host frame is provably a no-op.
  const hostBefore = await page.mainFrame().evaluate<{ top: number; scrollHeight: number; clientHeight: number }>(metrics);
  const crmBefore = await crm.evaluate<{ top: number; scrollHeight: number; clientHeight: number }>(metrics);
  assert.ok(hostBefore.scrollHeight <= hostBefore.clientHeight + 1,
    `the host document can scroll (${hostBefore.scrollHeight} > ${hostBefore.clientHeight}) — the test would prove nothing`);
  assert.ok(crmBefore.scrollHeight > crmBefore.clientHeight + 1,
    `the embedded CRM cannot scroll (${crmBefore.scrollHeight} <= ${crmBefore.clientHeight})`);
  assert.equal(crmBefore.top, 0);

  await scroll(session.id, 500);

  const crmAfter = await crm.evaluate<{ top: number }>(metrics);
  assert.ok(crmAfter.top > 0, "the wheel never reached the frame holding the content");
});

test("scrolling a page with no iframe still scrolls the page itself", { timeout: 120_000 }, async (t) => {
  // Short viewport on purpose: the bare CRM fits inside 720px and would have
  // nothing to scroll, which would make the assertion below vacuous.
  const { session, origin } = await openSession(t, 480);
  await goto(session.id, `${origin}/`);
  const page = getSession(session.id).page;
  const metrics = "(() => { const e = document.scrollingElement || document.documentElement;" +
    " return { top: e.scrollTop, scrollHeight: e.scrollHeight, clientHeight: e.clientHeight }; })()";

  const before = await page.mainFrame().evaluate<{ top: number; scrollHeight: number; clientHeight: number }>(metrics);
  assert.ok(before.scrollHeight > before.clientHeight + 1, "the bare fixture cannot scroll");
  assert.equal(before.top, 0);

  await scroll(session.id, 500);

  const after = await page.mainFrame().evaluate<{ top: number }>(metrics);
  assert.ok(after.top > 0, "the main document stopped scrolling");
});
