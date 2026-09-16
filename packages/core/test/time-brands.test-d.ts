/**
 * TYPE-LEVEL TEST for the branded temporal types (issue #7).
 *
 * The compiler is the test subject. This file is never executed — `node --test
 * test/*.test.ts` does not match its name — it is checked by `tsc -p
 * tsconfig.test.json`, which `pnpm typecheck` runs. Each `@ts-expect-error`
 * below names a mix-up the brands must refuse. If a brand is removed (say
 * `SourceTimeMs` becomes plain `number`), the marked line starts to compile
 * and tsc fails with "Unused '@ts-expect-error' directive" — the mutation
 * proof in the PR shows exactly that.
 *
 * Every negative half is paired with the positive half beside it: the
 * legitimate call with the right brand still compiles. A brand that refused
 * everything would pass a file of pure `@ts-expect-error`.
 */
import {
  sourceMs, outputMs, durationMs, frameIndex,
  addMs, subMs, spanMs, atSpeed, minOf, frameIndexAt, frameSourceMs, captureEnd,
  type SourceTimeMs, type OutputTimeMs, type DurationMs, type FrameIndex
} from "@autodemo/schema";
import { sourceToOutput, outputToSource, isCut, cursorAt, framingCentreAt, distributeWords, type EditSegment, type EditList } from "../src/index.ts";

const src: SourceTimeMs = sourceMs(500);
const out: OutputTimeMs = outputMs(500);
const dur: DurationMs = durationMs(100);
const frame: FrameIndex = frameIndex(15);
const LIST: EditList = [{ sourceFromMs: sourceMs(0), sourceToMs: sourceMs(1000), speed: 1 }];

// --- The bridge: each projection accepts its own base and refuses the other. --

const projected: OutputTimeMs | null = sourceToOutput(LIST, src);
const recovered: SourceTimeMs | null = outputToSource(LIST, out);
isCut(LIST, src);

// @ts-expect-error an OUTPUT instant handed to the source -> output projection
sourceToOutput(LIST, out);
// @ts-expect-error a SOURCE instant handed to the output -> source projection
outputToSource(LIST, src);
// @ts-expect-error a bare number is not an instant of either base
sourceToOutput(LIST, 500);
// @ts-expect-error a duration is not an instant
sourceToOutput(LIST, dur);
// @ts-expect-error the projection's result is on the OTHER base
const wrongBase: SourceTimeMs | null = sourceToOutput(LIST, src);

// --- EditSegment fields are source instants. ---------------------------------

const segment: EditSegment = { sourceFromMs: src, sourceToMs: sourceMs(900), speed: 1 };
// @ts-expect-error an output instant where a segment expects a source instant
const badSegment: EditSegment = { sourceFromMs: out, sourceToMs: sourceMs(900), speed: 1 };
// @ts-expect-error a bare number where a segment expects a source instant
const bareSegment: EditSegment = { sourceFromMs: 0, sourceToMs: sourceMs(900), speed: 1 };

// --- Frames are a function of SOURCE time only. ------------------------------

const f: FrameIndex = frameIndexAt(src, 30);
const back: SourceTimeMs = frameSourceMs(frame, 30);
// @ts-expect-error a frame index from an output instant
frameIndexAt(out, 30);
// @ts-expect-error a frame index from a bare number
frameIndexAt(500, 30);
// @ts-expect-error a bare number is not a frame index
frameSourceMs(15, 30);

// --- The tracks sample SOURCE time. ------------------------------------------

cursorAt([], src);
framingCentreAt([], src);
distributeWords("a b", src, sourceMs(900));
// @ts-expect-error the cursor is sampled in source time, never output time
cursorAt([], out);
// @ts-expect-error the framing camera is sampled in source time, never output time
framingCentreAt([], out);
// @ts-expect-error a caption window is two SOURCE instants
distributeWords("a b", out, outputMs(900));

// --- Arithmetic keeps the kind; mixing kinds does not compile. ----------------

const later: SourceTimeMs = addMs(src, dur);
const laterOut: OutputTimeMs = addMs(out, dur);
const earlier: SourceTimeMs = subMs(src, dur);
const span: DurationMs = spanMs(sourceMs(900), src);
const faster: DurationMs = atSpeed(dur, 2);
const first: SourceTimeMs = minOf(src, sourceMs(900));
const end: SourceTimeMs = captureEnd(dur);
// @ts-expect-error two instants do not add
addMs(src, src);
// @ts-expect-error an instant plus a duration does not change base
const crossed: OutputTimeMs = addMs(src, dur);
// @ts-expect-error a span across bases has no meaning
spanMs(out, src);
// @ts-expect-error a span of two instants is a duration, not an instant
const notInstant: SourceTimeMs = spanMs(sourceMs(900), src);
// @ts-expect-error min of mixed kinds
minOf(src, out);
// @ts-expect-error a bare number is not a duration
addMs(src, 100);

// Brands erase to numbers: the branded value still IS a number where one is wanted.
const asNumber: number = src;
const alsoNumber: number = frame;

void [projected, recovered, segment, badSegment, bareSegment, f, back, later, laterOut, earlier, span, faster, first, end, crossed, notInstant, asNumber, alsoNumber, wrongBase];
