import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpStdioClient, step } from "./mcp-stdio-client.ts";

// ---------------------------------------------------------------------------
// The ONLY test that talks to DemoMotion the way a real MCP client does.
//
// Everything else in this repo calls TypeScript functions. That leaves the wire
// itself — JSON-RPC framing, the zod -> JSON Schema conversion published by
// tools/list, argument validation, the `isError` result shape — completely
// unexercised, and the wire is exactly where a real client breaks first. So
// this file imports NOTHING from src/: it spawns the server as a child process
// and speaks stdio JSON-RPC to it.
//
// It is slow (two real Chrome captures and two real renders) and needs Chrome
// plus ffmpeg/ffprobe on PATH, so it is gated:
//
//   DEMOMOTION_E2E_TESTS=1 DEMOMOTION_BROWSER_CHANNEL=chrome \
//     pnpm --filter demomotion test
//
// Progress markers go to stderr as the calls happen; DEMOMOTION_E2E_DEBUG=1 also
// forwards the spawned server's own stderr.
// ---------------------------------------------------------------------------

const E2E = process.env.DEMOMOTION_E2E_TESTS === "1";
const skip = E2E ? false : "set DEMOMOTION_E2E_TESTS=1 to run the MCP protocol end-to-end test";
const TIMEOUT = 1_500_000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const SERVER_ENTRY = path.resolve(HERE, "../src/cli.ts");
const FIXTURE_SERVER = path.join(REPO, "fixtures/target-app/server.mjs");
const SHOWCASE_SERVER = path.join(REPO, "fixtures/showcase-app/server.mjs");
const REPO_SESSIONS = path.join(REPO, "data/sessions");

// The bundled Chromium cannot install on macOS 13; drive the installed Chrome.
if (process.platform === "darwin" && !process.env.DEMOMOTION_BROWSER_CHANNEL) {
  process.env.DEMOMOTION_BROWSER_CHANNEL = "chrome";
}

const run = promisify(execFile);
const require = createRequire(import.meta.url);
/** The server entry is TypeScript; the child needs the same loader we run under. */
const TSX_LOADER = pathToFileURL(require.resolve("tsx")).href;

/** Every tool the server is expected to publish. A tool that vanishes from the
 *  wire is invisible to a client no matter how well its function is tested. */
const EXPECTED_TOOLS = [
  "session_start", "browser_inspect", "browser_scroll", "browser_keypress",
  "browser_goto", "browser_click", "browser_fill", "browser_wait",
  "browser_screenshot", "session_status", "session_stop",
  "project_build", "project_update", "demo_finalize", "render_video", "demo_create"
];

/**
 * Every tool this file actually CALLED over the wire, filled in by `callTool`.
 *
 * Publishing a tool in tools/list and never invoking it is not coverage: four of
 * the fifteen above were listed and never called, and `browser_inspect` — one of
 * the four — was broken in exactly the runtime this test spawns. The last test
 * in the file turns that gap into a failing assertion.
 */
const INVOKED = new Set<string>();

const RENDER_CALL_TIMEOUT_MS = 900_000;

/**
 * Spawns the server the way the README used to tell MCP clients to: the TypeScript
 * entry under tsx. Sessions are pinned to the test's own cwd with DEMOMOTION_HOME
 * so every path the server reports can be checked to stay inside it.
 */
function startServer(cwd: string): Promise<McpStdioClient> {
  return McpStdioClient.start({
    command: process.execPath,
    args: ["--import", TSX_LOADER, SERVER_ENTRY],
    cwd,
    env: { ...process.env, DEMOMOTION_HOME: cwd },
    clientName: "demomotion-e2e",
    onToolCall: (name) => INVOKED.add(name)
  });
}

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

/** Runs the real `pnpm fixture` server (fixtures/target-app/server.mjs). */
function startFixtureServer() {
  return startStaticServer(FIXTURE_SERVER, "FIXTURE_PORT");
}

/** Runs the real `pnpm showcase` server (fixtures/showcase-app/server.mjs): the signup flow demo_create is proven on. */
function startShowcaseServer() {
  return startStaticServer(SHOWCASE_SERVER, "SHOWCASE_PORT");
}

async function startStaticServer(script: string, portVariable: string): Promise<{ origin: string; stop: () => void }> {
  const port = await freePort();
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, [portVariable]: String(port) }
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(origin);
      if (response.ok) {
        await response.text();
        return {
          origin,
          stop: () => { child.stderr?.destroy(); child.kill("SIGKILL"); child.unref(); }
        };
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`fixture server never came up on ${origin}`);
}

