import { DemoProjectSchema, type DemoProject } from "@demomotion/schema";

/**
 * The project behind `test/golden/native-16x9.html`.
 *
 * It is deliberately RICH — cuts, a speed ramp, two zooms, a callout, a caption
 * with word timings, three positioned actions — so the golden file covers every
 * part of the generated document, not just the camera.
 *
 * Its output frame is ABSENT, which means "output = source": the case that must
 * keep rendering exactly as it did before reframing existed.
 */
export const GOLDEN_INPUT = {
  version: 1,
  title: "Golden native",
  sourceVideo: "/abs/source.webm",
  width: 1920,
  height: 1080,
  fps: 30,
  durationMs: 10000,
  style: { background: "#0b1020", padding: 56, radius: 24, shadow: true },
  actions: [
    { id: "a1", type: "click", atMs: 1200, durationMs: 30, label: "Open the form", x: 0.82, y: 0.18 },
    { id: "a2", type: "fill", atMs: 3400, durationMs: 600, label: "Type the name", x: 0.24, y: 0.63 },
    { id: "a3", type: "click", atMs: 7200, durationMs: 30, label: "Save it", x: 0.51, y: 0.91 }
  ],
  zooms: [
    { fromMs: 1000, toMs: 2200, x: 0.82, y: 0.18, scale: 1.36 },
    { fromMs: 7000, toMs: 8400, x: 0.51, y: 0.91, scale: 1.22 }
  ],
  editList: [
    { sourceFromMs: 0, sourceToMs: 4000, speed: 1 },
    { sourceFromMs: 6000, sourceToMs: 10000, speed: 1.5 }
  ],
  callouts: [{ fromMs: 2000, toMs: 3000, text: "One form adds the client", x: 0.5, y: 0.85 }],
  captions: [
    { fromMs: 1200, toMs: 3000, text: "Open the form", words: [
      { text: "Open", fromMs: 1200, toMs: 1800 },
      { text: "the", fromMs: 1800, toMs: 2400 },
      { text: "form", fromMs: 2400, toMs: 3000 }
    ] }
  ]
} as const;

export function goldenProject(): DemoProject {
  return DemoProjectSchema.parse(GOLDEN_INPUT);
}
