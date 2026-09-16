import * as z from "zod/v4";

// Input fragments shared by more than one tool. The MCP surface is built with
// its own zod instance, so these restate the matching schemas of
// @autodemo/schema rather than importing them.

/**
 * One kept slice of the capture, played at its own speed (spec section 3).
 * Cuts are implicit: source material inside no segment was cut. This mirrors
 * EditSegmentSchema in @autodemo/schema.
 */
export const editSegmentInput = z.object({
  sourceFromMs: z.number().nonnegative(),
  sourceToMs: z.number().positive(),
  speed: z.number().positive().default(1)
}).refine((v) => v.sourceToMs > v.sourceFromMs, "sourceToMs must be greater than sourceFromMs");

/** One word of narration, in the capture's time base. */
export const captionWordInput = z.object({
  text: z.string().min(1),
  fromMs: z.number().nonnegative(),
  toMs: z.number().positive()
}).refine((v) => v.toMs > v.fromMs, "toMs must be greater than fromMs");

export const captionInput = z.object({
  fromMs: z.number().nonnegative(),
  toMs: z.number().positive(),
  text: z.string().min(1),
  words: z.array(captionWordInput).default([])
}).refine((v) => v.toMs > v.fromMs, "toMs must be greater than fromMs");

/** The frame a video is published at; the bounds `project_update` enforces. */
export const outputFrameInput = z.object({
  width: z.number().int().min(640).max(3840),
  height: z.number().int().min(480).max(3840)
});