/** Container duration in seconds, straight from ffprobe. */
async function mp4Duration(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file
  ]);
  return Number(String(stdout).trim());
}

/** Frame size in pixels, straight from ffprobe. */
async function mp4Size(file: string): Promise<{ width: number; height: number }> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file
  ]);
  const [width, height] = String(stdout).trim().split("x").map(Number);
  return { width, height };
}

/**
 * The browser processes a server has spawned: every descendant of `serverPid`
 * whose command line is a Chrome/Chromium binary. Read from `ps`, not from the
 * server — the claim under test is that the process is GONE, and only the OS
 * can say that.
 */
async function browserProcessesOf(serverPid: number): Promise<string[]> {
  const { stdout } = await run("ps", ["-Ao", "pid=,ppid=,command="]);
  const rows = String(stdout).split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [pid, ppid, ...command] = line.split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), command: command.join(" ") };
  });
  const descendants = new Set<number>([serverPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); grew = true; }
    }
  }
  return rows.filter((row) => row.pid !== serverPid && descendants.has(row.pid) && /chrom(e|ium)/i.test(row.command)).map((row) => `${row.pid} ${row.command.slice(0, 80)}`);
}

/** Names of the session directories the repo has right now. */
async function repoSessionDirs(): Promise<string[]> {
  return (await fs.readdir(REPO_SESSIONS).catch(() => [] as string[])).sort();
}

const WIDTH = 1280;
const HEIGHT = 720;
/** Passed to browser_screenshot; it also becomes that action's label. */
const SCREENSHOT_NAME = "e2e-step.png";

