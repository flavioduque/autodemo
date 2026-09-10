import test from "node:test";
import assert from "node:assert/strict";
import { generateComposition } from "../src/index.ts";
import { project, camera } from "./helpers.ts";

/**
 * Spec section 3: a zoom is authored against WHEN IT HAPPENED in the capture
 * (sourceMs). The compositor projects it to outputMs through the EditList, so
 * cutting material earlier in the timeline repositions everything after it with
 * no manual resync.
 */

const ZOOM = { fromMs: 6000, toMs: 7000, x: 0.75, y: 0.2, scale: 1.4 };

test("uncut timeline: the zoom lands at its own source instant", () => {
  const html = generateComposition(project({
    durationMs: 10000,
    editList: [{ sourceFromMs: 0, sourceToMs: 10000, speed: 1 }],
    zooms: [ZOOM]
  }));

  const cam = camera(html);
  assert.equal(cam.length, 1);
  // Hand-computed: identity edit, so outputMs === sourceMs.
  assert.equal(cam[0].start, 6);
  assert.equal(cam[0].end, 7);
  assert.equal(cam[0].scale, 1.4);
  assert.equal(cam[0].x, 0.75);
  assert.equal(cam[0].y, 0.2);
});

test("a cut BEFORE the zoom shifts it earlier by exactly the cut's duration", () => {
  // Keep [0,2000) and [4000,10000): the 2000 ms slice [2000,4000) is removed.
  // Hand-computed from spec section 3: source 6000 sits 2000 ms into the second
  // segment, whose output starts at 2000 -> outputMs = 4000. That is 6000 - 2000.
  const html = generateComposition(project({
    durationMs: 10000,
    editList: [
      { sourceFromMs: 0, sourceToMs: 2000, speed: 1 },
      { sourceFromMs: 4000, sourceToMs: 10000, speed: 1 }
    ],
    zooms: [ZOOM]
  }));

  const cam = camera(html);
  assert.equal(cam.length, 1, "the zoom must survive a cut that does not touch it");
  assert.equal(cam[0].start, 4);
  assert.equal(cam[0].end, 5);
});
