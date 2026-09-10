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

const run = promisify(execFile);

/**
 * These tests launch Chrome and ffmpeg; each render takes ~30 s. Run them with:
 *
 *   DEMOMOTION_RENDER_TESTS=1 pnpm --filter @demomotion/mcp-server test
 */
const SLOW = process.env.DEMOMOTION_RENDER_TESTS === "1";
const skip = SLOW ? false : "set DEMOMOTION_RENDER_TESTS=1 to run render-level tests";
const TIMEOUT = 900_000;

const REPO = path.resolve(import.meta.dirname, "../../..");
const SOURCE = path.join(REPO, "data/sessions/3fdaf0eb-ba56-409e-a092-5aa66cfdd05b/page@985b00a54e058ef4cd1c85af81850c9e.webm");

/**
 * Synthetic project: the real capture as raw material, but times we chose. The
 * capture layer has a known ~2.1 s manifest/video offset that is not the
 * compositor's business, so no test here depends on manifest timestamps.
 */
function syntheticProject(over: Record<string, unknown> = {}) {
  return DemoProjectSchema.parse({
    version: 1,
    title: "render test",
    sourceVideo: SOURCE,
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 10315,
    style: { background: "#0b1020", padding: 56, radius: 24, shadow: true },
    actions: [],
    zooms: [],
    // The capture manifest claims 10.315 s while the media container reports
    // 9.08 s. That gap is exactly the black-tail trap.
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

/** Bounding box of every pixel close to `rgb` in one extracted frame. */
async function markerBox(mp4: string, atSec: number, rgb: [number, number, number], width = 1920, height = 1080) {
  const { stdout } = await run("ffmpeg", [
    "-v", "error", "-ss", String(atSec), "-i", mp4, "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-"
  ], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  const buf = stdout as unknown as Buffer;
  assert.equal(buf.length, width * height * 3, "unexpected raw frame size");

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (Math.abs(buf[i] - rgb[0]) <= 28 && Math.abs(buf[i + 1] - rgb[1]) <= 28 && Math.abs(buf[i + 2] - rgb[2]) <= 28) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  assert.ok(count > 500, `found only ${count} pixels of rgb(${rgb}) — the marker is not on screen at ${atSec}s`);
  return { width: maxX - minX + 1, height: maxY - minY + 1, count };
}

const TL_RED: [number, number, number] = [225, 29, 72]; // .corner--tl { background: #e11d48 }

test("HYPERFRAMES_NO_TELEMETRY is set by default and an explicit operator choice is kept", () => {
  assert.equal(telemetryEnv({}).HYPERFRAMES_NO_TELEMETRY, "1");
  assert.equal(telemetryEnv({ PATH: "/x" }).HYPERFRAMES_NO_TELEMETRY, "1");
  // Half two: the operator stays in charge, even when they opt telemetry back IN.
  assert.equal(telemetryEnv({ HYPERFRAMES_NO_TELEMETRY: "0" }).HYPERFRAMES_NO_TELEMETRY, "0");
});

test("the generated composition holds its tail instead of going black", { skip, timeout: TIMEOUT }, async () => {
  const dir = await tmpdir();
  try {
    const project = syntheticProject();
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
  const dir = await tmpdir();
  try {
    const project = syntheticProject();
    const videoSrc = videoSrcName(SOURCE);
    const html = generateComposition(project, { videoSrc });

    const good = path.join(dir, "good.mp4");
    await renderCompositionHtml(html, SOURCE, good, videoSrc);
    const box = await markerBox(good, 8.0, TL_RED);

    // The fixture draws a 128x128 marker. Whatever the scale, it must stay square.
    const ratio = box.width / box.height;
    assert.ok(Math.abs(ratio - 1) < 0.04, `top-left marker is ${box.width}x${box.height} (ratio ${ratio.toFixed(3)}) — not square`);

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
    assert.ok(badRatio - 1 > 0.1, `cover control produced ${badBox.width}x${badBox.height} (ratio ${badRatio.toFixed(3)}) — the squareness check cannot detect the crop`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