test("a real MCP client drives capture, build, edit and render end to end over stdio",
  { skip, timeout: TIMEOUT }, async () => {
  const sessionsBefore = await repoSessionDirs();
  // realpath, not the raw mkdtemp result: on macOS os.tmpdir() is /var/... while
  // the child's path.resolve() answers /private/var/..., and the "did it stay
  // inside the temp cwd" assertions below compare the two.
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "demomotion-e2e-")));
  const fixture = await startFixtureServer();
  const client = await startServer(cwd);
  try {
    // --- tools/list: the published surface -------------------------------
    const listed = await client.request("tools/list", {});
    const names = (listed.tools as Array<{ name: string }>).map((t) => t.name);
    for (const expected of EXPECTED_TOOLS) {
      assert.ok(names.includes(expected), `tools/list does not publish ${expected}: ${names.join(", ")}`);
    }
    // The JSON Schema really crossed the wire, with its required fields intact.
    const update = (listed.tools as Array<any>).find((t) => t.name === "project_update");
    assert.deepEqual(update.inputSchema.required, ["projectPath"]);
    assert.equal(update.inputSchema.properties.editList.type, "array");
    assert.equal(update.inputSchema.properties.captions.items.properties.words.type, "array");

    // --- capture ---------------------------------------------------------
    const started = await client.callOk("session_start", { width: WIDTH, height: HEIGHT, headless: true });
    const sessionId = started.sessionId;
    assert.equal(typeof sessionId, "string");
    assert.ok(sessionId.length > 0, "session_start returned an empty sessionId");

    const navigated = await client.callOk("browser_goto", { sessionId, url: `${fixture.origin}/` });
    assert.deepEqual(navigated, { ok: true, url: `${fixture.origin}/` });

    // --- browser_inspect, over the wire ----------------------------------
    // The agent's first move on a real page, and the tool that was dead under
    // `tsx` — which is how this server is spawned three lines above. Calling it
    // in-process would have proved nothing about that; the child is the product.
    const inspected = await client.callOk("browser_inspect", { sessionId, limit: 200 });
    assert.equal(inspected.url, `${fixture.origin}/`);
    assert.deepEqual(inspected.skippedFrames, [], "a frame could not be read");
    const inspectedSelectors = (inspected.elements as Array<any>).map((e) => e.selector);
    for (const selector of ['[data-testid="new-client-button"]', '[data-testid="client-name-input"]',
      '[data-testid="save-button"]']) {
      assert.ok(inspectedSelectors.includes(selector), `browser_inspect missed ${selector}`);
    }
    // Every element says which frame it came from; this page has exactly one.
    assert.equal(inspected.frameCount, 1);
    for (const element of inspected.elements as Array<any>) {
      assert.equal(element.frameUrl, `${fixture.origin}/`, "an element came back with no frame attribution");
    }

    // Labels matter: project_build seeds the caption skeleton from them, so the
    // exact strings below are asserted again further down, on the built project.
    const labels = ["New client", "Client name", "Client e-mail", "Client phone", "Save client"];
    await client.callOk("browser_click", { sessionId, selector: '[data-testid="new-client-button"]', label: labels[0] });
    await client.callOk("browser_wait", { sessionId, ms: 500 });
    await client.callOk("browser_fill", { sessionId, selector: '[data-testid="client-name-input"]', value: "Ada Lovelace", label: labels[1] });
    await client.callOk("browser_wait", { sessionId, ms: 500 });
    await client.callOk("browser_fill", { sessionId, selector: '[data-testid="client-email-input"]', value: "ada@example.com", label: labels[2] });
    await client.callOk("browser_wait", { sessionId, ms: 500 });
    await client.callOk("browser_fill", { sessionId, selector: '[data-testid="client-phone-input"]', value: "+55 11 90000-0000", label: labels[3] });
    await client.callOk("browser_wait", { sessionId, ms: 500 });
    await client.callOk("browser_click", { sessionId, selector: '[data-testid="save-button"]', label: labels[4] });
    await client.callOk("browser_wait", { sessionId, ms: 900 });

    // --- browser_scroll / browser_keypress / browser_screenshot ----------
    // The remaining three tools that tools/list published and nothing ever
    // called. Each one has to answer over the wire AND leave its action behind.
    assert.deepEqual(await client.callOk("browser_scroll", { sessionId, deltaY: 400 }), { ok: true });
    assert.deepEqual(await client.callOk("browser_keypress", { sessionId, key: "Escape" }), { ok: true });
    const shot = await client.callOk("browser_screenshot", { sessionId, name: SCREENSHOT_NAME });
    assert.ok(String(shot.path).startsWith(cwd), `the screenshot escaped the test cwd: ${shot.path}`);
    assert.ok((await fs.stat(shot.path)).size > 1000, `browser_screenshot wrote only ${(await fs.stat(shot.path)).size} bytes`);

    const live = await client.callOk("session_status", { sessionId });
    // 1 goto + 2 clicks + 3 fills + 5 waits + 1 scroll + 1 keypress + 1 screenshot.
    // browser_inspect is a read: it deliberately records nothing.
    assert.equal(live.actions, 14, `session_status counted ${live.actions} actions, expected the 14 that were sent`);
    assert.deepEqual(live.viewport, { width: WIDTH, height: HEIGHT });

    const capture = await client.callOk("session_stop", { sessionId });
    assert.equal(capture.width, WIDTH);
    assert.equal(capture.height, HEIGHT);
    assert.ok(capture.durationMs > 2500, `capture is only ${capture.durationMs} ms long`);
    assert.ok(String(capture.manifestPath).startsWith(cwd), `capture escaped the test cwd: ${capture.manifestPath}`);
    // The typed values must never reach the manifest.
    const types = (capture.actions as Array<any>).map((a) => a.type);
    for (const type of ["scroll", "keypress", "screenshot"]) {
      assert.ok(types.includes(type), `no ${type} action reached the manifest: ${types.join(", ")}`);
    }
    const filled = (capture.actions as Array<any>).filter((a) => a.type === "fill");
    assert.equal(filled.length, 3);
    for (const action of filled) assert.equal(action.value, "[redacted]", "a typed value survived into the manifest");
    assert.equal(JSON.stringify(capture).includes("ada@example.com"), false, "the e-mail leaked into the capture manifest");

    // --- project_build ---------------------------------------------------
    const built = await client.callOk("project_build", { captureManifestPath: capture.manifestPath, title: "E2E demo" });
    const projectPath = built.projectPath as string;
    const project = built.project;
    assert.equal(project.title, "E2E demo");
    assert.equal(project.version, 1);
    assert.equal(project.width, WIDTH);
    // The identity edit: one segment covering the whole capture, at speed 1.
    assert.deepEqual(project.editList, [{ sourceFromMs: 0, sourceToMs: capture.durationMs, speed: 1 }]);
    // The caption skeleton is seeded from the labels, in order, already timed.
    // `browser_screenshot` stamps its file name as the action's label, so it
    // seeds a line too — current behaviour, asserted rather than assumed.
    assert.deepEqual((project.captions as Array<any>).map((c) => c.text), [...labels, SCREENSHOT_NAME]);
    for (const caption of project.captions as Array<any>) {
      assert.ok(caption.words.length > 0, `caption "${caption.text}" got no words`);
      assert.equal(caption.words[0].fromMs, caption.fromMs, "the first word does not start with its caption");
      assert.equal(caption.words.at(-1).toMs, caption.toMs, "the last word does not end with its caption");
    }
    assert.ok((project.zooms as Array<any>).length > 0, "no automatic zoom was generated from the interactions");
    for (const zoom of project.zooms as Array<any>) {
      assert.ok(zoom.scale >= 1 && zoom.scale <= 3, `zoom scale ${zoom.scale} is out of range`);
      assert.ok(zoom.toMs > zoom.fromMs && zoom.toMs <= capture.durationMs, "zoom window escapes the capture");
    }

    // --- project_update: a real edit + rewritten narration ----------------
    const duration = capture.durationMs as number;
    const cutFrom = Math.round(duration * 0.40);
    const cutTo = Math.round(duration * 0.50); // this 10% slice is thrown away
    const editList = [
      { sourceFromMs: 0, sourceToMs: cutFrom, speed: 1 },
      { sourceFromMs: cutTo, sourceToMs: duration, speed: 2 }
    ];
    // Captions live entirely inside the FIRST segment: a caption straddling the
    // cut would lose the words after it. This is the rule the skill states.
    const captions = [
      { fromMs: 200, toMs: Math.round(cutFrom * 0.5), text: "Adding a client takes one form.", words: [] },
      { fromMs: Math.round(cutFrom * 0.5), toMs: cutFrom - 50, text: "Name, e-mail, phone.", words: [] }
    ];
    const before = await fs.readFile(projectPath, "utf8");
    const updated = await client.callOk("project_update", {
      projectPath,
      editList,
      captions,
      style: { cutTransitionMs: 180, openingFadeMs: 0, endingFadeMs: 0 }
    });
    assert.deepEqual(updated.editList, editList, "the edit list did not survive the round trip");
    assert.deepEqual((updated.captions as Array<any>).map((c) => c.text), captions.map((c) => c.text));
    assert.equal(updated.style.cutTransitionMs, 180);
    assert.equal(updated.style.openingFadeMs, 0);
    // A patch is a patch: untouched fields keep their built values.
    assert.equal(updated.title, "E2E demo");
    assert.equal(updated.style.background, project.style.background);
    assert.deepEqual(updated.zooms, project.zooms);
    // Read the EFFECT in a separate command from the one that wrote it: the file
    // the renderer will open really changed, not just the reply.
    const onDisk = JSON.parse(await fs.readFile(projectPath, "utf8"));
    assert.deepEqual(onDisk.editList, editList, "project.json on disk does not carry the new edit list");
    assert.deepEqual(onDisk.captions.map((c: any) => c.text), captions.map((c) => c.text));

    // --- the negative half, over the same wire ---------------------------
    // An out-of-range zoom is refused by OUR schema, named field and named
    // bound — not by a crash somewhere downstream.
    const afterGoodUpdate = await fs.readFile(projectPath, "utf8");
    const rejected = await client.callTool("project_update", {
      projectPath,
      zooms: [{ fromMs: 0, toMs: 1000, x: 0.5, y: 0.5, scale: 4 }]
    });
    assert.equal(rejected.isError, true, `an out-of-range zoom scale was ACCEPTED: ${rejected.text}`);
    assert.match(rejected.text, /Input validation error/);
    assert.match(rejected.text, /zooms\.0\.scale/);
    assert.match(rejected.text, /<=\s*3/);
    // The refusal is also inert: a rejected call writes nothing.
    assert.equal(await fs.readFile(projectPath, "utf8"), afterGoodUpdate,
      "a rejected project_update still modified project.json");
    // And the control: the accepted update above DID change the file, so
    // "unchanged" is a real observation and not an inert comparison.
    assert.notEqual(afterGoodUpdate, before, "the accepted update changed nothing — the check above proves nothing");

    // --- render ----------------------------------------------------------
    const outputPath = path.join(cwd, "e2e.mp4");
    const rendered = await client.callOk("render_video", { projectPath, outputPath }, RENDER_CALL_TIMEOUT_MS);
    assert.equal(rendered.outputPath, outputPath);
    const stat = await fs.stat(outputPath);
    assert.ok(stat.size > 50_000, `rendered file is only ${stat.size} bytes`);

    // Expected output length, computed by hand from the spec's own formula
    // (a segment lasts (sourceTo - sourceFrom) / speed), not by calling the
    // code that produced the video.
    const expectedSec = (cutFrom + (duration - cutTo) / 2) / 1000;
    const actualSec = await mp4Duration(outputPath);
    assert.ok(Math.abs(actualSec - expectedSec) < 0.4,
      `rendered ${actualSec.toFixed(2)}s, expected about ${expectedSec.toFixed(2)}s from the edit list`);
    // ...and the edit really removed time: the render is well short of the capture.
    assert.ok(actualSec < (duration / 1000) * 0.85,
      `the render (${actualSec.toFixed(2)}s) is not shorter than the capture (${(duration / 1000).toFixed(2)}s)`);
    assert.deepEqual(await mp4Size(outputPath), { width: WIDTH, height: HEIGHT });
  } finally {
    client.close();
    fixture.stop();
    await fs.rm(cwd, { recursive: true, force: true });
  }

  assert.deepEqual(await repoSessionDirs(), sessionsBefore,
    "the run left session directories behind in the repo's data/");
});

