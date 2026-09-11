import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DemoProjectSchema } from "@demomotion/schema";
import { generateComposition } from "@demomotion/compositor";
import { renderCompositionHtml, telemetryEnv, videoSrcName } from "../src/render.ts";
import { fixtureSourceVideo, DURATION_SEC } from "./fixture-media.ts";
import { solidBox, describeBox, type ColorMask } from "./solid-box.ts";

const run = promisify(execFile);

/**
 * These tests launch Chrome and ffmpeg; each render takes ~30 s. Run them with:
 *
 *   DEMOMOTION_RENDER_TESTS=1 pnpm --filter @demomotion/mcp-server test
 *
 * The source clip they composite is BUILT on first use and cached under the
 * gitignored data/test-media/ — see fixture-media.ts. Nothing here depends on an
 * artefact that only exists on one machine, and nothing skips quietly if the
 * clip cannot be built: the run fails saying what is missing.
 */
const SLOW = process.env.DEMOMOTION_RENDER_TESTS === "1";
const skip = SLOW ? false : "set DEMOMOTION_RENDER_TESTS=1 to run render-level tests";
const TIMEOUT = 900_000;

/** The media really is shorter than the 10.315 s the projects below declare. */
const MEDIA_SEC = DURATION_SEC; // 9.08

/**
 * Synthetic project: the fixture clip as raw material, but times we chose. Its
 * media is 9.08 s long while the project claims 10.315 s — the same gap the real
 * capture had, and the one the black-tail trap lives in.
 */
function syntheticProject(source: string, over: Record<string, unknown> = {}) {
  return DemoProjectSchema.parse({
    version: 1,
    title: "render test",
    sourceVideo: source,
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 10315,
    style: { background: "#0b1020", padding: 56, radius: 24, shadow: true },
    actions: [],
    zooms: [],
    // The project claims 10.315 s while the media container reports 9.08 s.
    // That gap is exactly the black-tail trap.
    editList: [{ sourceFromMs: 0, sourceToMs: 10315, speed: 1 }],
    callouts: [],
    ...over
  });
}

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "demomotion-rendertest-"));
}

/** ffmpeg's own black-frame detector, over a time window of the output. */
async function blackDurations(mp4: string, fromSec: number, toSec: number): Promise<number[]> {
  const { stderr } = await run("ffmpeg", [
    "-v", "info", "-ss", String(fromSec), "-to", String(toSec), "-i", mp4,
    "-vf", "blackdetect=d=0.1:pix_th=0.10", "-f", "null", "-"
  ], { maxBuffer: 64 * 1024 * 1024 }).catch((e) => ({ stderr: String(e.stderr ?? e) }));
  return [...String(stderr).matchAll(/black_duration:([\d.]+)/g)].map((m) => Number(m[1]));
}

/**
 * The solid block of pixels close to `rgb` in one extracted frame — see
 * solid-box.ts for why it is the largest connected block and not a bounding
 * box over every match.
 */
async function markerBox(mp4: string, atSec: number, rgb: [number, number, number], width = 1920, height = 1080) {
  const mask = await colorMask(mp4, atSec, rgb, width, height);
  assert.ok(mask.count > 500, `found only ${mask.count} pixels of rgb(${rgb}) — the marker is not on screen at ${atSec}s`);
  const box = solidBox(mask);
  return { width: box.width, height: box.height, count: mask.count, detail: describeBox(box) };
}

const TL_RED: [number, number, number] = [225, 29, 72]; // .corner--tl { background: #e11d48 }
const CAPTION_ACCENT: [number, number, number] = [56, 189, 248]; // style.captionAccent #38bdf8

/**
 * Every pixel close to the caption accent colour in one extracted frame: how
 * many, and where their horizontal centre of mass is. The accent is the 2 px
 * underline under the ACTIVE word, so the centroid moving between two instants
 * is the word-by-word highlight, measured in pixels rather than in markup.
 */
async function accentPixels(mp4: string, atSec: number, width = 1920, height = 1080) {
  const { stdout } = await run("ffmpeg", [
    "-v", "error", "-ss", String(atSec), "-i", mp4, "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-"
  ], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  const buf = stdout as unknown as Buffer;
  assert.equal(buf.length, width * height * 3, "unexpected raw frame size");
  let count = 0;
  let sumX = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (Math.abs(buf[i] - CAPTION_ACCENT[0]) <= 26 && Math.abs(buf[i + 1] - CAPTION_ACCENT[1]) <= 26 && Math.abs(buf[i + 2] - CAPTION_ACCENT[2]) <= 26) {
        count++;
        sumX += x;
      }
    }
  }
  return { count, centroidX: count > 0 ? sumX / count : NaN };
}

