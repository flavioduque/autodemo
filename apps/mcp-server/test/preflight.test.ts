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

test("preflight checks the binary when DEMOMOTION_BROWSER_EXECUTABLE is set, and it wins over the channel", async () => {
  // The path is what will be launched: a missing one is named, with the fixes.
  const missing = await preflight({
    env: { PATH: process.env.PATH, DEMOMOTION_BROWSER_EXECUTABLE: "/definitely/not/here/chrome-headless-shell", DEMOMOTION_BROWSER_CHANNEL: "chrome" },
    bundledExecutable: process.execPath,
    channelCandidates: () => [process.execPath]
  });
  assert.equal(missing.browser, "missing");
  const warning = missing.warnings.find((w) => /DEMOMOTION_BROWSER_EXECUTABLE/.test(w));
  assert.ok(warning, JSON.stringify(missing.warnings));
  assert.match(warning, /^no usable capture browser: /);
  assert.match(warning, /\/definitely\/not\/here\/chrome-headless-shell/);
  assert.match(warning, /npx playwright@1\.63\.0 install chromium/);
  assert.equal(warning.includes("\n"), false);
  // ...and the positive half: a binary that exists is silent, with neither the
  // bundled build nor the channel present — it is the one thing that will run.
  const present = await preflight({
    env: { PATH: process.env.PATH, DEMOMOTION_BROWSER_EXECUTABLE: process.execPath, DEMOMOTION_BROWSER_CHANNEL: "chrome" },
    bundledExecutable: "/definitely/not/here",
    channelCandidates: () => ["/definitely/not/here/Chrome"]
  });
  assert.equal(present.browser, "executable");
  assert.equal(present.warnings.filter((w) => /Chromium|channel|browser/i.test(w)).length, 0, JSON.stringify(present.warnings));
});

test("a channel Playwright ships only on OTHER platforms is reported missing, by name", async () => {
  // pack.test.ts asks for "msedge-canary" as a channel that cannot exist. On
  // macOS and Windows the table knows where it would live, finds nothing and
  // warns. On Linux there is no Edge Canary AT ALL — Playwright has no such
  // build there — so the table has no entry, and CI run 34604186469 got
  // "unverified" and silence instead of the warning. A channel the table knows
  // on another platform but not on this one is missing here, not unknown.
  const elsewhere = await preflight({
    env: { PATH: process.env.PATH, DEMOMOTION_BROWSER_CHANNEL: "msedge-canary" },
    bundledExecutable: "/definitely/not/here",
    channelCandidates: (_channel, platform) => platform === process.platform ? [] : ["/elsewhere/Microsoft Edge Canary"]
  });
  assert.equal(elsewhere.browser, "missing");
  const warning = elsewhere.warnings.find((w) => /channel "msedge-canary"/.test(w));
  assert.ok(warning, JSON.stringify(elsewhere.warnings));
  assert.match(warning, /^no usable capture browser: /);
  assert.match(warning, new RegExp(`not available on ${process.platform}`));
  assert.match(warning, /npx playwright@1\.63\.0 install chromium/);
  assert.match(warning, /DEMOMOTION_BROWSER_CHANNEL=chrome/);
  assert.equal(warning.includes("\n"), false);
  // ...and the other half stands: a channel NO platform's table knows is still
  // "unverified" and silent — preflight is a warning, not a second registry.
  const unknown = await preflight({
    env: { PATH: process.env.PATH, DEMOMOTION_BROWSER_CHANNEL: "my-fork" },
    bundledExecutable: "/definitely/not/here",
    channelCandidates: () => []
  });
  assert.equal(unknown.browser, "unverified");
  assert.equal(unknown.warnings.filter((w) => /Chromium|channel|browser/i.test(w)).length, 0, JSON.stringify(unknown.warnings));
});

test("preflight warns about ffmpeg only when it is really absent from PATH", async () => {
  const without = await preflight({ env: { PATH: "/definitely/not/here" }, bundledExecutable: process.execPath });
  const warning = without.warnings.find((w) => /ffmpeg/.test(w));
  assert.ok(warning, JSON.stringify(without.warnings));
  assert.match(warning, /session_stop/);
  assert.equal(warning.includes("\n"), false);

  // The control: a PATH that carries an ffmpeg AND an ffprobe by construction,
  // not the host's — the `validate` runner has no ffmpeg (ci.yml installs it
  // for the render job only), and a control that read the real PATH there
  // would fail for the wrong reason. Preflight looks for the names on PATH, so
  // two executable files are all a PATH needs to have ffmpeg on it.
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), "demomotion-fakeffmpeg-"));
  try {
    for (const name of ["ffmpeg", "ffprobe"]) {
      await fs.writeFile(path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      if (process.platform === "win32") await fs.writeFile(path.join(bin, `${name}.exe`), "");
    }
    const withFfmpeg = await preflight({ env: { PATH: bin }, bundledExecutable: process.execPath });
    assert.equal(withFfmpeg.ffmpeg, true);
    assert.equal(withFfmpeg.ffprobe, true);
    assert.equal(withFfmpeg.warnings.filter((w) => /ffmpeg/.test(w)).length, 0, JSON.stringify(withFfmpeg.warnings));
    // ...and one of the two alone is still a warning, naming the one that is missing.
    await fs.rm(path.join(bin, "ffprobe"), { force: true });
    await fs.rm(path.join(bin, "ffprobe.exe"), { force: true });
    const halfway = await preflight({ env: { PATH: bin }, bundledExecutable: process.execPath });
    const halfWarning = halfway.warnings.find((w) => /ffprobe/.test(w));
    assert.ok(halfWarning, JSON.stringify(halfway.warnings));
    assert.match(halfWarning, /^ffprobe not found on PATH/);
  } finally {
    await fs.rm(bin, { recursive: true, force: true });
  }
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
    // Seed first: prove the screencast is LIVE before stopping. Under load a
    // fixed sleep can elapse with zero frames, and then the "no frames" path
    // would pre-empt the assertion below — making it fail for the wrong reason.
    for (let i = 0; i < 100 && (session.capture?.frameCount ?? 0) === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok((session.capture?.frameCount ?? 0) > 0,
      "seed: the screencast produced no frame in 10 s — the ffmpeg assertion below would be vacuous");
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
