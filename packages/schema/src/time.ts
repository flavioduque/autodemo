/**
 * Branded temporal types (spec §3, issue #7).
 *
 * The central distinction of this codebase is between two time bases:
 *
 *   - `SourceTimeMs` — an instant in the raw capture. Immutable: it describes
 *     what happened. Actions, zooms, callouts and captions are anchored here.
 *   - `OutputTimeMs` — an instant in the rendered video. Changes whenever the
 *     edit list changes. Clip placement and every emitted `data-start` live here.
 *
 * plus `DurationMs` (a length of time, valid on either base — a 300 ms hold is
 * 300 ms whichever clock it is measured on) and `FrameIndex` (a slot on the
 * constant-fps grid of the capture).
 *
 * All four were a bare `number` before. Mixing them up does not fail: the video
 * comes out ALMOST right — a caption a cut too late, a zoom on the wrong
 * instant — which is the most expensive class of bug this project can have. A
 * brand makes the compiler refuse the mix-up.
 *
 * Brands are compile-time only. Every function here erases to the arithmetic
 * it names (`addMs(t, d)` is `t + d`), so nothing in a rendered document can
 * change because of this module — the frozen golden composition proves it.
 *
 * INGRESS DISCIPLINE. A brand is worthless if `as SourceTimeMs` is sprinkled
 * wherever the compiler complains. So: the four constructors below hold the
 * only `as` casts in the codebase, and they are called only where a value
 * genuinely ENTERS the branded world — the zod parse of project.json, the
 * capture adapter's clock, literal constants, and test fixtures. Domain code
 * (core, compositor) never constructs a brand: it derives one from another
 * through the helpers here.
 */

type Brand<T, N extends string> = T & { readonly __brand: N };

/** An instant of the capture. `t = 0` is the first captured frame. */
export type SourceTimeMs = Brand<number, "SourceTimeMs">;

/** An instant of the rendered video. `t = 0` is its first frame. */
export type OutputTimeMs = Brand<number, "OutputTimeMs">;

/** A length of time. Not anchored to either base. */
export type DurationMs = Brand<number, "DurationMs">;

/** A slot on the capture's constant-fps grid: frame `i` is `sourceMs = i / fps * 1000`. */
export type FrameIndex = Brand<number, "FrameIndex">;

// ---------------------------------------------------------------------------
// Constructors: the ONLY casts. Call them at an ingress point, never to
// silence the compiler in the middle of domain code.
// ---------------------------------------------------------------------------

export function sourceMs(n: number): SourceTimeMs {
  return n as SourceTimeMs;
}

export function outputMs(n: number): OutputTimeMs {
  return n as OutputTimeMs;
}

export function durationMs(n: number): DurationMs {
  return n as DurationMs;
}

export function frameIndex(n: number): FrameIndex {
  return n as FrameIndex;
}

/**
 * The origins. Each base starts at zero BY DEFINITION (the adapter contract
 * puts the first captured frame at source 0; the output starts at its first
 * frame), so these are not ingress points — they are the definition of the
 * bases, and the reason domain code never needs a constructor for "the start".
 */
export const SOURCE_ZERO: SourceTimeMs = sourceMs(0);
export const OUTPUT_ZERO: OutputTimeMs = outputMs(0);
export const ZERO_MS: DurationMs = durationMs(0);

// ---------------------------------------------------------------------------
// Arithmetic. Plain `+` on two brands degrades to `number` in TypeScript, so
// the hot paths use these instead; each one erases to the operator it names.
// The implementation signatures are plain numbers — no cast anywhere below.
//
// Comparisons (`<`, `>=`) are NOT wrapped: they work on brands as they are, and
// a comparison across bases is caught by the type of whatever the result is
// assigned to or passed into, which is where the mix-up would have become a
// wrong frame.
// ---------------------------------------------------------------------------