/** One downscaled frame as raw RGB, for whole-frame comparisons. */
async function smallFrame(mp4: string, atSec: number): Promise<Buffer> {
  const { stdout } = await run("ffmpeg", [
    "-v", "error", "-ss", String(atSec), "-i", mp4, "-frames:v", "1",
    "-vf", "scale=480:270", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"
  ], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return stdout as unknown as Buffer;
}

/** One EXACT frame by index, downscaled. Time-based seeking is useless for a
 *  fade: at 30 fps, t = 0.02 s is already frame 1, a tenth of the way in. */
async function frameByIndex(mp4: string, index: number): Promise<Buffer> {
  const { stdout } = await run("ffmpeg", [
    "-v", "error", "-i", mp4, "-vf", `select='eq(n\,${index})',scale=480:270`,
    "-vsync", "0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"
  ], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  const buf = stdout as unknown as Buffer;
  assert.ok(buf.length > 0, `no frame ${index} in ${path.basename(mp4)}`);
  return buf;
}

/** The very last frame of a file, without having to know how many there are. */
async function lastFrame(mp4: string): Promise<Buffer> {
  const { stdout } = await run("ffmpeg", [
    "-v", "error", "-sseof", "-0.04", "-i", mp4, "-vf", "scale=480:270",
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"
  ], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return stdout as unknown as Buffer;
}

/** The container's own duration, read from the file rather than from a constant. */
async function mediaDurationSec(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file
  ]);
  return Number(String(stdout).trim());
}

/** Mean channel value of a frame: how bright the whole picture is. */
function meanLevel(frame: Buffer): number {
  let total = 0;
  for (let i = 0; i < frame.length; i++) total += frame[i];
  return total / frame.length;
}

/** Mean absolute per-channel difference between two frames of the same size. */
function meanAbsDiff(a: Buffer, b: Buffer): number {
  assert.equal(a.length, b.length, "frames of different sizes cannot be compared");
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

test("HYPERFRAMES_NO_TELEMETRY is set by default and an explicit operator choice is kept", () => {
  assert.equal(telemetryEnv({}).HYPERFRAMES_NO_TELEMETRY, "1");
  assert.equal(telemetryEnv({ PATH: "/x" }).HYPERFRAMES_NO_TELEMETRY, "1");
  // Half two: the operator stays in charge, even when they opt telemetry back IN.
  assert.equal(telemetryEnv({ HYPERFRAMES_NO_TELEMETRY: "0" }).HYPERFRAMES_NO_TELEMETRY, "0");
});

test("the generated composition holds its tail instead of going black", { skip, timeout: TIMEOUT }, async () => {
  const SOURCE = await fixtureSourceVideo();
  const dir = await tmpdir();
  try {
    // SEED: the trap is armed. Read from the container itself, not from the
    // constant the generator used — a source clip as long as the composition
    // would leave no uncovered tail, and every assertion below would pass for
    // the wrong reason.
    const sourceSec = await mediaDurationSec(SOURCE);
    assert.ok(Math.abs(sourceSec - MEDIA_SEC) < 0.02,
      `the source clip lasts ${sourceSec}s, expected ${MEDIA_SEC}s`);
    assert.ok(sourceSec < 10.315 - 0.5,
      `the source clip (${sourceSec}s) covers the whole 10.315 s composition — there is no tail to hold`);

    // The closing fade is switched OFF here on purpose: it darkens the last
    // frames deliberately, and blackdetect cannot tell a deliberate fade from
    // the uncovered-tail defect this test exists to catch. That the fade itself
    // works is a separate test below.
    const project = syntheticProject(SOURCE, {
      style: { background: "#0b1020", padding: 56, radius: 24, shadow: true, openingFadeMs: 0, endingFadeMs: 0 }
    });
    const videoSrc = videoSrcName(SOURCE);
    const good = path.join(dir, "good.mp4");
    await renderCompositionHtml(generateComposition(project, { videoSrc }), SOURCE, good, videoSrc);

    // Half one: the last second of the real output has no black at all.
    const tail = await blackDurations(good, 9.2, 10.3);
    assert.deepEqual(tail, [], `black detected in the tail: ${JSON.stringify(tail)}`);

    // Half two — the check is not vacuous. Reintroduce exactly the defect the
    // rule forbids (clip data-duration = MEDIA length, not composition length)
    // and prove blackdetect fires on it.
    const html = generateComposition(project, { videoSrc });
    const wrong = html.replace(/(<video[^>]*data-duration=")10\.315(")/, "$19.08$2");
    assert.notEqual(wrong, html, "failed to build the wrong-authoring control");
    const bad = path.join(dir, "bad.mp4");
    await renderCompositionHtml(wrong, SOURCE, bad, videoSrc);

    const badTail = await blackDurations(bad, 9.2, 10.3);
    assert.ok(badTail.length > 0, "blackdetect did not fire on the known-bad authoring — the assertion above proves nothing");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("corner markers come out square — the objectFit:cover crop is gone", { skip, timeout: TIMEOUT }, async () => {
  const SOURCE = await fixtureSourceVideo();
  const dir = await tmpdir();
  try {
    const project = syntheticProject(SOURCE);
    const videoSrc = videoSrcName(SOURCE);
    const html = generateComposition(project, { videoSrc });

    const good = path.join(dir, "good.mp4");
    await renderCompositionHtml(html, SOURCE, good, videoSrc);
    const box = await markerBox(good, 8.0, TL_RED);

    // The fixture draws a 128x128 marker. Whatever the scale, it must stay square.
    const ratio = box.width / box.height;
    assert.ok(Math.abs(ratio - 1) < 0.04, `top-left marker is ${box.width}x${box.height} (ratio ${ratio.toFixed(3)}) — not square (${box.detail})`);

    // Half two: prove the measurement can tell the difference. Rebuild the old
    // Remotion geometry — padded box of the WRONG aspect plus object-fit:cover —
    // and confirm the very same marker comes out visibly shorter than it is wide.
    const cropped = html
      .replaceAll("1720.888889px", "1808px")
      .replace("left:99.555556px", "left:56px")
      .replace("object-fit:contain", "object-fit:cover");
    assert.notEqual(cropped, html, "failed to build the cover-crop control");

    const bad = path.join(dir, "cover.mp4");
    await renderCompositionHtml(cropped, SOURCE, bad, videoSrc);
    const badBox = await markerBox(bad, 8.0, TL_RED);
    const badRatio = badBox.width / badBox.height;
    assert.ok(badRatio - 1 > 0.1, `cover control produced ${badBox.width}x${badBox.height} (ratio ${badRatio.toFixed(3)}) — the squareness check cannot detect the crop (${badBox.detail})`);
    process.stderr.write(`[render] square check: good ${box.width}x${box.height} (${box.detail}); cover control ${badBox.width}x${badBox.height} (${badBox.detail})\n`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("captions are on screen inside their window, absent outside it, and the highlight moves word by word",
  { skip, timeout: TIMEOUT }, async () => {
  const SOURCE = await fixtureSourceVideo();
  const dir = await tmpdir();
  try {
    // Hand-split by distributeWords over [2000, 6000): 2.000 | 2.818 | 3.454 |
    // 5.000 | 6.000 (the worked example in packages/core/test/captions.test.ts).
    const project = syntheticProject(SOURCE, {
      captions: [{
        fromMs: 2000, toMs: 6000, text: "Open the settings panel",
        words: [
          { text: "Open", fromMs: 2000, toMs: 2818 },
          { text: "the", fromMs: 2818, toMs: 3454 },
          { text: "settings", fromMs: 3454, toMs: 5000 },
          { text: "panel", fromMs: 5000, toMs: 6000 }
        ]
      }]
    });
    const videoSrc = videoSrcName(SOURCE);
    const mp4 = path.join(dir, "captions.mp4");
    await renderCompositionHtml(generateComposition(project, { videoSrc }), SOURCE, mp4, videoSrc);

    // Seed first: the caption really IS on screen, so absence can mean something.
    const first = await accentPixels(mp4, 2.3);   // "Open" is the active word
    assert.ok(first.count > 100, `the active word's accent underline is not on screen (${first.count} px)`);

    // Half one: the highlight MOVES — the same caption, a later word, and the
    // underline has travelled to the right.
    const later = await accentPixels(mp4, 5.5);   // "panel", the last word
    assert.ok(later.count > 100, `no accent underline at 5.5 s (${later.count} px)`);
    assert.ok(later.centroidX - first.centroidX > 120,
      `the highlight did not move: ${first.centroidX.toFixed(0)} px -> ${later.centroidX.toFixed(0)} px`);

    // Half two: outside its own window the caption is gone completely.
    const after = await accentPixels(mp4, 8.0);
    assert.equal(after.count, 0, `the caption leaked past its window (${after.count} accent px at 8 s)`);
    const before = await accentPixels(mp4, 1.0);
    assert.equal(before.count, 0, `the caption was on screen before its window (${before.count} accent px at 1 s)`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a crossfade at a cut really blends both sides — measured in rendered pixels",
  { skip, timeout: TIMEOUT }, async () => {
  const SOURCE = await fixtureSourceVideo();
  const dir = await tmpdir();
  try {
    // The cut lands at output 3.0 s, between two visually different states of the
    // capture: the client list (media 3 s) and the filled modal (media 7 s).
    const editList = [
      { sourceFromMs: 0, sourceToMs: 3000, speed: 1 },
      { sourceFromMs: 7000, sourceToMs: 9000, speed: 1 }
    ];
    const style = { background: "#0b1020", padding: 56, radius: 24, shadow: true, openingFadeMs: 0, endingFadeMs: 0 };
    const videoSrc = videoSrcName(SOURCE);

    const faded = path.join(dir, "faded.mp4");
    const hard = path.join(dir, "hard.mp4");
    await renderCompositionHtml(generateComposition(syntheticProject(SOURCE, { editList, style: { ...style, cutTransitionMs: 180 } }), { videoSrc }), SOURCE, faded, videoSrc);
    await renderCompositionHtml(generateComposition(syntheticProject(SOURCE, { editList, style: { ...style, cutTransitionMs: 0 } }), { videoSrc }), SOURCE, hard, videoSrc);

    // The two pure sides, taken from the HARD CUT render: at 2.91 s it is still
    // the outgoing clip, at 3.02 s it is already the incoming one.
    const outgoing = await smallFrame(hard, 2.91);
    const incoming = await smallFrame(hard, 3.02);
    const sidesDiffer = meanAbsDiff(outgoing, incoming);
    // Control: without two genuinely different pictures, "it blended" is unprovable.
    assert.ok(sidesDiffer > 2, `the two sides of the cut look the same (${sidesDiffer.toFixed(3)}) — nothing to dissolve`);

    // The same instant in the CROSSFADED render, mid-dissolve.
    const mid = await smallFrame(faded, 2.91);
    const toOutgoing = meanAbsDiff(mid, outgoing);
    const toIncoming = meanAbsDiff(mid, incoming);

    // Half one: the frame matches NEITHER pure side. This is the whole claim —
    // an overlap that HyperFrames silently dropped would leave it identical to one.
    assert.ok(toOutgoing > 0.5, `mid-dissolve frame is the outgoing side (${toOutgoing.toFixed(3)}) — nothing blended`);
    assert.ok(toIncoming > 0.5, `mid-dissolve frame is the incoming side (${toIncoming.toFixed(3)}) — nothing blended`);

    // Half two: it is not just "different", it is BETWEEN them. For a linear
    // alpha blend the two distances add up to the distance between the sides.
    const ratio = (toOutgoing + toIncoming) / sidesDiffer;
    assert.ok(ratio < 1.3, `the frame is not on the line between the two sides (sum/base = ${ratio.toFixed(3)})`);

    // And the measurement is not vacuous: run it on the composition WITHOUT the
    // transition and it reports an exact match with the outgoing side.
    const hardMid = await smallFrame(hard, 2.85);
    assert.ok(meanAbsDiff(hardMid, outgoing) < 0.5,
      "the hard-cut control does not read as a pure side, so 'matches neither side' proves nothing");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the crossfade does not reintroduce the black tail", { skip, timeout: TIMEOUT }, async () => {
  const SOURCE = await fixtureSourceVideo();
  const dir = await tmpdir();
  try {
    const videoSrc = videoSrcName(SOURCE);
    const project = syntheticProject(SOURCE, {
      style: { background: "#0b1020", padding: 56, radius: 24, shadow: true, openingFadeMs: 0, endingFadeMs: 0 },
      editList: [
        { sourceFromMs: 0, sourceToMs: 3000, speed: 1 },
        { sourceFromMs: 7000, sourceToMs: 10315, speed: 1 }
      ]
    });
    const mp4 = path.join(dir, "tail.mp4");
    await renderCompositionHtml(generateComposition(project, { videoSrc }), SOURCE, mp4, videoSrc);

    // Total output is 3000 + 3315 = 6315 ms, unchanged by the 180 ms crossfade:
    // the transition borrows material, it does not shorten the timeline.
    // The last second must hold picture — except the deliberate closing fade,
    // which is switched off here so black can only mean the old defect.
    const tail = await blackDurations(mp4, 5.2, 6.3);
    assert.deepEqual(tail, [], `black detected in the tail with transitions on: ${JSON.stringify(tail)}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the composition opens and closes on the background colour", { skip, timeout: TIMEOUT }, async () => {
  const SOURCE = await fixtureSourceVideo();
  const dir = await tmpdir();
  try {
    const videoSrc = videoSrcName(SOURCE);
    const faded = path.join(dir, "fades.mp4");
    const plain = path.join(dir, "nofade.mp4");
    await renderCompositionHtml(generateComposition(syntheticProject(SOURCE), { videoSrc }), SOURCE, faded, videoSrc);
    await renderCompositionHtml(generateComposition(syntheticProject(SOURCE, {
      style: { background: "#0b1020", padding: 56, radius: 24, shadow: true, openingFadeMs: 0, endingFadeMs: 0 }
    }), { videoSrc }), SOURCE, plain, videoSrc);

    // Control, seeded first: with the fades OFF the very first and very last
    // frames are picture. Without this, "dark at the ends" would prove nothing —
    // it could just be a composition that never showed anything.
    const plainFirst = meanLevel(await frameByIndex(plain, 0));
    const plainLast = meanLevel(await lastFrame(plain));
    assert.ok(plainFirst > 60, `with the fade off the first frame is already dark (${plainFirst.toFixed(1)})`);
    assert.ok(plainLast > 60, `with the fade off the last frame is already dark (${plainLast.toFixed(1)})`);

    // Half one: the first frame is the background colour. #0b1020 is
    // rgb(11,16,32), so a full-opacity fade has a mean of (11+16+32)/3 = 19.7 —
    // a literal from the style, not a number the code told us.
    const fadedFirst = meanLevel(await frameByIndex(faded, 0));
    assert.ok(fadedFirst < 30, `the opening does not start on the background (mean ${fadedFirst.toFixed(1)}, expected about 19.7)`);

    // ...and it opens UP from there: the fade is a ramp, not a stuck overlay.
    const early = meanLevel(await frameByIndex(faded, 2));
    const open = meanLevel(await frameByIndex(faded, 12)); // 400 ms in, past the 320 ms fade
    assert.ok(fadedFirst < early && early < open, `the opening fade is not a ramp: ${fadedFirst.toFixed(1)} -> ${early.toFixed(1)} -> ${open.toFixed(1)}`);
    assert.ok(Math.abs(open - plainFirst) / plainFirst < 0.9, "the picture never arrives after the opening fade");

    // Half two: the ending fade takes the last frame back down to the background.
    const fadedLast = meanLevel(await lastFrame(faded));
    assert.ok(fadedLast < plainLast * 0.4,
      `the closing fade did not darken the last frame (${fadedLast.toFixed(1)} vs ${plainLast.toFixed(1)} with the fade off)`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Reframing, measured in rendered pixels.
//
// The fixture scene puts an EXACTLY 128x128 marker flush in each corner of the
// 1920x1080 frame, in four known colours. That makes "which slice of the capture
// did the vertical cut keep" answerable from the output file alone: the markers
// on the side the crop kept are on screen, the ones on the side it dropped are
// not, and the kept ones must still be square.
// ---------------------------------------------------------------------------

/** Every pixel of one extracted frame that is close to `rgb`, as a mask. */
async function colorMask(mp4: string, atSec: number, rgb: [number, number, number], width: number, height: number): Promise<ColorMask> {
  const { stdout } = await run("ffmpeg", [
    "-v", "error", "-ss", String(atSec), "-i", mp4, "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-"
  ], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  const buf = stdout as unknown as Buffer;
  assert.equal(buf.length, width * height * 3, "unexpected raw frame size");
  const data = new Uint8Array(width * height);
  let count = 0;
  for (let p = 0; p < data.length; p++) {
    const i = p * 3;
    if (Math.abs(buf[i] - rgb[0]) <= 28 && Math.abs(buf[i + 1] - rgb[1]) <= 28 && Math.abs(buf[i + 2] - rgb[2]) <= 28) {
      count++;
      data[p] = 1;
    }
  }
  return { width, height, data, count };
}

async function frameSize(mp4: string) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", mp4
  ]);
  const stream = JSON.parse(stdout).streams[0];
  return { width: Number(stream.width), height: Number(stream.height) };
}

const TR_GREEN: [number, number, number] = [22, 163, 74];  // .corner--tr { background: #16a34a }

test("a 16:9 capture published 9:16 is vertical, and keeps the side the action is on",
  { skip, timeout: TIMEOUT }, async () => {
  const source = await fixtureSourceVideo();
  const dir = await tmpdir();
  try {
    // One interaction, on the TOP-RIGHT marker: its centre is 64 px in from the
    // right and 64 px down, i.e. (1856/1920, 64/1080) of the capture. Everything
    // below follows from that single literal.
    const action = { id: "a1", type: "click", atMs: 2000, durationMs: 30, x: 1856 / 1920, y: 64 / 1080 };
    const common = {
      durationMs: 8000,
      editList: [{ sourceFromMs: 0, sourceToMs: 8000, speed: 1 }],
      actions: [action]
    };

    // The control render: the SAME project at its native frame. It is what tells
    // us the markers are visible at all, so "the red one is gone" is a finding
    // and not an artefact of a black frame or a failed render.
    const native = syntheticProject(source, common);
    const nativePath = path.join(dir, "native.mp4");
    await renderCompositionHtml(generateComposition(native, { videoSrc: videoSrcName(source) }), source, nativePath, videoSrcName(source));

    assert.deepEqual(await frameSize(nativePath), { width: 1920, height: 1080 });
    const nativeRed = (await colorMask(nativePath, 2, TL_RED, 1920, 1080)).count;
    const nativeGreen = (await colorMask(nativePath, 2, TR_GREEN, 1920, 1080)).count;
    assert.ok(nativeRed > 2000, `the control render does not show the left marker at all (${nativeRed} px)`);
    assert.ok(nativeGreen > 2000, `the control render does not show the right marker at all (${nativeGreen} px)`);

    // The vertical render: same capture, same actions, one new field.
    const vertical = syntheticProject(source, { ...common, output: { width: 1080, height: 1920 } });
    const verticalPath = path.join(dir, "vertical.mp4");
    await renderCompositionHtml(generateComposition(vertical, { videoSrc: videoSrcName(source) }), source, verticalPath, videoSrcName(source));

    // Half one: the file really is a vertical video.
    assert.deepEqual(await frameSize(verticalPath), { width: 1080, height: 1920 });

    // Half two: the crop followed the action. The click is against the right
    // edge, so the crop clamps flush right and covers source x in
    // [0.68359375, 1] — the green marker is inside it, the red one is not.
    const verticalMask = await colorMask(verticalPath, 2, TR_GREEN, 1080, 1920);
    const verticalRed = (await colorMask(verticalPath, 2, TL_RED, 1080, 1920)).count;
    assert.ok(verticalMask.count > 2000, `the clicked corner is not in the vertical frame (${verticalMask.count} px)`);
    assert.ok(verticalRed < nativeRed * 0.02,
      `the vertical cut still shows the far side of the capture (${verticalRed} px, control ${nativeRed})`);

    // Half three: what survived is not stretched. The marker's coloured fill is
    // 128 - 2*6 = 116 source px, and the crop magnifies the width by
    // 968 / (0.31640625 * 1920) = 1.5934, so it lands as a 184.8 px SQUARE. A
    // crop that stretched instead of magnifying would still pass every count
    // above and fail here.
    const marker = solidBox(verticalMask);
    const ratio = marker.width / marker.height;
    assert.ok(Math.abs(ratio - 1) < 0.04, `the reframed marker is ${marker.width}x${marker.height} — not square (${describeBox(marker)})`);
    assert.ok(Math.abs(marker.width - 185) <= 4, `expected a ~185 px marker, got ${marker.width} (${describeBox(marker)})`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
