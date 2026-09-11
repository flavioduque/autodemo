import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { preflight } from "../src/preflight.ts";
import { sessionsRoot, startSession, stopSession } from "../src/session-manager.ts";

// ---------------------------------------------------------------------------
// Where sessions land, and what the operator is told at startup.
// ---------------------------------------------------------------------------

test("sessions land under DEMOMOTION_HOME when it is set, and under ~/.demomotion otherwise", () => {
  assert.equal(sessionsRoot({ DEMOMOTION_HOME: "/srv/demo" }), path.resolve("/srv/demo/sessions"));
  assert.equal(sessionsRoot({ DEMOMOTION_HOME: "  " }), path.join(os.homedir(), ".demomotion", "sessions"));
  assert.equal(sessionsRoot({}), path.join(os.homedir(), ".demomotion", "sessions"));
  // Relative homes are anchored on the cwd, so the reported path is absolute.
  assert.ok(path.isAbsolute(sessionsRoot({ DEMOMOTION_HOME: "rel" })));
});

test("preflight names both browser fixes when the bundled Chromium is missing and no channel is set", async () => {
  const report = await preflight({ env: { PATH: process.env.PATH }, bundledExecutable: "/definitely/not/here" });
  const browser = report.warnings.find((w) => /Chromium/.test(w));
  assert.ok(browser, `no browser warning in ${JSON.stringify(report.warnings)}`);
  assert.match(browser, /npx playwright@1\.63\.0 install chromium/);
  assert.match(browser, /DEMOMOTION_BROWSER_CHANNEL=chrome/);
  // ONE line: an MCP client's log viewer shows stderr line by line.
  assert.equal(browser.includes("\n"), false);
});

test("preflight is silent about the browser when the bundled Chromium exists", async () => {
  // process.execPath exists on every host; it stands in for the browser binary.
  const report = await preflight({ env: { PATH: process.env.PATH }, bundledExecutable: process.execPath });
  assert.equal(report.warnings.filter((w) => /Chromium|browser/i.test(w)).length, 0, JSON.stringify(report.warnings));
});

test("preflight checks the channel binary when DEMOMOTION_BROWSER_CHANNEL is set", async () => {
  // A channel nobody has: the warning names it and the two fixes.
  const missing = await preflight({
    env: { PATH: process.env.PATH, DEMOMOTION_BROWSER_CHANNEL: "chrome" },
    bundledExecutable: "/definitely/not/here",
    channelCandidates: () => ["/definitely/not/here/Chrome"]
  });
  const warning = missing.warnings.find((w) => /channel "chrome"/.test(w));
  assert.ok(warning, JSON.stringify(missing.warnings));
  assert.match(warning, /npx playwright@1\.63\.0 install chromium/);
  // ...and the positive half: a channel that resolves produces no warning even
  // with the bundled build absent, because the channel is what will be used.
  const present = await preflight({
    env: { PATH: process.env.PATH, DEMOMOTION_BROWSER_CHANNEL: "chrome" },
    bundledExecutable: "/definitely/not/here",
    channelCandidates: () => [process.execPath]
  });
  assert.equal(present.warnings.filter((w) => /Chromium|channel/i.test(w)).length, 0, JSON.stringify(present.warnings));
});

test("preflight warns about ffmpeg only when it is really absent from PATH", async () => {
  const without = await preflight({ env: { PATH: "/definitely/not/here" }, bundledExecutable: process.execPath });
  const warning = without.warnings.find((w) => /ffmpeg/.test(w));
  assert.ok(warning, JSON.stringify(without.warnings));
  assert.match(warning, /session_stop/);
  assert.equal(warning.includes("\n"), false);

  // The control: this machine has ffmpeg (the render suite depends on it), so
  // the same check with the real PATH must stay quiet.
  const withFfmpeg = await preflight({ env: { PATH: process.env.PATH }, bundledExecutable: process.execPath });
  assert.equal(withFfmpeg.warnings.filter((w) => /ffmpeg/.test(w)).length, 0, JSON.stringify(withFfmpeg.warnings));
});

// ---------------------------------------------------------------------------
// ffmpeg missing at session_stop: a clear refusal, not `spawn ffmpeg ENOENT`
// from the bottom of a stack. Drives a real browser, so it takes a few seconds.
// ---------------------------------------------------------------------------

if (process.platform === "darwin" && !process.env.DEMOMOTION_BROWSER_CHANNEL) {
  process.env.DEMOMOTION_BROWSER_CHANNEL = "chrome";
}

test("session_stop fails by name when ffmpeg is not on PATH", { timeout: 60_000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "demomotion-noffmpeg-"));
  const previous = { HOME: process.env.DEMOMOTION_HOME, PATH: process.env.PATH };
  process.env.DEMOMOTION_HOME = home;
  const session = await startSession({ width: 640, height: 400, headless: true });
  try {
    assert.ok(session.dir.startsWith(await fs.realpath(home)) || session.dir.startsWith(home),
      `session did not land under DEMOMOTION_HOME: ${session.dir}`);
    // Paint something so the screencast produces frames: the failure must be the encoder's.
    await session.page.setContent("<h1 style=\"font-size:80px\">frames</h1>");
    await new Promise((r) => setTimeout(r, 700));
    process.env.PATH = "/definitely/not/here";
    await assert.rejects(stopSession(session.id), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /ffmpeg is not installed or not on PATH/);
      assert.match(message, /brew install ffmpeg|apt-get install ffmpeg/);
      return true;
    });
  } finally {
    process.env.PATH = previous.PATH;
    if (previous.HOME === undefined) delete process.env.DEMOMOTION_HOME; else process.env.DEMOMOTION_HOME = previous.HOME;
    await session.browser.close().catch(() => {});
    await fs.rm(home, { recursive: true, force: true });
  }
});