test("demo_finalize takes a live session all the way to an MP4 in one call",
  { skip, timeout: TIMEOUT }, async () => {
  const sessionsBefore = await repoSessionDirs();
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "demomotion-e2e-final-")));
  const fixture = await startFixtureServer();
  const client = await startServer(cwd);
  try {
    const { sessionId } = await client.callOk("session_start", { width: WIDTH, height: HEIGHT, headless: true });
    await client.callOk("browser_goto", { sessionId, url: `${fixture.origin}/` });
    await client.callOk("browser_click", { sessionId, selector: '[data-testid="new-client-button"]', label: "New client" });
    await client.callOk("browser_wait", { sessionId, ms: 800 });
    await client.callOk("browser_fill", { sessionId, selector: '[data-testid="client-name-input"]', value: "Grace Hopper", label: "Client name" });
    await client.callOk("browser_wait", { sessionId, ms: 800 });

    const outputPath = path.join(cwd, "finalize.mp4");
    const finalized = await client.callOk("demo_finalize", { sessionId, title: "Finalize demo", outputPath }, RENDER_CALL_TIMEOUT_MS);

    // Body, not just the absence of an error: every path it claims must exist.
    assert.equal(finalized.outputPath, outputPath);
    assert.ok(finalized.bytes > 50_000, `demo_finalize reported only ${finalized.bytes} bytes`);
    for (const key of ["captureManifestPath", "projectPath", "outputPath"]) {
      const file = finalized[key] as string;
      assert.ok(String(file).startsWith(cwd), `${key} escaped the test cwd: ${file}`);
      await fs.access(file); // throws if demo_finalize lied about it
    }
    assert.equal((await fs.stat(outputPath)).size, finalized.bytes,
      "demo_finalize reported a byte count the file does not have");

    // It really built a project, and that project is the one it rendered.
    const project = JSON.parse(await fs.readFile(finalized.projectPath, "utf8"));
    assert.equal(project.title, "Finalize demo");
    assert.equal(project.editList.length, 1, "demo_finalize should build the identity edit");
    assert.deepEqual(project.captions.map((c: any) => c.text), ["New client", "Client name"]);

    // The finalized session is gone: a second finalize on the same id must fail.
    const twice = await client.callTool("demo_finalize", { sessionId, title: "again" });
    assert.equal(twice.isError, true, "demo_finalize ran twice on a session that was already stopped");
    assert.match(twice.text, new RegExp(`Unknown session: ${sessionId}`));

    const seconds = await mp4Duration(outputPath);
    const expectedSec = project.durationMs / 1000; // identity edit: output == capture
    assert.ok(Math.abs(seconds - expectedSec) < 0.4,
      `demo_finalize rendered ${seconds.toFixed(2)}s for a ${expectedSec.toFixed(2)}s capture`);
    assert.deepEqual(await mp4Size(outputPath), { width: WIDTH, height: HEIGHT });
  } finally {
    client.close();
    fixture.stop();
    await fs.rm(cwd, { recursive: true, force: true });
  }

  assert.deepEqual(await repoSessionDirs(), sessionsBefore,
    "the run left session directories behind in the repo's data/");
});

