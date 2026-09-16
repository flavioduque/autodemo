import test from "node:test";
import assert from "node:assert/strict";
import { demoCreateInput, planSteps, runDemoCreate, type DemoCreateDeps } from "../src/demo-create.ts";
import { PACING_PRESETS } from "../src/pacing.ts";
import { sourceMs } from "@autodemo/schema";

// demo_create is an ORCHESTRATION of tools that are each proven elsewhere. What
// is new, and what these tests pin, is (a) the shape it accepts, (b) how a
// preset turns a step list into the concrete capture plan, and (c) what happens
// when a step fails half-way — the session must die and the error must name
// the step. (c) is exercised here against fakes so every branch runs in
// milliseconds; the gated e2e suite runs the real thing once.

const URL = "http://127.0.0.1:4322/signup";

const SIGNUP = [
  { action: "fill", selector: "#name", value: "Inês Corvelo", label: "Your name opens the workspace" },
  { action: "fill", selector: "#email", value: "ines@studio.com", label: "One e-mail, no verification" },
  { action: "click", selector: "#terms", label: "Agree to the terms" },
  { action: "wait", ms: 500 },
  { action: "click", selector: "#submit", label: "Create workspace" }
] as const;

// --- (a) the accepted surface -------------------------------------------------

test("demo_create accepts an explicit step list and fills the defaults the skill promises", () => {
  const parsed = demoCreateInput.parse({
    url: URL,
    title: "Signup",
    steps: [
      { action: "goto", url: "http://127.0.0.1:4322/" },
      { action: "click", selector: "#cta", label: "Start free" },
      { action: "fill", selector: "#name", value: "Inês", typeDelayMs: 60 },
      { action: "scroll", deltaY: 400 },
      { action: "keypress", key: "Enter" },
      { action: "wait", ms: 800 }
    ]
  });
  assert.equal(parsed.pacing, "product-demo", "product demo is the default when the caller says nothing");
  assert.equal(parsed.captions, "auto", "the label-seeded skeleton is the default");
  assert.deepEqual(parsed.viewport, { width: 1920, height: 1080 });
  assert.equal(parsed.headless, false);
  assert.equal(parsed.output, undefined);
  assert.equal(parsed.steps.length, 6);

  // Explicit values survive.
  const social = demoCreateInput.parse({
    url: URL, steps: [{ action: "wait", ms: 100 }], pacing: "social",
    output: { width: 1080, height: 1350 }, captions: [{ fromMs: 0, toMs: 1000, text: "Hi" }],
    viewport: { width: 1280, height: 720 }, headless: true
  });
  assert.equal(social.pacing, "social");
  assert.deepEqual(social.output, { width: 1080, height: 1350 });
  assert.equal(Array.isArray(social.captions) && social.captions[0].text, "Hi");
});

test("demo_create refuses what no step could do", () => {
  const refuse = (patch: Record<string, unknown>, why: string) => {
    const r = demoCreateInput.safeParse({ url: URL, steps: [{ action: "wait", ms: 100 }], ...patch });
    assert.equal(r.success, false, why);
  };
  refuse({ steps: [] }, "a demo with no steps");
  refuse({ steps: [{ action: "hover", selector: "#x" }] }, "an action the recorder does not have");
  refuse({ steps: [{ action: "fill", selector: "#x" }] }, "a fill with nothing to type");
  refuse({ steps: [{ action: "click" }] }, "a click with no selector");
  refuse({ steps: [{ action: "wait", ms: 10 }] }, "a wait under browser_wait's floor");
  refuse({ steps: [{ action: "goto", url: "not a url" }] }, "a goto to a non-URL");
  refuse({ steps: [{ action: "fill", selector: "#x", value: "v", typeDelayMs: 500 }] }, "a type delay over browser_fill's cap");
  refuse({ url: "ftp://x" }, "a demo URL that is not http(s)");
  refuse({ pacing: "cinematic" }, "a pacing preset that does not exist");
  refuse({ output: { width: 1080 } }, "half an output frame");
});

// --- (b) the plan a preset produces ------------------------------------------

