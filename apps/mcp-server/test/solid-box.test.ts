import test from "node:test";
import assert from "node:assert/strict";
import { solidBox, type ColorMask } from "./solid-box.ts";

// ---------------------------------------------------------------------------
// The marker measurement the render tests use, exercised on synthetic masks
// in the DEFAULT suite: no browser, no ffmpeg, runs on every CI job.
//
// The geometry below is the vertical (9:16) render's, from render.test.ts: a
// 1080x1920 frame whose green marker lands as a ~185 px square at the top
// right of the stage. The numbers are literals, chosen by hand, so the test
// cannot agree with the measurement by construction.
// ---------------------------------------------------------------------------

const W = 1080;
const H = 1920;
const MARKER = { left: 880, top: 110, width: 185, height: 185 };

function emptyMask(): ColorMask {
  return { width: W, height: H, data: new Uint8Array(W * H), count: 0 };
}

function set(mask: ColorMask, x: number, y: number) {
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) throw new RangeError(`(${x},${y}) is outside the ${mask.width}x${mask.height} frame`);
  const i = y * mask.width + x;
  if (!mask.data[i]) {
    mask.data[i] = 1;
    mask.count++;
  }
}

function fillRect(mask: ColorMask, left: number, top: number, width: number, height: number) {
  for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) set(mask, x, y);
}

function clearRect(mask: ColorMask, left: number, top: number, width: number, height: number) {
  for (let y = top; y < top + height; y++) {
    for (let x = left; x < left + width; x++) {
      const i = y * mask.width + x;
      if (mask.data[i]) {
        mask.data[i] = 0;
        mask.count--;
      }
    }
  }
}

/** The marker as the fixture draws it: a solid square with the white "TR" glyphs knocked out of its middle. */
function markerMask(): ColorMask {
  const mask = emptyMask();
  fillRect(mask, MARKER.left, MARKER.top, MARKER.width, MARKER.height);
  // Two 5x7 glyphs at 8 px cells, scaled by the crop: ~64 px wide, ~90 px tall,
  // each stroke a separate hole. The fill stays connected around them.
  const gx = MARKER.left + 30;
  const gy = MARKER.top + 48;
  clearRect(mask, gx, gy, 64, 13);           // T: top bar
  clearRect(mask, gx + 26, gy + 13, 13, 77); // T: stem
  clearRect(mask, gx + 76, gy, 13, 90);      // R: stem
  clearRect(mask, gx + 89, gy, 40, 13);      // R: top
  clearRect(mask, gx + 89, gy + 38, 40, 13); // R: middle
  clearRect(mask, gx + 116, gy + 13, 13, 25); // R: bowl
  clearRect(mask, gx + 116, gy + 51, 13, 39); // R: leg
  return mask;
}

test("a solid marker with text knocked out of it is measured to the pixel", () => {
  const box = solidBox(markerMask());
  assert.deepEqual({ width: box.width, height: box.height }, { width: MARKER.width, height: MARKER.height });
});

test("sparse matching pixels that share the marker's rows do not widen it — the Linux CI shape", () => {
  // What ubuntu-latest produced (run 34604186469): height right at 184, width
  // 908. That is columns far to the left of the marker each carrying a few
  // dozen matches INSIDE the marker's rows — isolated pixels, none adjacent to
  // another or to the marker, in 720 columns.
  const mask = markerMask();
  const before = mask.count;
  for (let x = MARKER.left - 725; x < MARKER.left - 5; x += 1) {
    // 25 pixels per column, 7 rows apart, staggered so no two are 4-adjacent.
    for (let k = 0; k < 25; k++) set(mask, x, MARKER.top + 2 + ((k * 7 + x * 3) % (MARKER.height - 4)));
  }
  assert.ok(mask.count - before >= 720 * 20, `the noise is not dense enough to fool a per-column floor (${mask.count - before} px)`);
  const box = solidBox(mask);
  assert.deepEqual({ width: box.width, height: box.height }, { width: MARKER.width, height: MARKER.height },
    `noise in the marker's rows widened it to ${box.width}x${box.height}`);
});

test("a stretched marker still reads as stretched — the measurement can fail", () => {
  // The negative half: what a crop that stretched instead of magnifying would
  // leave. If this were square the squareness assertion would be vacuous.
  const mask = emptyMask();
  fillRect(mask, 600, MARKER.top, 295, 185);
  const box = solidBox(mask);
  assert.equal(box.width, 295);
  assert.equal(box.height, 185);
  assert.ok(box.width / box.height > 1.5);
});
