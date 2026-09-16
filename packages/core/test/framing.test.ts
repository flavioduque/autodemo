import test from "node:test";
import assert from "node:assert/strict";
import { type DemoAction, sourceMs, SOURCE_ZERO, ZERO_MS } from "@autodemo/schema";
import { referenceCrop, framingTrack, framingCentreAt, framingRectAt } from "../src/index.ts";

/**
 * Reframing 16:9 -> 9:16 throws away 68% of the width, so WHERE the crop sits
 * is the whole quality of the result. The crop is driven by the same normalized
 * interaction coordinates the auto-zoom and the cursor already use.
 */

const action = (id: string, atMs: number, x: number, y: number, type: DemoAction["type"] = "click"): DemoAction => ({
  id, type, atMs: sourceMs(atMs), durationMs: ZERO_MS, x, y
});

const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };

test("the reference crop is the largest rectangle of the OUTPUT aspect inside the SOURCE frame", () => {
  // Hand-computed: output aspect 1080/1920 = 0.5625; the source is 1.7777...
  // wide, so the crop is full height and 1080 * 0.5625 = 607.5 px wide, i.e.
  // 607.5 / 1920 = 0.31640625 of the width.
  const vertical = referenceCrop(LANDSCAPE, PORTRAIT);
  assert.equal(vertical.width, 0.31640625);
  assert.equal(vertical.height, 1);

  // The mirror case: a portrait capture published wide keeps its full width and
  // loses height, by the same fraction.
  const wide = referenceCrop(PORTRAIT, LANDSCAPE);
  assert.equal(wide.width, 1);
  assert.equal(wide.height, 0.31640625);

  // The other half — and the one that keeps every existing project intact: when
  // the aspects agree there is NO crop at all, whatever the pixel sizes are.
  assert.deepEqual(referenceCrop(LANDSCAPE, LANDSCAPE), { width: 1, height: 1 });
  assert.deepEqual(referenceCrop(LANDSCAPE, { width: 3840, height: 2160 }), { width: 1, height: 1 });
});

test("the framing track is one keyframe per positioned interaction, in source order", () => {
  const track = framingTrack([
    action("a3", 7200, 0.51, 0.91),
    action("a1", 1200, 0.82, 0.18),
    { id: "nav", type: "goto", atMs: SOURCE_ZERO, durationMs: ZERO_MS, url: "https://example.test" },
    action("a2", 3400, 0.24, 0.63, "fill")
  ]);

  // Positive half: every interaction that HAS coordinates is a keyframe, sorted.
  assert.deepEqual(track, [
    { sourceMs: 1200, x: 0.82, y: 0.18 },
    { sourceMs: 3400, x: 0.24, y: 0.63 },
    { sourceMs: 7200, x: 0.51, y: 0.91 }
  ]);
  // Negative half: an action with no coordinates points the camera nowhere, so
  // it is not a keyframe. A `goto` is not a place on the screen.
  assert.equal(track.some((k) => k.sourceMs === 0), false);
});

test("the crop centre eases between actions instead of snapping to one of them", () => {
  const track = framingTrack([action("a", 1000, 0.2, 0.1), action("b", 3000, 0.8, 0.9)]);

  // At each action instant the centre IS that action: the element being clicked
  // is dead centre when it is clicked.
  assert.deepEqual(framingCentreAt(track, sourceMs(1000)), { x: 0.2, y: 0.1 });
  assert.deepEqual(framingCentreAt(track, sourceMs(3000)), { x: 0.8, y: 0.9 });

  // Half-way between them the centre is half-way between them — strictly inside
  // the open interval, which is what "moves smoothly" means and what snapping
  // to either endpoint would violate.
  const mid = framingCentreAt(track, sourceMs(2000));
  assert.equal(mid.x, 0.5);
  assert.equal(mid.y, 0.5);
  assert.ok(mid.x > 0.2 && mid.x < 0.8, `crop centre snapped to an endpoint: ${mid.x}`);

  // A quarter of the way in, hand-computed from smoothstep 3u^2 - 2u^3 at
  // u = 0.25: 3*0.0625 - 2*0.015625 = 0.15625, so x = 0.2 + 0.6*0.15625.
  assert.ok(Math.abs(framingCentreAt(track, sourceMs(1500)).x - 0.29375) < 1e-12);

  // Smoothstep's derivative is zero at both ends, so the camera DWELLS on an
  // action instead of leaving the instant it is clicked: 5% of the way through
  // the gap it has travelled less than 2% of the distance.
  const justAfter = framingCentreAt(track, sourceMs(1100));
  assert.ok(justAfter.x - 0.2 < 0.6 * 0.02, `the camera bolts off the click: ${justAfter.x}`);

  // Outside the track it holds the nearest keyframe rather than drifting away.
  assert.deepEqual(framingCentreAt(track, sourceMs(0)), { x: 0.2, y: 0.1 });
  assert.deepEqual(framingCentreAt(track, sourceMs(99999)), { x: 0.8, y: 0.9 });

  // With nothing positioned to follow, the camera sits in the middle.
  assert.deepEqual(framingCentreAt([], sourceMs(500)), { x: 0.5, y: 0.5 });
});

test("the crop never leaves the source frame, even for an action against the edge", () => {
  const size = { source: LANDSCAPE, output: PORTRAIT };
  const crop = referenceCrop(size.source, size.output);

  // Control: an action in the middle of the frame is NOT clamped — so the
  // clamping asserted below is a real change and not the only behaviour there is.
  const centred = framingRectAt(framingTrack([action("m", 0, 0.5, 0.5)]), size, SOURCE_ZERO);
  assert.ok(Math.abs(centred.x - (0.5 - crop.width / 2)) < 1e-12, `a centred action was moved: ${centred.x}`);

  for (const [x, y] of [[0.98, 0.5], [0.01, 0.5], [0.5, 0.99], [0.5, 0.0]] as const) {
    const rect = framingRectAt(framingTrack([action("e", 0, x, y)]), size, SOURCE_ZERO);
    assert.ok(rect.x >= -1e-12 && rect.y >= -1e-12, `crop starts outside the source: ${JSON.stringify(rect)}`);
    assert.ok(rect.x + rect.width <= 1 + 1e-12, `crop runs past the right edge: ${JSON.stringify(rect)}`);
    assert.ok(rect.y + rect.height <= 1 + 1e-12, `crop runs past the bottom edge: ${JSON.stringify(rect)}`);
    // And it stays the full reference size: clamping SLIDES the crop, it does
    // not shrink it, so the output frame is always completely filled.
    assert.ok(Math.abs(rect.width - crop.width) < 1e-12 && Math.abs(rect.height - crop.height) < 1e-12);
    // Hand-computed for the right-edge case: 0.98 - 0.158203125 = 0.821796875
    // is past the last legal origin 1 - 0.31640625 = 0.68359375, so it clamps there.
    if (x === 0.98) assert.ok(Math.abs(rect.x - 0.68359375) < 1e-12, `expected the clamped origin, got ${rect.x}`);
  }
});