// ---------------------------------------------------------------------------
// demo_create — one call, one MP4 (issue #6)
// ---------------------------------------------------------------------------

/**
 * The showcase signup flow, as an agent would send it. Labels are narration,
 * not button text: `captions: "auto"` turns each one into a caption line.
 * The SAME array is the control for the mid-way-failure test below, which
 * breaks exactly one selector of it.
 */
const SIGNUP_STEPS = [
  { action: "fill", selector: '[data-testid="signup-name-input"]', value: "Inês Corvelo", label: "Your name opens the workspace" },
  { action: "fill", selector: '[data-testid="signup-email-input"]', value: "ines@studio.com", label: "One e-mail, no verification step" },
  { action: "fill", selector: '[data-testid="signup-password-input"]', value: "Marsh-tide-2024", label: "The meter reacts to every character" },
  { action: "click", selector: '[data-testid="signup-terms-checkbox"]', label: "Agree to the terms" },
  // A beat before submitting, as a person takes. It is also what keeps the
  // previous label's caption alive: two labelled actions on the SAME screencast
  // frame give the first one a zero-length window, and the skeleton drops it
  // (SKILL.md section 5: a line is hard-capped by the next labelled action).
  { action: "wait", ms: 600 },
  { action: "click", selector: '[data-testid="signup-submit"]', label: "The workspace is ready" },
  { action: "wait", ms: 1200 }
];
/** The caller's own waits in the flow above. */
const EXPLICIT_WAIT_MS = 600 + 1200;
const SIGNUP_LABELS = SIGNUP_STEPS.flatMap((s) => (s.label ? [s.label] : []));
/** Characters typed across the three fields. */
const TYPED_CHARS = 12 + 15 + 15;