test("product-demo expands the signup steps into the capture plan, wait by wait", () => {
  const plan = planSteps(URL, [...SIGNUP], PACING_PRESETS["product-demo"]);
  // Hand-written from SKILL.md section 2: 1200 ms after a navigation, 900 ms
  // between fields, 40 ms per character, 2500 ms hold on the final result.
  assert.deepEqual(plan, [
    { origin: "open", step: { action: "goto", url: URL } },
    { origin: "pacing", reason: "after-navigation", step: { action: "wait", ms: 1200 } },
    { origin: "step", index: 0, step: { ...SIGNUP[0], typeDelayMs: 40 } },
    { origin: "pacing", reason: "between-fields", step: { action: "wait", ms: 900 } },
    { origin: "step", index: 1, step: { ...SIGNUP[1], typeDelayMs: 40 } },
    { origin: "pacing", reason: "between-fields", step: { action: "wait", ms: 900 } },
    { origin: "step", index: 2, step: SIGNUP[2] },
    { origin: "step", index: 3, step: SIGNUP[3] },
    { origin: "step", index: 4, step: SIGNUP[4] },
    { origin: "pacing", reason: "final-hold", step: { action: "wait", ms: 2500 } }
  ]);
});

test("social types only the first field, waits less, and holds the result for 1.5 s", () => {
  const plan = planSteps(URL, [...SIGNUP], PACING_PRESETS.social);
  const fills = plan.filter((p) => p.origin === "step" && p.step.action === "fill").map((p) => (p.step as any).typeDelayMs);
  assert.deepEqual(fills, [30, 0]);
  const waits = plan.filter((p) => p.origin === "pacing").map((p) => [p.reason, (p.step as any).ms]);
  assert.deepEqual(waits, [["after-navigation", 700], ["between-fields", 300], ["between-fields", 300], ["final-hold", 1500]]);
});

test("a step that names its own pacing wins over the preset", () => {
  const steps = [
    { action: "fill", selector: "#a", value: "x", typeDelayMs: 0 },
    { action: "wait", ms: 200 },
    { action: "fill", selector: "#b", value: "y" },
    { action: "goto", url: "http://127.0.0.1:4322/two" },
    { action: "wait", ms: 300 },
    { action: "goto", url: "http://127.0.0.1:4322/three" },
    { action: "click", selector: "#c" }
  ] as const;
  const plan = planSteps(URL, [...steps], PACING_PRESETS.tutorial);
  const summary = plan.map((p) => p.origin === "pacing" ? `${p.reason}:${(p.step as any).ms}` : `${p.origin}:${p.step.action}${"typeDelayMs" in p.step ? ":" + p.step.typeDelayMs : ""}`);
  assert.deepEqual(summary, [
    "open:goto", "after-navigation:2000",
    "step:fill:0",          // explicit 0 kept; an explicit wait follows, so none is inserted
    "step:wait",
    "step:fill:55",         // tutorial's delay; next is a goto, not a wait -> between-fields
    "between-fields:1500",
    "step:goto",            // followed by an explicit wait: nothing inserted
    "step:wait",
    "step:goto", "after-navigation:2000",
    "step:click",
    "final-hold:3500"
  ]);
});

// --- (c) the run, against fakes ----------------------------------------------

type Call = [string, ...unknown[]];

function fakeDeps(overrides: Partial<DemoCreateDeps> & { urlAfterClick?: string } = {}, calls: Call[] = []) {
  let url = URL;
  const deps: DemoCreateDeps = {
    startSession: async (o) => { calls.push(["startSession", o]); return { id: "sess-1" }; },
    goto: async (id, u) => { calls.push(["goto", id, u]); url = u; },
    click: async (id, sel, label) => { calls.push(["click", id, sel, label]); if (overrides.urlAfterClick) url = overrides.urlAfterClick; },
    fill: async (id, sel, value, label, delay) => { calls.push(["fill", id, sel, value, label, delay]); },
    wait: async (id, ms) => { calls.push(["wait", id, ms]); },
    scroll: async (id, dy, dx) => { calls.push(["scroll", id, dy, dx]); },
    keypress: async (id, key) => { calls.push(["keypress", id, key]); },
    status: (id) => ({ url, blockedRequests: [{ seq: 1, url: "http://evil/", host: "evil", port: 80, kind: "subresource", reason: "not-listed", message: "refused", atMs: sourceMs(10) }] }),
    stopSession: async (id) => { calls.push(["stopSession", id]); return { manifestPath: `/tmp/${id}/capture.json`, durationMs: 12_345, blockedRequests: [] }; },
    destroySession: async (id) => { calls.push(["destroySession", id]); },
    buildProject: async (manifest, title, options) => { calls.push(["buildProject", manifest, title, options]); return { projectPath: "/tmp/sess-1/project.json" }; },
    updateProject: async (projectPath, patch) => { calls.push(["updateProject", projectPath, patch]); },
    renderVideo: async (projectPath, out) => { calls.push(["renderVideo", projectPath, out]); return out ?? "/tmp/sess-1/final.mp4"; },
    ...overrides
  };
  return { deps, calls };
}

