import * as z from "zod/v4";
import * as sessions from "./session-manager.js";
import type { BlockedRequest } from "./session-manager.js";
import { buildProject, updateProject, type ProjectPatch } from "./project.js";
import { renderVideo } from "./render.js";
import { PACING_NAMES, PACING_PRESETS, typeDelayForFill, type PacingName, type PacingPreset } from "./pacing.js";
import { captionInput, outputFrameInput } from "./tool-inputs.js";

// ---------------------------------------------------------------------------
// demo_create: one call, one MP4.
//
// An ORCHESTRATION, not a planner. The caller hands over the URL and an
// explicit step list; this module runs session_start → goto → the steps →
// session_stop → project_build → project_update → render_video through the very
// same functions the fifteen granular tools call, with a pacing preset filling
// in the numbers a step does not name. Nothing here decides WHAT to click.
//
// The part that decides whether the tool can be trusted is the failure path.
// A demo has 5–20 steps against a live app and step 7 will fail sometimes. When
// it does: the session is stopped (no leaked browser), the capture recorded so
// far is handed back, and the error names the step — index, action, selector,
// and the underlying message.
// ---------------------------------------------------------------------------

const stepBase = { label: z.string().optional() };

/** http(s) only — the policy would refuse anything else, but here it is refused before a browser is launched. */
const httpUrl = z.url({ protocol: /^https?$/ });

/** The recorder's actions, one object each, discriminated by `action`. */
export const demoStepInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), selector: z.string().min(1), ...stepBase }),
  z.object({
    action: z.literal("fill"), selector: z.string().min(1), value: z.string(), ...stepBase,
    /** Per-character delay. Absent, the pacing preset decides; 0 fills instantly. */
    typeDelayMs: z.number().int().min(0).max(200).optional()
  }),
  z.object({ action: z.literal("scroll"), deltaY: z.number().int().min(-10000).max(10000), deltaX: z.number().int().min(-10000).max(10000).default(0) }),
  z.object({ action: z.literal("keypress"), key: z.string().min(1).max(80) }),
  z.object({ action: z.literal("wait"), ms: z.number().int().min(50).max(30000) }),
  z.object({ action: z.literal("goto"), url: httpUrl })
]);
export type DemoStep = z.infer<typeof demoStepInput>;

/** Exported so the accepted surface can be exercised without booting a server. */
export const demoCreateInput = z.object({
  url: httpUrl,
  title: z.string().min(1).default("Product Demo"),
  steps: z.array(demoStepInput).min(1).max(60),
  pacing: z.enum(PACING_NAMES).default("product-demo"),
  /** The published frame. Absent, the preset decides (social publishes 1080x1920). */
  output: outputFrameInput.optional(),
  /** `"auto"` keeps the skeleton `project_build` seeds from the step labels. */
  captions: z.union([z.literal("auto"), z.array(captionInput)]).default("auto"),
  /** The RECORDED frame. */
  viewport: z.object({
    width: z.number().int().min(640).max(3840),
    height: z.number().int().min(480).max(2160)
  }).default({ width: 1920, height: 1080 }),
  headless: z.boolean().default(false),
  /** Where the MP4 goes. Default: final.mp4 beside the project. */
  outputPath: z.string().optional()
});
export type DemoCreateInput = z.infer<typeof demoCreateInput>;

/** A step of the concrete plan: the caller's, the opening navigation, or a wait the preset inserted. */
export type PlannedStep =
  | { origin: "open"; step: { action: "goto"; url: string } }
  | { origin: "step"; index: number; step: DemoStep }
  | { origin: "pacing"; reason: "after-navigation" | "between-fields" | "final-hold"; step: { action: "wait"; ms: number } };

const pacingWait = (reason: Extract<PlannedStep, { origin: "pacing" }>["reason"], ms: number): PlannedStep =>
  ({ origin: "pacing", reason, step: { action: "wait", ms } });

/**
 * Expands the caller's steps into the capture plan, pure and inspectable.
 *
 * The preset supplies what a step does not say: the wait after a navigation
 * (the opening one, and every `goto`), the wait between fields (after a fill,
 * unless the caller placed their own wait next), the per-character delay of a
 * fill, and the hold on the final result. A step that names its own pacing
 * keeps it. What the plan cannot know is whether a CLICK navigates; the runner
 * checks the URL after each click and inserts the after-navigation wait then.
 */
export function planSteps(url: string, steps: DemoStep[], preset: PacingPreset): PlannedStep[] {
  const plan: PlannedStep[] = [{ origin: "open", step: { action: "goto", url } }];
  const explicitWaitFollows = (i: number) => steps[i + 1]?.action === "wait";
  if (!explicitWaitFollows(-1)) plan.push(pacingWait("after-navigation", preset.waitAfterNavigationMs));

  let fills = 0;
  steps.forEach((step, index) => {
    if (step.action === "fill") {
      const typeDelayMs = step.typeDelayMs ?? typeDelayForFill(preset, fills++);
      plan.push({ origin: "step", index, step: { ...step, typeDelayMs } });
      if (index < steps.length - 1 && !explicitWaitFollows(index)) plan.push(pacingWait("between-fields", preset.waitBetweenFieldsMs));
      return;
    }
    plan.push({ origin: "step", index, step });
    if (step.action === "goto" && index < steps.length - 1 && !explicitWaitFollows(index)) {
      plan.push(pacingWait("after-navigation", preset.waitAfterNavigationMs));
    }
  });

  plan.push(pacingWait("final-hold", preset.finalHoldMs));
  return plan;
}

