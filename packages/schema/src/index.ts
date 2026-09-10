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

export const TrimSchema = z.object({
  fromMs: z.number().nonnegative(),
  toMs: z.number().positive()
}).refine((v) => v.toMs > v.fromMs, "toMs must be greater than fromMs");

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
  trims: z.array(TrimSchema).default([]),
  callouts: z.array(CalloutSchema).default([])
});

export type DemoProject = z.infer<typeof DemoProjectSchema>;
export type DemoAction = z.infer<typeof ActionSchema>;
export type DemoZoom = z.infer<typeof ZoomSchema>;
