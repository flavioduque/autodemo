import test from "node:test";
import assert from "node:assert/strict";
import { generateComposition } from "../src/index.ts";
import { project, stageStyle, camStyle, px, runtime, visibleSourceRect, rootAttr } from "./helpers.ts";
import type { DemoProjectInput } from "@demomotion/schema";

/**
 * A `social` cut is 9:16. The capture is 16:9. Before this existed, asking for a
 * social video produced a 16:9 file that fits no feed, because ONE width/height
 * pair was both the output size and the source aspect ratio.
 */

const SOURCE = { width: 1920, height: 1080 };
const VERTICAL = { width: 1080, height: 1920 };

/**
 * Three clicks spread across the frame, including one hard against the right
 * edge. Typed as the schema's INPUT: plain numbers that `project()` parses.
 */
const ACTIONS: DemoProjectInput["actions"] = [
  { id: "a1", type: "click", atMs: 1000, durationMs: 0, x: 0.18, y: 0.30 },
  { id: "a2", type: "fill", atMs: 4000, durationMs: 0, x: 0.72, y: 0.55 },
  { id: "a3", type: "click", atMs: 8000, durationMs: 0, x: 0.97, y: 0.88 }
];

function vertical(overrides: Record<string, unknown> = {}) {
  return generateComposition(project({
    ...SOURCE,
    output: VERTICAL,
    durationMs: 10000,
    editList: [{ sourceFromMs: 0, sourceToMs: 10000, speed: 1 }],
    actions: ACTIONS,
    // No fades, so a seek anywhere shows the camera and nothing else.
    style: { background: "#0b1020", padding: 56, radius: 24, shadow: true, openingFadeMs: 0, endingFadeMs: 0 },
    ...overrides
  } as any));
}

test("a 16:9 capture published 9:16 really is a vertical composition", () => {
  const html = vertical();

  // The composition frame is the OUTPUT frame, not the capture's.
  assert.equal(rootAttr(html, "data-width"), "1080");
  assert.equal(rootAttr(html, "data-height"), "1920");

  const s = stageStyle(html);
  const w = px(s.width);
  const h = px(s.height);
  // Hand-computed: padded frame 968 x 1808; the largest 9:16 box inside it is
  // width-constrained, w = 968, h = 968 / 0.5625 = 1720.888...
  assert.equal(w, 968);
  assert.ok(Math.abs(h - 1720.888889) < 1e-5, `expected height ~1720.888889, got ${h}`);
  assert.ok(h > w, "the stage is not portrait — the demo would still be a landscape box");
  assert.ok(h <= 1808 + 1e-9, "the stage overflows the padded frame");

  // The crop FILLS the frame: no bars. #cam holds the whole 16:9 source at the
  // size where 31.640625% of its width covers the 968 px stage.
  // Hand-computed: 968 / 0.31640625 = 3059.358024...
  const cam = camStyle(html);
  assert.ok(Math.abs(px(cam.width) - 3059.358025) < 1e-4, `#cam width ${cam.width}`);
  assert.ok(Math.abs(px(cam.height) - h) < 1e-6, "#cam is not full height — the crop would letterbox");
  // Independent of that arithmetic: whatever its size, #cam must carry the
  // SOURCE aspect ratio, or the picture inside it is stretched.
  assert.ok(Math.abs(px(cam.width) / px(cam.height) - 1920 / 1080) < 1e-9,
    `#cam is ${px(cam.width) / px(cam.height)} wide-to-tall, the capture is ${1920 / 1080}`);
  assert.ok(!/object-fit:\s*cover/.test(html));
});

test("the clicked element is inside the output frame at EVERY action", async () => {
  const html = vertical();
  const { timelines, cam } = await runtime(html);
  const tl = timelines.root;

  // Control first: the crop really is a crop. If it covered the whole width
  // there would be nothing for this test to prove.
  tl.seek(1);
  const first = visibleSourceRect(html, cam);
  assert.ok(first.width < 0.4, `the camera is not cropping at all: width ${first.width}`);

  for (const action of ACTIONS) {
    // Identity edit list, so outputMs === sourceMs.
    tl.seek(action.atMs / 1000);
    const rect = visibleSourceRect(html, cam);
    const inside = action.x! >= rect.x - 1e-9 && action.x! <= rect.x + rect.width + 1e-9
      && action.y! >= rect.y - 1e-9 && action.y! <= rect.y + rect.height + 1e-9;
    assert.ok(inside, `action ${action.id} at (${action.x}, ${action.y}) is outside the output frame ${JSON.stringify(rect)}`);
    // And not merely inside: the frame is AIMED at it. Half a crop width away
    // from the centre is the edge, so a quarter is comfortably framed.
    const offset = Math.abs(action.x! - (rect.x + rect.width / 2)) / rect.width;
    assert.ok(offset <= 0.25 + 1e-9 || rect.x === 0 || Math.abs(rect.x + rect.width - 1) < 1e-9,
      `action ${action.id} is in frame but not framed: ${offset.toFixed(3)} of the way off centre`);
  }
});

