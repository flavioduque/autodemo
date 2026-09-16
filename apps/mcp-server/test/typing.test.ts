import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startSession, goto, click, fill, stopSession, getSession } from "../src/session-manager.ts";

// ---------------------------------------------------------------------------
// Visible typing.
//
// `browser_fill` used Playwright's `.fill()`, which sets the value in ONE go: on
// screen the field jumps from empty to complete inside a single frame. That jump
// is the single most rushed-looking thing in a form demo, and no amount of extra
// waiting repairs it — the keystrokes never existed.
//
// These tests drive a REAL browser against the local fixture (never the network)
// and are deliberately NOT gated: the defect they pin is a visual one, and a
// suite that only runs it on demand is how it shipped in the first place. They
// need a browser but no ffmpeg, except where noted.
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

/**
 * The delay under test and the value typed with it. 23 characters at 45 ms is
 * 1035 ms of typing — an INDEPENDENT expectation, arithmetic from the feature's
 * own definition, not a number read back from the code that implements it.
 */
const TYPE_DELAY_MS = 45;
const VALUE = "Ada Lovelace Analytical";
const EXPECTED_TYPING_MS = VALUE.length * TYPE_DELAY_MS;

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

/** The REAL `pnpm fixture` server, so the page under test is the one it ships. */
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

async function openSession(t: any) {
  const fixture = await startFixtureServer();
  const session = await startSession({ width: WIDTH, height: HEIGHT, headless: true });
  t.after(async () => {
    await session.context.close().catch(() => {});
    await session.browser.close().catch(() => {});
    fixture.stop();
    await fs.rm(session.dir, { recursive: true, force: true }).catch(() => {});
  });
  return { session, origin: fixture.origin };
}

/**
 * Records the KEY events the field receives, from inside the page.
 *
 * This is the independent oracle for "a human typed it": `.fill()` sets the
 * value and dispatches `input`, but never a single `keydown`. Duration alone
 * could be inflated by anything; a keystroke per character could not.
 */
const INSTALL_KEY_RECORDER = (selector: string) => {
  const el = document.querySelector(selector) as HTMLElement;
  (window as any).__keys = [];
  // One listener for the whole test: installing it per phase would double-count
  // every keystroke and the numbers below would stop meaning what they say.
  el.addEventListener("keydown", (event: Event) => {
    (window as any).__keys.push((event as KeyboardEvent).key);
  });
};
const RESET_KEYS = () => { (window as any).__keys = []; };
const READ_KEYS = () => (window as any).__keys as string[];

/** The printable keystrokes, in order — "Delete", "Backspace" and friends out. */
const characters = (keys: string[]) => keys.filter((key) => key.length === 1).join("");

