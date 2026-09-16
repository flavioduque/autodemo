import {
  type DemoAction, type SourceTimeMs, type DurationMs,
  ZERO_MS, durationMs, addMs, subMs, spanMs, atSpeed, scaleMs, minOf, roundMs, captureEnd
} from "@autodemo/schema";

/**
 * WHY PER-WORD TIMESTAMPS NOW, WITH NO AUDIO AT ALL.
 *
 * Today there is no voiceover, so `words[]` is filled by `distributeWords`: a
 * deterministic synthetic distribution across the caption window, proportional
 * to token length with a floor per word. When voiceover/TTS lands, the SAME
 * field is filled from real audio alignment (whisper word timestamps) and the
 * compositor does not change a line — it already reads word windows, not a
 * paragraph. Modelling the structure once is cheaper than migrating a caption
 * track later, and it means the karaoke highlight is real from day one instead
 * of a fake even split that would have to be thrown away.
 */
export type CaptionWord = { text: string; fromMs: SourceTimeMs; toMs: SourceTimeMs };

/**
 * The floor a single word gets before proportional slack is handed out. Below
 * roughly 80-100 ms a highlight reads as a flicker rather than as a beat, so
 * short words ("a", "the") are not allowed to collapse to nothing.
 */
export const MIN_WORD_MS: DurationMs = durationMs(90);

/**
 * Splits `text` across `[fromMs, toMs)`, proportional to token length.
 *
 * Pure: no `Date.now`, no `Math.random`, no reference to anything outside its
 * arguments. Same input, same output, on any render worker.
 *
 * The last word ends exactly at `toMs` — boundaries are computed from a running
 * cumulative sum and rounded once, so rounding cannot accumulate into a caption
 * that outlives its own window.
 */
export function distributeWords(text: string, fromMs: SourceTimeMs, toMs: SourceTimeMs): CaptionWord[] {
  const tokens = text.trim().split(/\s+/).filter((t) => t.length > 0);
  const span = spanMs(toMs, fromMs);
  if (tokens.length === 0 || span <= 0) return [];

  const weights = tokens.map((t) => t.length);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  // The floor never exceeds an equal share, so a window too short for the floor
  // degrades into an equal split instead of producing inverted words.
  const floor = minOf(MIN_WORD_MS, atSpeed(span, tokens.length));
  const slack = subMs(span, scaleMs(floor, tokens.length));

  const out: CaptionWord[] = [];
  let cumulative = ZERO_MS;
  let previousBoundary = fromMs;
  for (let i = 0; i < tokens.length; i++) {
    cumulative = addMs(cumulative, addMs(floor, atSpeed(scaleMs(slack, weights[i]), totalWeight)));
    // The last boundary is pinned, not rounded: the caption ends where it says.
    // Word timings are integers by construction.
    const boundary = i === tokens.length - 1 ? toMs : roundMs(addMs(fromMs, cumulative));
    out.push({ text: tokens[i], fromMs: previousBoundary, toMs: boundary });
    previousBoundary = boundary;
  }
  return out;
}

/** A line of narration anchored in the capture's time base (sourceMs). */
export type Caption = { fromMs: SourceTimeMs; toMs: SourceTimeMs; text: string; words: CaptionWord[] };

/**
 * How long a skeleton caption stays on screen when nothing follows it soon.
 * Long enough to read a short label, short enough not to linger over the next
 * interaction.
 */
export const CAPTION_HOLD_MS: DurationMs = durationMs(2200);

/**
 * Builds a caption skeleton from the actions that carry a `label`.
 *
 * The timings are already right — each caption opens at the instant its action
 * happened and closes before the next labelled one — so the agent's remaining
 * job is to rewrite the prose, not to time it. A label is a UI phrase ("New
 * client"), not narration; that is exactly why this is a SKELETON.
 *
 * `captureDurationMs` is the capture's length; no line may outlive it.
 *
 * `holdMs` is how long a line stays up when nothing follows it: the pacing
 * presets (SKILL.md section 2, `PACING_PRESETS` in the server) each name their
 * own. Absent, it is `CAPTION_HOLD_MS`, so every existing caller is unchanged.
 */
export function buildCaptionSkeleton(actions: DemoAction[], captureDurationMs: DurationMs, holdMs: DurationMs = CAPTION_HOLD_MS): Caption[] {
  const labelled = actions
    .filter((a) => typeof a.label === "string" && a.label.trim().length > 0)
    .sort((a, b) => a.atMs - b.atMs);

  const end = captureEnd(captureDurationMs);
  const captions: Caption[] = [];
  for (let i = 0; i < labelled.length; i++) {
    const action = labelled[i];
    const next = labelled[i + 1];
    const ceiling = next ? next.atMs : end;
    const fromMs = action.atMs;
    // The ceiling is hard: a line that ran into the next one would put two
    // captions on screen at once, which is a stack, not a caption track. A
    // label whose successor arrives 400 ms later simply gets a 400 ms line.
    const toMs = minOf(addMs(fromMs, holdMs), ceiling, end);
    if (toMs <= fromMs) continue;
    const text = action.label!.trim();
    captions.push({ fromMs, toMs, text, words: distributeWords(text, fromMs, toMs) });
  }
  return captions;
}