test("the crop never shows anything that is not in the capture", async () => {
  const html = vertical();
  const { timelines, cam } = await runtime(html);
  const tl = timelines.root;

  // Sampled densely, because the clamp has to hold while the camera is MOVING,
  // not only when it is parked on a keyframe.
  for (let t = 0; t <= 10; t += 0.05) {
    tl.seek(Number(t.toFixed(2)));
    const rect = visibleSourceRect(html, cam);
    assert.ok(rect.x >= -1e-9, `crop starts left of the capture at t=${t}: ${rect.x}`);
    assert.ok(rect.y >= -1e-9, `crop starts above the capture at t=${t}: ${rect.y}`);
    assert.ok(rect.x + rect.width <= 1 + 1e-9, `crop runs past the right edge at t=${t}: ${JSON.stringify(rect)}`);
    assert.ok(rect.y + rect.height <= 1 + 1e-9, `crop runs past the bottom edge at t=${t}: ${JSON.stringify(rect)}`);
  }

  // The last action sits at x = 0.97, which cannot be centred: half a crop to
  // its right is past the frame. It must clamp flush to the right edge and STILL
  // show the action. Hand-computed: origin 1 - 0.31640625 = 0.68359375.
  tl.seek(8);
  const clamped = visibleSourceRect(html, cam);
  assert.ok(Math.abs(clamped.x - 0.68359375) < 1e-6, `expected the crop flush right, got ${clamped.x}`);
  assert.ok(0.97 <= clamped.x + clamped.width + 1e-9);
});

test("the crop drifts between two actions instead of cutting from one to the other", async () => {
  const html = vertical();
  const { timelines, cam } = await runtime(html);
  const tl = timelines.root;

  tl.seek(1);
  const atFirst = visibleSourceRect(html, cam);
  tl.seek(4);
  const atSecond = visibleSourceRect(html, cam);
  // Seed: the two actions really do want different crops.
  assert.ok(atSecond.x - atFirst.x > 0.2, `the two actions frame the same place: ${atFirst.x} vs ${atSecond.x}`);

  tl.seek(2.5);
  const between = visibleSourceRect(html, cam);
  assert.ok(between.x > atFirst.x && between.x < atSecond.x,
    `the crop snapped instead of drifting: ${between.x} is not between ${atFirst.x} and ${atSecond.x}`);
  // Half-way in time is half-way in space: smoothstep is symmetric.
  assert.ok(Math.abs(between.x - (atFirst.x + atSecond.x) / 2) < 1e-6);

  // And it is monotone across the gap — no backtrack, no jitter.
  let previous = atFirst.x;
  for (let t = 1.1; t <= 4; t += 0.1) {
    tl.seek(Number(t.toFixed(2)));
    const x = visibleSourceRect(html, cam).x;
    assert.ok(x >= previous - 1e-9, `the crop moved backwards at t=${t}`);
    previous = x;
  }
});

test("the synthetic cursor follows the crop, not the raw capture", async () => {
  const html = vertical();
  const { timelines, cursor } = await runtime(html);
  const tl = timelines.root;

  // At the third action the crop is clamped flush right, covering source x in
  // [0.68359375, 1]. The cursor is at source x = 0.97, which is
  // (0.97 - 0.68359375) / 0.31640625 = 90.52...% of the way across the stage.
  tl.seek(8);
  const left = Number(/^([\d.]+)%$/.exec(cursor.style.left)![1]);
  assert.ok(Math.abs(left - 90.5185) < 1e-3, `cursor drawn at ${cursor.style.left}, expected ~90.52%`);
  // The other half: left as a raw source percentage it would sit at 97%, which
  // is the defect this maps away.
  assert.ok(Math.abs(left - 97) > 1, "the cursor is still drawn in capture coordinates");
});