test("a successful run drives start → open → steps → stop → build → update → render and answers with every path", async () => {
  const { deps, calls } = fakeDeps();
  const input = demoCreateInput.parse({ url: URL, title: "Signup", steps: [...SIGNUP], pacing: "social", viewport: { width: 1280, height: 720 }, headless: true });
  const outcome = await runDemoCreate(input, deps);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  if (!outcome.ok) return;
  assert.deepEqual(outcome.value, {
    video: "/tmp/sess-1/final.mp4",
    project: "/tmp/sess-1/project.json",
    capture: "/tmp/sess-1/capture.json",
    durationMs: 12_345,
    blockedRequests: [],
    sessionId: "sess-1",
    pacing: "social"
  });
  assert.deepEqual(calls.map((c) => c[0]), [
    "startSession", "goto", "wait", "fill", "wait", "fill", "wait", "click", "wait", "click", "wait",
    "stopSession", "buildProject", "updateProject", "renderVideo"
  ]);
  assert.deepEqual(calls[0][1], { width: 1280, height: 720, headless: true });
  // The preset reached the recorder: first field typed at 30, second instant.
  assert.equal(calls[3][5], 30);
  assert.equal(calls[5][5], 0);
  // ...and the compiler: social's caption hold, cut transition and vertical frame.
  assert.deepEqual(calls[12][3], { captionHoldMs: 1600 });
  assert.deepEqual(calls[13][2], { style: { cutTransitionMs: 120 }, output: { width: 1080, height: 1920 } });
  // No browser was destroyed: it was stopped, once, the normal way.
  assert.equal(calls.filter((c) => c[0] === "destroySession").length, 0);
  assert.equal(calls.filter((c) => c[0] === "stopSession").length, 1);
});

test("an explicit output frame beats the preset's, and explicit captions replace the skeleton", async () => {
  const { deps, calls } = fakeDeps();
  const captions = [{ fromMs: 0, toMs: 1000, text: "Hello", words: [] }];
  const input = demoCreateInput.parse({ url: URL, steps: [{ action: "wait", ms: 100 }], pacing: "social", output: { width: 1080, height: 1350 }, captions });
  const outcome = await runDemoCreate(input, deps);
  assert.equal(outcome.ok, true);
  const update = calls.find((c) => c[0] === "updateProject")!;
  assert.deepEqual(update[2], { style: { cutTransitionMs: 120 }, output: { width: 1080, height: 1350 }, captions });

  // Control: product-demo with `auto` sends neither an output nor captions —
  // the skeleton stays, the frame stays the capture's.
  const plain = fakeDeps();
  await runDemoCreate(demoCreateInput.parse({ url: URL, steps: [{ action: "wait", ms: 100 }] }), plain.deps);
  assert.deepEqual(plain.calls.find((c) => c[0] === "updateProject")![2], { style: { cutTransitionMs: 180 } });
});

test("a click that changes the page URL gets the preset's after-navigation wait", async () => {
  const { deps, calls } = fakeDeps({ urlAfterClick: "http://127.0.0.1:4322/signup" });
  await runDemoCreate(demoCreateInput.parse({ url: "http://127.0.0.1:4322/", steps: [{ action: "click", selector: "#cta" }, { action: "fill", selector: "#name", value: "x" }] }), deps);
  // The fill is the last step, so the final hold follows it, not a between-fields wait.
  assert.deepEqual(calls.map((c) => c[0] === "wait" ? `wait:${c[2]}` : c[0]).slice(1, 7),
    ["goto", "wait:1200", "click", "wait:1200", "fill", "wait:2500"]);
  // Control: a click that stays on the page inserts nothing.
  const still = fakeDeps();
  await runDemoCreate(demoCreateInput.parse({ url: URL, steps: [{ action: "click", selector: "#x" }, { action: "fill", selector: "#name", value: "x" }] }), still.deps);
  assert.deepEqual(still.calls.map((c) => c[0] === "wait" ? `wait:${c[2]}` : c[0]).slice(1, 6),
    ["goto", "wait:1200", "click", "fill", "wait:2500"]);
});