test("a fill with a type delay is typed key by key, and the timeline records the time it really took",
  { timeout: 120_000 }, async (t) => {
  const { session, origin } = await openSession(t);
  const page = getSession(session.id).page;
  await goto(session.id, `${origin}/`);

  // SEED: open the form and prove the field exists and is empty, so "the value
  // arrived" below is something that had to happen rather than something that
  // was already true.
  await click(session.id, NEW_CLIENT, "New client");
  assert.equal(await page.locator(CRM_FORM).isVisible(), true, "the CRM form never opened");
  assert.equal(await page.locator(NAME_INPUT).inputValue(), "", "the field was not empty to begin with");

  await page.evaluate(INSTALL_KEY_RECORDER, NAME_INPUT);

  // --- CONTROL: no delay, the behaviour that must not regress --------------
  await page.evaluate(RESET_KEYS);
  await fill(session.id, NAME_INPUT, VALUE, "Client name");
  const instantKeys = await page.evaluate(READ_KEYS);
  const instant = session.actions.at(-1)!;
  assert.equal(instant.type, "fill");
  assert.equal(await page.locator(NAME_INPUT).inputValue(), VALUE, "the instant fill did not land the value");
  // Zero keystrokes is the by-construction proof that this path sets the value
  // instead of typing it — host-independent, unlike a wall-clock bound. The
  // timing dimension is covered below by comparing the two fills MEASURED IN
  // THE SAME RUN, so load affects both sides equally. An absolute bound here
  // used to fail inside the full suite while passing in isolation: it measured
  // the machine, not the feature.
  assert.deepEqual(instantKeys, [], "an undelayed fill is supposed to set the value, not type it");

  // --- THE FEATURE: same field, same string, typed -------------------------
  // Same field on purpose: the pre-existing value from the control is exactly
  // what a typing implementation would append to if it forgot to clear first.
  await page.evaluate(RESET_KEYS);
  await fill(session.id, NAME_INPUT, VALUE, "Client name", TYPE_DELAY_MS);
  const typedKeys = await page.evaluate(READ_KEYS);
  const typed = session.actions.at(-1)!;
  assert.equal(typed.type, "fill");

  // The field ends up holding the value ONCE — not the control's value with the
  // typed one appended to it.
  assert.equal(await page.locator(NAME_INPUT).inputValue(), VALUE,
    "the typed value is wrong — a doubled value means the field was not cleared first");

  // It was really typed: the page saw the value arrive one keystroke at a time,
  // in order. (The non-printable key ahead of them is the clear — Playwright
  // empties a non-empty field with a Delete, which is what a person does too.)
  assert.equal(characters(typedKeys), VALUE,
    `the field received ${JSON.stringify(typedKeys)} instead of ${VALUE.length} character keystrokes`);

  // ...and the timeline says so. The compositor derives zoom and caption timing
  // from `durationMs`, so a typed fill that still reports an instant duration
  // would desynchronize everything downstream.
  assert.ok(typed.durationMs > EXPECTED_TYPING_MS * 0.5,
    `the timeline recorded ${typed.durationMs} ms for ${EXPECTED_TYPING_MS} ms of typing`);
  assert.ok(typed.durationMs > instant.durationMs + EXPECTED_TYPING_MS * 0.4,
    `typed (${typed.durationMs} ms) is not meaningfully longer than instant (${instant.durationMs} ms)`);
});

/**
 * The typed path must not leak the value.
 *
 * `browser_fill` promises the value is redacted from `capture.json`; typing it
 * character by character is a NEW way for it to reach the timeline, so the
 * promise is re-checked against the manifest that is actually written to disk.
 *
 * This one runs in the legacy `record-video` capture mode for one reason: it
 * needs a real `session_stop`, and the screencast path assembles the MP4 with
 * ffmpeg, which CI does not install. Nothing about redaction is mode-specific —
 * both modes push the same action through the same line.
 */
test("the typed value reaches the field and still never reaches capture.json",
  { timeout: 120_000 }, async (t) => {
  const SECRET = "Zx9-Hopper-1906";

  const previousMode = process.env.AUTODEMO_CAPTURE;
  process.env.AUTODEMO_CAPTURE = "record-video";
  t.after(() => {
    if (previousMode === undefined) delete process.env.AUTODEMO_CAPTURE;
    else process.env.AUTODEMO_CAPTURE = previousMode;
  });

  const { session, origin } = await openSession(t);
  const page = getSession(session.id).page;
  await goto(session.id, `${origin}/`);
  await click(session.id, NEW_CLIENT, "New client");
  assert.equal(await page.locator(NAME_INPUT).inputValue(), "", "the field was not empty to begin with");

  await fill(session.id, NAME_INPUT, SECRET, "Client name", TYPE_DELAY_MS);

  // SEED FIRST. The value really was typed into the page — read straight from
  // the DOM. Without this, "absent from the manifest" could just mean nothing
  // was ever entered.
  assert.equal(await page.locator(NAME_INPUT).inputValue(), SECRET,
    "the typed value never reached the field, so its absence below would prove nothing");

  const capture = await stopSession(session.id);
  const written = await fs.readFile(capture.manifestPath, "utf8");

  // The action IS in the manifest — the redaction is a redaction, not a
  // disappearance.
  const fills = (JSON.parse(written).actions as Array<any>).filter((a) => a.type === "fill");
  assert.equal(fills.length, 1, `the typed fill did not reach the manifest: ${written}`);
  assert.equal(fills[0].value, "[redacted]", "the typed value survived into the timeline");
  assert.equal(fills[0].selector, NAME_INPUT);
  assert.ok(fills[0].durationMs > 0, "the typed fill was recorded as taking no time at all");

  // ...and nowhere else in the file either.
  assert.equal(written.includes(SECRET), false, "the typed value leaked into capture.json");
});
