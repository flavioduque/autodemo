import { z } from "zod";

export const ActionSchema = z.object({
  id: z.string(),
  type: z.enum(["goto", "click", "fill", "wait", "screenshot", "scroll", "keypress"]),
  atMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative().default(0),
  label: z.string().optional(),
  selector: z.string().optional(),
  value: z.string().optional(),
  url: z.string().optional(),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  deltaX: z.number().optional(),
  deltaY: z.number().optional(),
  key: z.string().optional()
});

export const ZoomSchema = z.object({
  fromMs: z.number().nonnegative(),
  toMs: z.number().positive(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  scale: z.number().min(1).max(3).default(1.35)
});

/**
 * One kept slice of the capture, played at its own speed (spec section 3).
 *
 * Output duration of a segment is `(sourceToMs - sourceFromMs) / speed`, and the
 * cumulative sum of those durations places each segment in the output timeline.
 * Cuts are implicit: source material inside no segment was cut. There is
 * deliberately no separate `trims` field — trims and speed ramps are the same
 * structure, so a cut that has no effect on the render is impossible to express.
 */
export const EditSegmentSchema = z.object({
  sourceFromMs: z.number().nonnegative(),
  sourceToMs: z.number().positive(),
  /** 1 = normal, 2.5 = fast, 0.5 = slow motion. Never 0 or negative. */
  speed: z.number().positive().default(1)
}).refine((v) => v.sourceToMs > v.sourceFromMs, "sourceToMs must be greater than sourceFromMs");

export const CalloutSchema = z.object({
  fromMs: z.number().nonnegative(),
  toMs: z.number().positive(),
  text: z.string().min(1),
  x: z.number().min(0).max(1).default(0.5),
  y: z.number().min(0).max(1).default(0.85)
});

export const DemoProjectSchema = z.object({
  version: z.literal(1),
  title: z.string(),
  sourceVideo: z.string(),
  width: z.number().positive().default(1920),
  height: z.number().positive().default(1080),
  fps: z.number().positive().default(30),
  durationMs: z.number().positive(),
  style: z.object({
    background: z.string().default("#0b1020"),
    padding: z.number().min(0).max(300).default(56),
    radius: z.number().min(0).max(100).default(24),
    shadow: z.boolean().default(true)
  }),
  actions: z.array(ActionSchema),
  zooms: z.array(ZoomSchema).default([]),
  /** The only time-editing structure. An empty list means nothing survives. */
  editList: z.array(EditSegmentSchema),
  callouts: z.array(CalloutSchema).default([])
});

export type DemoProject = z.infer<typeof DemoProjectSchema>;
export type DemoAction = z.infer<typeof ActionSchema>;
export type DemoZoom = z.infer<typeof ZoomSchema>;
export type DemoEditSegment = z.infer<typeof EditSegmentSchema>;