/** Everything the run touches, so the failure paths can be driven by fakes. */
export interface DemoCreateDeps {
  startSession: (opts: { width: number; height: number; headless: boolean }) => Promise<{ id: string }>;
  goto: (id: string, url: string) => Promise<void>;
  click: (id: string, selector: string, label?: string) => Promise<void>;
  fill: (id: string, selector: string, value: string, label?: string, typeDelayMs?: number) => Promise<void>;
  wait: (id: string, ms: number) => Promise<void>;
  scroll: (id: string, deltaY: number, deltaX?: number) => Promise<void>;
  keypress: (id: string, key: string) => Promise<void>;
  status: (id: string) => { url: string; blockedRequests: BlockedRequest[] };
  stopSession: (id: string) => Promise<{ manifestPath: string; durationMs: number; blockedRequests: BlockedRequest[] }>;
  destroySession: (id: string) => Promise<void>;
  buildProject: (manifestPath: string, title: string, options: { captionHoldMs: number }) => Promise<{ projectPath: string }>;
  updateProject: (projectPath: string, patch: ProjectPatch) => Promise<unknown>;
  renderVideo: (projectPath: string, outputPath?: string) => Promise<string>;
}

const realDeps: DemoCreateDeps = {
  startSession: sessions.startSession,
  goto: sessions.goto,
  click: sessions.click,
  fill: sessions.fill,
  wait: sessions.wait,
  scroll: sessions.scroll,
  keypress: sessions.keypress,
  status: sessions.status,
  stopSession: sessions.stopSession,
  destroySession: sessions.destroySession,
  buildProject,
  updateProject,
  renderVideo
};

export interface DemoCreateResult {
  /** Absolute paths. */
  video: string;
  project: string;
  capture: string;
  /** The capture's length — and the video's, since demo_create renders the identity edit. */
  durationMs: number;
  blockedRequests: BlockedRequest[];
  sessionId: string;
  pacing: PacingName;
}

/** The step a failure names. A fill's `value` is never included. */
export type FailedStep =
  | { index: number; action: DemoStep["action"]; selector?: string; label?: string; url?: string; key?: string; ms?: number; deltaY?: number; deltaX?: number }
  | { action: "goto"; url: string };

export interface DemoCreateFailure {
  /** One line: where it failed and why. */
  error: string;
  stage: "open" | "step" | "stop" | "build" | "update" | "render";
  step?: FailedStep;
  /** The underlying message — the network policy's own when that is the cause. */
  cause: string;
  sessionId: string;
  /** capture.json, when the recording up to the failure was assembled. */
  capture?: string;
  /** project.json, when the failure came after the build. */
  project?: string;
  video?: string;
  blockedRequests: BlockedRequest[];
  /** Set when the session could not even be stopped normally and was destroyed instead. */
  cleanup?: string;
}

export type DemoCreateOutcome = { ok: true; value: DemoCreateResult } | { ok: false; failure: DemoCreateFailure };