/** The error body of an `isError` result, decoded. */
function errorPayload(result: { isError: boolean; text: string }): any {
  assert.equal(result.isError, true, `expected an MCP error, got: ${result.text}`);
  try { return JSON.parse(result.text); } catch { assert.fail(`the error body is not JSON: ${result.text}`); }
}

test("demo_create turns a URL and a step list into an MP4 in one call",
  { skip, timeout: TIMEOUT }, async () => {
  const sessionsBefore = await repoSessionDirs();
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "demomotion-e2e-create-")));
  const showcase = await startShowcaseServer();
  const client = await startServer(cwd);
  try {
    const outputPath = path.join(cwd, "signup.mp4");
    const created = await client.callOk("demo_create", {
      url: `${showcase.origin}/signup`, title: "Saltmarsh signup", steps: SIGNUP_STEPS,
      viewport: { width: WIDTH, height: HEIGHT }, headless: true, outputPath
    }, RENDER_CALL_TIMEOUT_MS);

    // Every path it claims exists, inside the test cwd.
    assert.equal(created.video, outputPath);
    assert.equal(created.pacing, "product-demo");
    for (const key of ["video", "project", "capture"]) {
      assert.ok(String(created[key]).startsWith(cwd), `${key} escaped the test cwd: ${created[key]}`);
      await fs.access(created[key]);
    }
    assert.ok((await fs.stat(outputPath)).size > 50_000, "the MP4 is implausibly small");
    assert.deepEqual(created.blockedRequests, []);

    // Duration, bounded by hand from SKILL.md's product-demo numbers: 1200 ms
    // after the opening navigation, 40 ms/char over 42 chars, 900 ms after each
    // of three fills, the caller's own waits, 2500 ms hold on the result.
    const floorSec = (1200 + TYPED_CHARS * 40 + 3 * 900 + EXPLICIT_WAIT_MS + 2500) / 1000;
    const seconds = await mp4Duration(outputPath);
    assert.ok(seconds >= floorSec, `rendered ${seconds.toFixed(2)}s, but the pacing alone adds up to ${floorSec.toFixed(2)}s`);
    assert.ok(seconds < floorSec + 6, `rendered ${seconds.toFixed(2)}s for a plan of ${floorSec.toFixed(2)}s of pacing — something stalled`);
    assert.ok(Math.abs(seconds - created.durationMs / 1000) < 0.4, `durationMs ${created.durationMs} does not match the file (${seconds.toFixed(2)}s)`);
    assert.deepEqual(await mp4Size(outputPath), { width: WIDTH, height: HEIGHT });

    // The project on disk carries the preset and the auto captions.
    const project = JSON.parse(await fs.readFile(created.project, "utf8"));
    assert.equal(project.title, "Saltmarsh signup");
    assert.equal(project.style.cutTransitionMs, 180);
    assert.equal(project.output, undefined, "product-demo publishes at the capture's own frame");
    assert.deepEqual(project.captions.map((c: any) => c.text), SIGNUP_LABELS, "captions: \"auto\" did not seed one line per label");
    for (const caption of project.captions) {
      assert.ok(caption.toMs - caption.fromMs <= 2200, `caption "${caption.text}" holds ${caption.toMs - caption.fromMs} ms, over product-demo's 2200`);
      assert.ok(caption.words.length > 0);
    }
    // The last label has 1200 + 2500 ms of free run after it: the hold is the preset's, exactly.
    const last = project.captions.at(-1);
    assert.equal(last.toMs - last.fromMs, 2200);

    // The capture shows the pacing was really recorded, not just written down:
    // every fill was typed (~40 ms/char), and the session is gone.
    const capture = JSON.parse(await fs.readFile(created.capture, "utf8"));
    const fills = capture.actions.filter((a: any) => a.type === "fill");
    assert.equal(fills.length, 3);
    for (const [i, chars] of [12, 15, 15].entries()) {
      assert.ok(fills[i].durationMs >= chars * 40, `fill ${i} took ${fills[i].durationMs} ms for ${chars} chars: not typed at 40 ms/char`);
      assert.equal(fills[i].value, "[redacted]");
    }
    const gone = await client.callTool("session_status", { sessionId: created.sessionId });
    assert.equal(gone.isError, true);
    assert.match(gone.text, new RegExp(`Unknown session: ${created.sessionId}`));
  } finally {
    client.close();
    showcase.stop();
    await fs.rm(cwd, { recursive: true, force: true });
  }
  assert.deepEqual(await repoSessionDirs(), sessionsBefore, "the run left session directories behind in the repo's data/");
});

