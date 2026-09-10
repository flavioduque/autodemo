import type { DemoProject } from "@demomotion/schema";
import { DemoProjectSchema } from "@demomotion/schema";

/** A minimal, valid project. Every field a test cares about is overridden explicitly. */
export function project(overrides: Partial<DemoProject> = {}): DemoProject {
  return DemoProjectSchema.parse({
    version: 1,
    title: "T",
    sourceVideo: "/abs/source.webm",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 10000,
    style: { background: "#0b1020", padding: 56, radius: 24, shadow: true },
    actions: [],
    zooms: [],
    editList: [{ sourceFromMs: 0, sourceToMs: 10000, speed: 1 }],
    callouts: [],
    ...overrides
  });
}

export type Clip = { start: number; duration: number; mediaStart: number; rate: number };

function attrOf(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

/** Every <video> clip in document order, with its timing attributes as numbers. */
export function clips(html: string): Clip[] {
  return [...html.matchAll(/<video\b[^>]*>/g)].map((m) => {
    const tag = m[0];
    const num = (n: string) => Number(attrOf(tag, n));
    return { start: num("data-start"), duration: num("data-duration"), mediaStart: num("data-media-start"), rate: num("data-playback-rate") };
  });
}

export function rootTag(html: string): string {
  const m = /<div\b[^>]*data-composition-id="root"[^>]*>/.exec(html);
  if (!m) throw new Error("no root composition element in generated HTML");
  return m[0];
}

export function rootAttr(html: string, name: string): string {
  const v = attrOf(rootTag(html), name);
  if (v === null) throw new Error(`root has no ${name}`);
  return v;
}

/** The element that holds the video, i.e. the letterboxed content box. */
export function stageStyle(html: string): Record<string, string> {
  const m = /<div\b[^>]*id="stage"[^>]*style="([^"]*)"[^>]*>/.exec(html);
  if (!m) throw new Error("no #stage element in generated HTML");
  const out: Record<string, string> = {};
  for (const decl of m[1].split(";")) {
    const i = decl.indexOf(":");
    if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  return out;
}

export function px(value: string): number {
  const m = /^(-?[\d.]+)px$/.exec(value);
  if (!m) throw new Error(`not a px value: ${value}`);
  return Number(m[1]);
}

export type CameraKeyframe = { start: number; end: number; scale: number; x: number; y: number };

/** The camera track the generator emits, in OUTPUT seconds. */
export function camera(html: string): CameraKeyframe[] {
  const m = /<script type="application\/json" id="demomotion-camera">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("no camera track in generated HTML");
  return JSON.parse(m[1]);
}

/** Every timed overlay div (callouts), with its output timing. */
export function overlays(html: string): Array<{ start: number; duration: number; text: string }> {
  return [...html.matchAll(/<div [^>]*class="callout"[^>]*data-start="([^"]*)"[^>]*data-duration="([^"]*)"[^>]*>([\s\S]*?)<\/div>/g)]
    .map((m) => ({ start: Number(m[1]), duration: Number(m[2]), text: m[3] }));
}

/**
 * Executes the composition's runtime script the way the browser would, with a
 * stub DOM and the real GSAP. This lets a fast test observe the actual camera
 * math — easing included — without launching a render.
 */
export async function runtime(html: string) {
  const vm = await import("node:vm");
  const mod: any = await import("gsap");
  const gsap = mod.gsap ?? mod.default;

  const cameraJson = /<script type="application\/json" id="demomotion-camera">([\s\S]*?)<\/script>/.exec(html);
  if (!cameraJson) throw new Error("no camera track in generated HTML");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (scripts.length !== 1) throw new Error(`expected exactly one runtime script, found ${scripts.length}`);

  const elements: Record<string, any> = {
    cam: { style: {} as Record<string, string> },
    stage: { style: {} as Record<string, string> },
    cursor: { style: {} as Record<string, string> },
    "cursor-ring": { style: {} as Record<string, string> }
  };
  // Register every JSON data island by id, so the runtime can read any of them.
  for (const m of html.matchAll(/<script type="application\/json" id="([^"]+)">([\s\S]*?)<\/script>/g)) {
    elements[m[1]] = { textContent: m[2] };
  }
  const win: any = {};
  const context = vm.createContext({ window: win, document: { getElementById: (id: string) => elements[id] ?? null }, gsap, Math, JSON, console });
  vm.runInContext(scripts[0], context);

  return { script: scripts[0], timelines: win.__timelines as Record<string, any>, cam: elements.cam, cursor: elements.cursor, ring: elements["cursor-ring"] };
}

export function scaleOf(cam: any): number {
  const m = /scale\(([-\d.eE+]+)\)/.exec(cam.style.transform ?? "");
  if (!m) throw new Error(`no scale in transform: ${cam.style.transform}`);
  return Number(m[1]);
}

export type CaptionGroup = { id: string; start: number; duration: number; words: string[] };

/** Every caption layer in the generated HTML, with its output timing and words. */
export function captionGroups(html: string): CaptionGroup[] {
  return [...html.matchAll(/<div id="(cap-\d+)" class="cap clip"[^>]*data-start="([^"]*)"[^>]*data-duration="([^"]*)"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g)]
    .map((m) => ({
      id: m[1],
      start: Number(m[2]),
      duration: Number(m[3]),
      words: [...m[4].matchAll(/<span class="cap-w"[^>]*>([\s\S]*?)<\/span>/g)].map((w) => w[1])
    }));
}

export type CaptionTrack = {
  groups: Array<{ id: string; start: number; end: number; words: Array<{ id: string; start: number; end: number }> }>;
  idle: string; active: string; accent: string; emphasis: number;
};

/** The caption data island the runtime reads, in OUTPUT seconds. */
export function captionTrack(html: string): CaptionTrack {
  const m = /<script type="application\/json" id="demomotion-captions">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("no caption track in generated HTML");
  return JSON.parse(m[1]);
}

/** The data-track-index of every clip, in document order. */
export function clipTracks(html: string): number[] {
  return [...html.matchAll(/<video\b[^>]*>/g)].map((m) => {
    const t = /\bdata-track-index="([^"]*)"/.exec(m[0]);
    if (!t) throw new Error(`clip without a track index: ${m[0]}`);
    return Number(t[1]);
  });
}

export type Transitions = {
  crossfades: Array<{ id: string; start: number; duration: number }>;
  opening: number;
  ending: number;
  total: number;
};

/** The transition data island the runtime reads, in OUTPUT seconds. */
export function transitions(html: string): Transitions {
  const m = /<script type="application\/json" id="demomotion-transitions">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("no transition track in generated HTML");
  return JSON.parse(m[1]);
}
