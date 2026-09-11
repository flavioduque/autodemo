import {
  type SourceTimeMs, type OutputTimeMs, type DurationMs,
  OUTPUT_ZERO, ZERO_MS, addMs, spanMs, atSpeed, scaleMs
} from "@demomotion/schema";

/**
 * The bridge between the two time bases (spec §3).
 *
 * - `SourceTimeMs` — time in the raw capture. Immutable: it describes what happened.
 * - `OutputTimeMs` — time in the final video. Changes whenever the edit changes.
 *
 * The two are different TYPES, not two names for `number`: `sourceToOutput`
 * refuses an output instant and `outputToSource` refuses a source one, which is
 * the whole reason the brands exist (issue #7).
 *
 * An EditList is an ordered list of source intervals, each played at its own
 * speed. Cuts are implicit: source material inside no segment was cut. There is
 * deliberately no separate `trims` field — trims and speed ramps collapse into
 * this single structure.
 *
 * Intervals are half-open on BOTH bases: `[fromMs, toMs)`. The instant exactly
 * at `sourceFromMs` belongs to the segment; the instant exactly at `sourceToMs`
 * does not. Same for output.
 */
export type EditSegment = {
  sourceFromMs: SourceTimeMs;
  sourceToMs: SourceTimeMs;
  /** 1 = normal, 2.5 = fast, 0.5 = slow motion. */
  speed: number;
};

export type EditList = EditSegment[];

/** Output duration of a single segment: source span compressed by its speed. */
function segmentOutputMs(segment: EditSegment): DurationMs {
  return atSpeed(spanMs(segment.sourceToMs, segment.sourceFromMs), segment.speed);
}

/** Duration of the final video: the sum of every segment's output duration. */
export function totalOutputMs(list: EditList): DurationMs {
  let total = ZERO_MS;
  for (const segment of list) total = addMs(total, segmentOutputMs(segment));
  return total;
}

/** A segment together with where it lands in the output time base. */
type PlacedSegment = EditSegment & { outputFromMs: OutputTimeMs; outputToMs: OutputTimeMs };

/** Walks the list once, assigning each segment its cumulative output position. */
function place(list: EditList): PlacedSegment[] {
  const placed: PlacedSegment[] = [];
  let outputFromMs = OUTPUT_ZERO;
  for (const segment of list) {
    const outputToMs = addMs(outputFromMs, segmentOutputMs(segment));
    placed.push({ ...segment, outputFromMs, outputToMs });
    outputFromMs = outputToMs;
  }
  return placed;
}

/**
 * Projects an instant of the final video back onto the capture.
 * Returns null when `outputMs` falls outside the whole list.
 */
export function outputToSource(list: EditList, outputMs: OutputTimeMs): SourceTimeMs | null {
  for (const segment of place(list)) {
    if (outputMs >= segment.outputFromMs && outputMs < segment.outputToMs) {
      return addMs(segment.sourceFromMs, scaleMs(spanMs(outputMs, segment.outputFromMs), segment.speed));
    }
  }
  return null;
}

/**
 * Projects an instant of the capture onto the final video.
 * Returns null when that instant was CUT — it falls in no segment at all.
 */
export function sourceToOutput(list: EditList, sourceMs: SourceTimeMs): OutputTimeMs | null {
  for (const segment of place(list)) {
    if (sourceMs >= segment.sourceFromMs && sourceMs < segment.sourceToMs) {
      return addMs(segment.outputFromMs, atSpeed(spanMs(sourceMs, segment.sourceFromMs), segment.speed));
    }
  }
  return null;
}

/** True when this capture instant survives in no segment — it was cut. */
export function isCut(list: EditList, sourceMs: SourceTimeMs): boolean {
  return sourceToOutput(list, sourceMs) === null;
}
