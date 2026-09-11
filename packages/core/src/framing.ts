import type { DemoAction } from "@demomotion/schema";
import { cursorTrack } from "./cursor.ts";

/**
 * REFRAMING: publishing a capture at a frame it was not recorded at.
 *
 * Spec §5 makes the camera a RECTANGLE in normalized source coordinates rather
 * than a scale plus a transform origin, precisely so that one mechanism covers
 * zoom, the `objectFit: "cover"` fix AND 16:9 -> 9:16. This module is the third
 * of those: the rectangle that decides which slice of a landscape capture a
 * vertical video actually shows.
 *
 * Reframing 1920x1080 to 1080x1920 keeps 31.6% of the width. Centring that
 * blindly would cut the product's UI in half, so the rectangle FOLLOWS THE
 * ACTION — it is driven by the normalized interaction coordinates the capture
 * already recorded, the same input `buildAutoZooms` and the cursor read.
 */

/** A normalized rectangle in the SOURCE frame. Origin is its top-left corner. */
export type CropRect = { x: number; y: number; width: number; height: number };

/** Where the reframing camera is pointed at one instant of the capture. */
export type FrameKeyframe = { sourceMs: number; x: number; y: number };

export type FrameSize = { width: number; height: number };

/**
 * The largest rectangle with the OUTPUT aspect ratio that fits inside the SOURCE
 * frame, in normalized source units.
 *
 * When the two aspects agree this is the whole frame — `{1, 1}` — so a project
 * that is not being reframed has no crop to apply and nothing changes. That is
 * not a special case in the code: it falls out of the min().
 */
export function referenceCrop(source: FrameSize, output: FrameSize): FrameSize {
  // Compared and divided as CROSS PRODUCTS, never as a ratio of two ratios: with
  // aspects written as `w/h` the identical case 1920x1080 -> 1920x1080 comes out
  // as 0.31640625000000006 instead of 0.31640625, and "the aspects agree" stops
  // being exactly expressible.
  const outputIsNarrower = output.width * source.height <= output.height * source.width;
  if (outputIsNarrower) {
    // The output is the narrower shape: keep the full height, lose width.
    return { width: Math.min(1, (source.height * output.width) / (source.width * output.height)), height: 1 };
  }
  return { width: 1, height: Math.min(1, (source.width * output.height) / (source.height * output.width)) };
}

/**
 * The points the reframing camera visits, in source order.
 *
 * Deliberately the SAME points the synthetic cursor is pinned to: whatever the
 * viewer's eye is being led to is what has to stay inside a frame that is now
 * two thirds narrower. An action with no coordinates (a `goto`, a `wait`) names
 * no place on the screen, so it is not a keyframe.
 */
export function framingTrack(actions: DemoAction[]): FrameKeyframe[] {
  return cursorTrack(actions).map((k) => ({ sourceMs: k.sourceMs, x: k.x, y: k.y }));
}

/**
 * Smoothstep. Zero derivative at BOTH ends, which is the whole reason it is used
 * here instead of a linear ramp or an ease-out: the camera leaves an action
 * slowly and arrives at the next one slowly, so it dwells on what is being
 * clicked without any dwell constant to tune.
 */
function smoothstep(u: number): number {
  return u * u * (3 - 2 * u);
}

/**
 * The centre the crop is aimed at, at one instant of the capture.
 *
 * Before the first keyframe and after the last it HOLDS that keyframe — drifting
 * towards the middle of a frame nobody is looking at would only lose the product.
 * With no keyframes at all there is nothing to follow, so it sits in the centre.
 */
export function framingCentreAt(track: FrameKeyframe[], sourceMs: number): { x: number; y: number } {
  if (track.length === 0) return { x: 0.5, y: 0.5 };
  const first = track[0];
  if (sourceMs <= first.sourceMs) return { x: first.x, y: first.y };
  const last = track[track.length - 1];
  if (sourceMs >= last.sourceMs) return { x: last.x, y: last.y };

  let i = 0;
  for (let k = 0; k < track.length; k++) {
    if (track[k].sourceMs <= sourceMs) i = k;
    else break;
  }
  const prev = track[i];
  const next = track[i + 1];
  const p = smoothstep((sourceMs - prev.sourceMs) / (next.sourceMs - prev.sourceMs));
  return { x: prev.x + (next.x - prev.x) * p, y: prev.y + (next.y - prev.y) * p };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * The reframing crop at one instant of the capture: the reference rectangle,
 * centred on the action the camera is following, SLID back inside the source
 * frame when that would hang over an edge.
 *
 * Slid, never shrunk: the rectangle keeps the output's aspect ratio and its full
 * size, so the output frame is always completely filled. A crop that shrank at
 * the edge would letterbox exactly where a target sits against the margin.
 */
export function framingRectAt(
  track: FrameKeyframe[],
  size: { source: FrameSize; output: FrameSize },
  sourceMs: number
): CropRect {
  const crop = referenceCrop(size.source, size.output);
  const centre = framingCentreAt(track, sourceMs);
  return {
    x: clamp(centre.x - crop.width / 2, 0, 1 - crop.width),
    y: clamp(centre.y - crop.height / 2, 0, 1 - crop.height),
    width: crop.width,
    height: crop.height
  };
}