/** instant + duration → instant on the same base; duration + duration → duration. */
export function addMs(t: SourceTimeMs, d: DurationMs): SourceTimeMs;
export function addMs(t: OutputTimeMs, d: DurationMs): OutputTimeMs;
export function addMs(t: DurationMs, d: DurationMs): DurationMs;
export function addMs(t: number, d: number): number {
  return t + d;
}

/** instant − duration → instant on the same base; duration − duration → duration. */
export function subMs(t: SourceTimeMs, d: DurationMs): SourceTimeMs;
export function subMs(t: OutputTimeMs, d: DurationMs): OutputTimeMs;
export function subMs(t: DurationMs, d: DurationMs): DurationMs;
export function subMs(t: number, d: number): number {
  return t - d;
}

/** instant − instant, SAME base → duration. `to - from`; negative when `to` precedes `from`. */
export function spanMs(to: SourceTimeMs, from: SourceTimeMs): DurationMs;
export function spanMs(to: OutputTimeMs, from: OutputTimeMs): DurationMs;
export function spanMs(to: number, from: number): number {
  return to - from;
}

/** A duration played at `speed`: `d / speed`. 2 = twice as fast, so half as long. */
export function atSpeed(d: DurationMs, speed: number): DurationMs;
export function atSpeed(d: number, speed: number): number {
  return d / speed;
}

/** A duration multiplied by a dimensionless factor: `d * factor`. */
export function scaleMs(d: DurationMs, factor: number): DurationMs;
export function scaleMs(d: number, factor: number): number {
  return d * factor;
}

/** `Math.min` over values of ONE kind. Mixed kinds do not compile. */
export function minOf(...values: SourceTimeMs[]): SourceTimeMs;
export function minOf(...values: OutputTimeMs[]): OutputTimeMs;
export function minOf(...values: DurationMs[]): DurationMs;
export function minOf(...values: number[]): number {
  return Math.min(...values);
}

/** `Math.max` over values of ONE kind. Mixed kinds do not compile. */
export function maxOf(...values: SourceTimeMs[]): SourceTimeMs;
export function maxOf(...values: OutputTimeMs[]): OutputTimeMs;
export function maxOf(...values: DurationMs[]): DurationMs;
export function maxOf(...values: number[]): number {
  return Math.max(...values);
}

/** `Math.round`, keeping the kind. */
export function roundMs(t: SourceTimeMs): SourceTimeMs;
export function roundMs(t: OutputTimeMs): OutputTimeMs;
export function roundMs(t: DurationMs): DurationMs;
export function roundMs(t: number): number {
  return Math.round(t);
}

// ---------------------------------------------------------------------------
// A length measured from a base's origin is also that base's exclusive end.
// The capture's `durationMs` is both "how long it is" and "the first source
// instant that no longer exists"; the edit list's total is both the video's
// length and where its last clip ends. These name that reading.
// ---------------------------------------------------------------------------

/** The exclusive end of a capture of this length, in source time. */
export function captureEnd(length: DurationMs): SourceTimeMs {
  return addMs(SOURCE_ZERO, length);
}

/** The exclusive end of a video of this length, in output time. */
export function outputEnd(length: DurationMs): OutputTimeMs {
  return addMs(OUTPUT_ZERO, length);
}

// ---------------------------------------------------------------------------
// Frames. The capture adapter's invariant (capture-adapter.ts): output frame
// `i` of the constant-fps artifact is exactly `sourceMs = i / fps * 1000`, so
// the two directions below are exact with no calibration and no offset. Only
// SOURCE time has frames on this grid — the rendered video's frames are the
// renderer's business — which is why `frameIndexAt` refuses an output instant.
// ---------------------------------------------------------------------------

/** The grid frame that shows source instant `t`: `round(t / 1000 * fps)`. */
export function frameIndexAt(t: SourceTimeMs, fps: number): FrameIndex {
  return frameIndex(Math.round((t / 1000) * fps));
}

/** The source instant grid frame `i` stands for: `i / fps * 1000`. */
export function frameSourceMs(i: FrameIndex, fps: number): SourceTimeMs {
  return sourceMs((i / fps) * 1000);
}