/** Playwright colours its call logs for a terminal; a JSON error body is not one. */
const ANSI = /\u001b\[[0-9;]*m/g;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(ANSI, "");

/** The step as the error reports it: identity, never the typed value. */
function describeStep(index: number, step: DemoStep): FailedStep {
  const { action } = step;
  switch (action) {
    case "click": return { index, action, selector: step.selector, ...(step.label !== undefined ? { label: step.label } : {}) };
    case "fill": return { index, action, selector: step.selector, ...(step.label !== undefined ? { label: step.label } : {}) };
    case "goto": return { index, action, url: step.url };
    case "keypress": return { index, action, key: step.key };
    case "wait": return { index, action, ms: step.ms };
    case "scroll": return { index, action, deltaY: step.deltaY, deltaX: step.deltaX };
  }
}

function stepName(step: FailedStep): string {
  const where = "index" in step ? `step ${step.index} (` : "the opening navigation (";
  const what = "selector" in step && step.selector ? `${step.action} ${JSON.stringify(step.selector)}`
    : "url" in step && step.url ? `${step.action} ${step.url}`
    : step.action;
  return `${where}${what})`;
}

async function runStep(deps: DemoCreateDeps, id: string, step: DemoStep | { action: "goto"; url: string }) {
  switch (step.action) {
    case "goto": return deps.goto(id, step.url);
    case "click": return deps.click(id, step.selector, step.label);
    case "fill": return deps.fill(id, step.selector, step.value, step.label, step.typeDelayMs);
    case "wait": return deps.wait(id, step.ms);
    case "scroll": return deps.scroll(id, step.deltaY, step.deltaX);
    case "keypress": return deps.keypress(id, step.key);
  }
}

export async function runDemoCreate(input: DemoCreateInput, deps: DemoCreateDeps = realDeps): Promise<DemoCreateOutcome> {
  const preset = PACING_PRESETS[input.pacing];
  const plan = planSteps(input.url, input.steps, preset);
  const { id } = await deps.startSession({ width: input.viewport.width, height: input.viewport.height, headless: input.headless });

  /**
   * Ends a run that failed while the session is still live. The session is
   * STOPPED, not destroyed, so the capture recorded up to the failure survives;
   * only if stopping itself fails is the browser destroyed outright.
   */
  const failLive = async (stage: DemoCreateFailure["stage"], cause: unknown, step?: FailedStep): Promise<DemoCreateOutcome> => {
    const message = messageOf(cause);
    const failure: DemoCreateFailure = {
      error: `demo_create failed at ${step ? stepName(step) : stage}: ${message}`,
      stage, ...(step ? { step } : {}), cause: message, sessionId: id, blockedRequests: []
    };
    try { failure.blockedRequests = deps.status(id).blockedRequests; } catch { /* session already gone */ }
    try {
      const capture = await deps.stopSession(id);
      failure.capture = capture.manifestPath;
      failure.blockedRequests = capture.blockedRequests;
    } catch (stopError) {
      failure.cleanup = `session_stop failed (${messageOf(stopError)}); the browser was destroyed and no capture was written`;
      try { await deps.destroySession(id); } catch { /* already gone */ }
    }
    return { ok: false, failure };
  };

  // --- capture -------------------------------------------------------------
  for (let i = 0; i < plan.length; i++) {
    const planned = plan[i];
    const failed: FailedStep | undefined =
      planned.origin === "step" ? describeStep(planned.index, planned.step)
      : planned.origin === "open" ? { action: "goto", url: planned.step.url }
      : undefined;
    const stage: DemoCreateFailure["stage"] = planned.origin === "open" ? "open" : "step";

    let urlBefore: string | undefined;
    if (planned.step.action === "click") {
      try { urlBefore = deps.status(id).url; } catch { /* leave undefined */ }
    }
    try {
      await runStep(deps, id, planned.step);
    } catch (error) {
      return failLive(stage, error, failed);
    }
    // A click that navigated gets the preset's after-navigation wait, unless
    // the caller placed their own wait next.
    if (planned.origin === "step" && planned.step.action === "click" && urlBefore !== undefined) {
      const next = input.steps[planned.index + 1];
      let urlAfter: string | undefined;
      try { urlAfter = deps.status(id).url; } catch { /* leave undefined */ }
      if (urlAfter !== undefined && urlAfter !== urlBefore && next?.action !== "wait") {
        try { await deps.wait(id, preset.waitAfterNavigationMs); } catch (error) { return failLive("step", error, failed); }
      }
    }
  }

  // --- stop ----------------------------------------------------------------
  let capture: Awaited<ReturnType<DemoCreateDeps["stopSession"]>>;
  try {
    capture = await deps.stopSession(id);
  } catch (error) {
    const message = messageOf(error);
    let blockedRequests: BlockedRequest[] = [];
    try { blockedRequests = deps.status(id).blockedRequests; } catch { /* gone */ }
    try { await deps.destroySession(id); } catch { /* already gone */ }
    return { ok: false, failure: { error: `demo_create failed while stopping the session: ${message}`, stage: "stop", cause: message, sessionId: id, blockedRequests, cleanup: "the browser was destroyed and no capture was written" } };
  }

  // The session is over from here on: failures below carry paths, not a browser.
  const failDone = (stage: "build" | "update" | "render", cause: unknown, paths: { project?: string }): DemoCreateOutcome => {
    const message = messageOf(cause);
    const verb = stage === "build" ? "building the project" : stage === "update" ? "applying the pacing to the project" : "rendering";
    return { ok: false, failure: { error: `demo_create failed while ${verb}: ${message}`, stage, cause: message, sessionId: id, capture: capture.manifestPath, ...paths, blockedRequests: capture.blockedRequests } };
  };

  // --- build ---------------------------------------------------------------
  let projectPath: string;
  try {
    projectPath = (await deps.buildProject(capture.manifestPath, input.title, { captionHoldMs: preset.captionHoldMs })).projectPath;
  } catch (error) {
    return failDone("build", error, {});
  }

  // --- the preset becomes project.json --------------------------------------
  const patch: ProjectPatch = { style: { cutTransitionMs: preset.cutTransitionMs } };
  const output = input.output ?? preset.output;
  if (output) patch.output = output;
  if (input.captions !== "auto") patch.captions = input.captions;
  try {
    await deps.updateProject(projectPath, patch);
  } catch (error) {
    return failDone("update", error, { project: projectPath });
  }

  // --- render --------------------------------------------------------------
  let video: string;
  try {
    video = await deps.renderVideo(projectPath, input.outputPath);
  } catch (error) {
    return failDone("render", error, { project: projectPath });
  }

  return {
    ok: true,
    value: { video, project: projectPath, capture: capture.manifestPath, durationMs: capture.durationMs, blockedRequests: capture.blockedRequests, sessionId: id, pacing: input.pacing }
  };
}