test("a step that fails stops the session, keeps the capture, and the error names the step", async () => {
  const calls: Call[] = [];
  const { deps } = fakeDeps({
    click: async (_id, selector) => {
      calls.push(["click", selector]);
      if (selector === "#terms") throw new Error('locator.boundingBox: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator("#terms").first()');
    }
  }, calls);
  const outcome = await runDemoCreate(demoCreateInput.parse({ url: URL, title: "Signup", steps: [...SIGNUP] }), deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  const failure = outcome.failure;
  assert.equal(failure.stage, "step");
  assert.deepEqual(failure.step, { index: 2, action: "click", selector: "#terms", label: "Agree to the terms" });
  assert.match(failure.cause, /Timeout 30000ms exceeded/);
  assert.match(failure.error, /^demo_create failed at step 2 \(click "#terms"\): locator\.boundingBox: Timeout/);
  assert.equal(failure.sessionId, "sess-1");
  assert.equal(failure.capture, "/tmp/sess-1/capture.json", "the capture recorded up to the failure is handed back");
  assert.equal(failure.project, undefined);
  assert.equal(failure.video, undefined);
  // The session was STOPPED (capture written), never destroyed, and nothing
  // after the failing step ran — no build, no render.
  assert.deepEqual(calls.map((c) => c[0]), ["startSession", "goto", "wait", "fill", "wait", "fill", "wait", "click", "stopSession"]);
});

test("terminal colour codes in a Playwright message do not reach the error payload", async () => {
  const { deps } = fakeDeps({ click: async () => { throw new Error("Timeout 30000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator('#x')\u001b[22m\n"); } });
  const outcome = await runDemoCreate(demoCreateInput.parse({ url: URL, steps: [{ action: "click", selector: "#x" }] }), deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure.cause, "Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator('#x')\n");
  assert.doesNotMatch(outcome.failure.error, /\u001b/);
});

test("a fill's value never reaches the error payload", async () => {
  const { deps } = fakeDeps({ fill: async () => { throw new Error("field is read-only"); } });
  const outcome = await runDemoCreate(demoCreateInput.parse({ url: URL, steps: [{ action: "fill", selector: "#pw", value: "hunter2-secret", label: "Password" }] }), deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.deepEqual(outcome.failure.step, { index: 0, action: "fill", selector: "#pw", label: "Password" });
  assert.equal(JSON.stringify(outcome.failure).includes("hunter2"), false);
});

test("the opening navigation failing is reported as the open stage, with the policy's own message", async () => {
  const message = 'AutoDemo refused http://example.com/: "example.com" is not in AUTODEMO_ALLOWED_HOSTS (currently localhost, 127.0.0.1, ::1).';
  const calls: Call[] = [];
  const { deps } = fakeDeps({ goto: async () => { calls.push(["goto"]); throw new Error(message); } }, calls);
  const outcome = await runDemoCreate(demoCreateInput.parse({ url: "http://example.com/", steps: [{ action: "wait", ms: 100 }] }), deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure.stage, "open");
  assert.deepEqual(outcome.failure.step, { action: "goto", url: "http://example.com/" });
  assert.equal(outcome.failure.cause, message);
  assert.deepEqual(calls.map((c) => c[0]), ["startSession", "goto", "stopSession"]);
});

test("when stopping the session itself fails, the browser is destroyed and the payload says there is no capture", async () => {
  const calls: Call[] = [];
  const { deps } = fakeDeps({
    click: async () => { calls.push(["click"]); throw new Error("boom"); },
    stopSession: async () => { calls.push(["stopSession"]); throw new Error("ffmpeg exited with code 1"); }
  }, calls);
  const outcome = await runDemoCreate(demoCreateInput.parse({ url: URL, steps: [{ action: "click", selector: "#x" }] }), deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure.stage, "step");
  assert.equal(outcome.failure.capture, undefined);
  assert.match(outcome.failure.cleanup!, /ffmpeg exited with code 1/);
  // blockedRequests still come from the live status read before the stop.
  assert.equal(outcome.failure.blockedRequests.length, 1);
  assert.deepEqual(calls.map((c) => c[0]), ["startSession", "goto", "wait", "click", "stopSession", "destroySession"]);
});

test("a render failure returns both the capture and the project so nothing is lost", async () => {
  const { deps, calls } = fakeDeps({ renderVideo: async () => { throw new Error("HyperFrames exited with code 1"); } });
  const outcome = await runDemoCreate(demoCreateInput.parse({ url: URL, steps: [{ action: "wait", ms: 100 }] }), deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure.stage, "render");
  assert.equal(outcome.failure.step, undefined);
  assert.equal(outcome.failure.capture, "/tmp/sess-1/capture.json");
  assert.equal(outcome.failure.project, "/tmp/sess-1/project.json");
  assert.match(outcome.failure.error, /^demo_create failed while rendering: HyperFrames exited with code 1/);
  // The session was already stopped before the build; it is not stopped twice.
  assert.equal(calls.filter((c) => c[0] === "stopSession").length, 1);
  assert.equal(calls.filter((c) => c[0] === "destroySession").length, 0);
});