test("demo_create with the social preset publishes vertical without being told",
  { skip, timeout: TIMEOUT }, async () => {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "demomotion-e2e-social-")));
  const showcase = await startShowcaseServer();
  const client = await startServer(cwd);
  try {
    const outputPath = path.join(cwd, "social.mp4");
    const created = await client.callOk("demo_create", {
      url: `${showcase.origin}/signup`, title: "Saltmarsh social", steps: SIGNUP_STEPS, pacing: "social",
      viewport: { width: WIDTH, height: HEIGHT }, headless: true, outputPath
    }, RENDER_CALL_TIMEOUT_MS);
    assert.equal(created.pacing, "social");

    // The defect from #1, closed at the preset: a 16:9 capture, a 9:16 file.
    assert.deepEqual(await mp4Size(outputPath), { width: 1080, height: 1920 });
    const project = JSON.parse(await fs.readFile(created.project, "utf8"));
    assert.deepEqual(project.output, { width: 1080, height: 1920 });
    assert.equal(project.width, WIDTH, "the RECORDED frame stays the capture's");
    assert.equal(project.style.cutTransitionMs, 120);
    assert.deepEqual(project.captions.map((c: any) => c.text), SIGNUP_LABELS);
    const last = project.captions.at(-1);
    assert.equal(last.toMs - last.fromMs, 1600, "social's caption hold");

    // Social types ONLY the first field: 30 ms/char on the name, instant after.
    const capture = JSON.parse(await fs.readFile(created.capture, "utf8"));
    const fills = capture.actions.filter((a: any) => a.type === "fill");
    assert.ok(fills[0].durationMs >= 12 * 30, `the first field took ${fills[0].durationMs} ms: not typed at 30 ms/char`);
    for (const fill of fills.slice(1)) {
      assert.ok(fill.durationMs < 15 * 30, `a later field took ${fill.durationMs} ms: it was typed, social fills it instantly`);
    }
    // And it is shorter than the product demo would be: 700 + 360 + 3*300 + the caller's waits + 1500.
    const floorSec = (700 + 12 * 30 + 3 * 300 + EXPLICIT_WAIT_MS + 1500) / 1000;
    const seconds = await mp4Duration(outputPath);
    assert.ok(seconds >= floorSec && seconds < floorSec + 6, `rendered ${seconds.toFixed(2)}s against a ${floorSec.toFixed(2)}s plan`);
  } finally {
    client.close();
    showcase.stop();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("a step that fails half-way names itself, keeps the capture, and leaves no browser behind",
  { skip, timeout: TIMEOUT }, async () => {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "demomotion-e2e-fail-")));
  const showcase = await startShowcaseServer();
  const client = await startServer(cwd);
  try {
    // Seed the detector first: a live session IS visible as a browser process
    // under the server, and stopping it makes that list empty. Without this,
    // "no browser left" below would be an assertion over an empty table.
    const { sessionId: probe } = await client.callOk("session_start", { width: WIDTH, height: HEIGHT, headless: true });
    await client.callOk("browser_goto", { sessionId: probe, url: `${showcase.origin}/` }); // a capture needs at least one frame
    const live = await browserProcessesOf(client.pid);
    assert.ok(live.length > 0, "the detector sees no browser under a server with a live session");
    await client.callOk("session_stop", { sessionId: probe });
    assert.deepEqual(await browserProcessesOf(client.pid), [], "session_stop left a browser behind");

    // Step 3 of the control flow (the terms checkbox), with a selector that exists nowhere.
    const broken = SIGNUP_STEPS.map((s, i) => (i === 3 ? { ...s, selector: '[data-testid="signup-terms-checkbox-missing"]' } : s));
    const failed = await client.callTool("demo_create", {
      url: `${showcase.origin}/signup`, title: "Broken", steps: broken,
      viewport: { width: WIDTH, height: HEIGHT }, headless: true
    }, RENDER_CALL_TIMEOUT_MS);
    const payload = errorPayload(failed);
    step(`demo_create error payload:\n${JSON.stringify(payload, null, 2)}`);

    // The error names the step: index, action, selector, and the real cause.
    assert.equal(payload.stage, "step");
    assert.deepEqual(payload.step, { index: 3, action: "click", selector: '[data-testid="signup-terms-checkbox-missing"]', label: "Agree to the terms" });
    assert.match(payload.error, /^demo_create failed at step 3 \(click "\[data-testid=\\"signup-terms-checkbox-missing\\"\]"\): /);
    assert.match(payload.cause, /signup-terms-checkbox-missing/);
    assert.equal(payload.project, undefined);
    assert.equal(payload.video, undefined);
    assert.equal(JSON.stringify(payload).includes("Marsh-tide-2024"), false, "a typed value leaked into the error");

    // Nothing is lost: the capture up to the failure is on disk, with the three fills.
    assert.ok(String(payload.capture).startsWith(cwd), `capture escaped the cwd: ${payload.capture}`);
    const capture = JSON.parse(await fs.readFile(payload.capture, "utf8"));
    assert.deepEqual(capture.actions.map((a: any) => a.type), ["goto", "wait", "fill", "wait", "fill", "wait", "fill", "wait"]);
    await fs.access(capture.videoPath);

    // The session is gone from the server, and the browser is gone from the OS.
    const gone = await client.callTool("session_status", { sessionId: payload.sessionId });
    assert.equal(gone.isError, true, "session_status still answers for the failed session");
    assert.match(gone.text, new RegExp(`Unknown session: ${payload.sessionId}`));
    assert.deepEqual(await browserProcessesOf(client.pid), [], "the failed demo_create leaked a browser");
  } finally {
    client.close();
    showcase.stop();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("a goto off the allowlist fails with the network policy's own message, and cleans up",
  { skip, timeout: TIMEOUT }, async () => {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "demomotion-e2e-policy-")));
  const showcase = await startShowcaseServer();
  const client = await startServer(cwd);
  try {
    const failed = await client.callTool("demo_create", {
      url: `${showcase.origin}/`, title: "Off the allowlist",
      steps: [{ action: "goto", url: "http://example.com/" }, { action: "wait", ms: 500 }],
      viewport: { width: WIDTH, height: HEIGHT }, headless: true
    }, RENDER_CALL_TIMEOUT_MS);
    const payload = errorPayload(failed);
    assert.equal(payload.stage, "step");
    assert.deepEqual(payload.step, { index: 0, action: "goto", url: "http://example.com/" });
    assert.match(payload.cause, /^DemoMotion refused http:\/\/example\.com\/: "example\.com:80" is not in DEMOMOTION_ALLOWED_HOSTS/);
    assert.match(payload.error, /^demo_create failed at step 0 \(goto http:\/\/example\.com\/\): DemoMotion refused/);
    // The refusal is also on the record, as session_status would have shown it.
    const block = (payload.blockedRequests as Array<any>).find((b) => b.host === "example.com");
    assert.ok(block, `no blocked request for example.com in ${JSON.stringify(payload.blockedRequests)}`);
    assert.equal(block.kind, "navigation");
    // The opening navigation (allowed) was recorded before the refusal.
    await fs.access(payload.capture);
    const capture = JSON.parse(await fs.readFile(payload.capture, "utf8"));
    assert.equal(capture.actions[0].type, "goto");
    assert.equal(capture.actions[0].url, `${showcase.origin}/`);

    const gone = await client.callTool("session_status", { sessionId: payload.sessionId });
    assert.match(gone.text, new RegExp(`Unknown session: ${payload.sessionId}`));
    assert.deepEqual(await browserProcessesOf(client.pid), [], "the refused demo_create leaked a browser");
  } finally {
    client.close();
    showcase.stop();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("every tool the server publishes was actually called over the wire",
  { skip }, async () => {
  // The gap this closes: tools/list once published fifteen tools and the flow
  // above exercised ten. The five that were never invoked included browser_inspect,
  // which was broken in the very runtime this file spawns. Listing is not
  // calling, and only calling finds that kind of defect.
  const missing = EXPECTED_TOOLS.filter((name) => !INVOKED.has(name));
  assert.deepEqual(missing, [], `published but never invoked: ${missing.join(", ")}`);
  assert.equal(INVOKED.size, EXPECTED_TOOLS.length,
    `invoked ${[...INVOKED].sort().join(", ")}, expected exactly the ${EXPECTED_TOOLS.length} published tools`);
});
