import test from "node:test";
import assert from "node:assert/strict";
import { generateComposition } from "../src/index.ts";
import { project, camera } from "./helpers.ts";

const CUT_ZOOM = { fromMs: 3000, toMs: 3500, x: 0.3, y: 0.4, scale: 1.3 };
const KEPT_ZOOM = { fromMs: 6000, toMs: 7000, x: 0.75, y: 0.2, scale: 1.4 };

test("SEED: with nothing cut, both zooms are on the camera track", () => {
  // Prove there is something to see before asserting that it disappears.
  const html = generateComposition(project({
    durationMs: 10000,
    editList: [{ sourceFromMs: 0, sourceToMs: 10000, speed: 1 }],
    zooms: [CUT_ZOOM, KEPT_ZOOM]
  }));

  const cam = camera(html);
  assert.equal(cam.length, 2);
  assert.equal(cam[0].start, 3);
  assert.equal(cam[1].start, 6);
});

test("a zoom whose source instant was CUT does not appear at all", () => {
  // [2000,4000) is removed, so source 3000 exists in no segment.
  const html = generateComposition(project({
    durationMs: 10000,
    editList: [
      { sourceFromMs: 0, sourceToMs: 2000, speed: 1 },
      { sourceFromMs: 4000, sourceToMs: 10000, speed: 1 }
    ],
    zooms: [CUT_ZOOM, KEPT_ZOOM]
  }));

  const cam = camera(html);
  // Half one: the cut zoom is gone.
  assert.equal(cam.length, 1, `expected only the surviving zoom, got ${JSON.stringify(cam)}`);
  // Half two: the surviving zoom is still there, shifted by the cut (6000 - 2000).
  assert.equal(cam[0].start, 4);
  assert.equal(cam[0].end, 5);
});

test("a zoom that runs INTO a cut is clipped at the cut, not stretched across it", () => {
  const straddling = { fromMs: 1500, toMs: 3500, x: 0.3, y: 0.4, scale: 1.3 };

  // Control: with nothing cut it runs its full 2000 ms, ending at output 3.5 s.
  const uncut = camera(generateComposition(project({
    durationMs: 10000,
    editList: [{ sourceFromMs: 0, sourceToMs: 10000, speed: 1 }],
    zooms: [straddling]
  })));
  assert.equal(uncut.length, 1);
  assert.equal(uncut[0].start, 1.5);
  assert.equal(uncut[0].end, 3.5);

  // With [2000,4000) cut, it starts at 1.5 and ends where the material ends: 2.0.
  const cut = camera(generateComposition(project({
    durationMs: 10000,
    editList: [
      { sourceFromMs: 0, sourceToMs: 2000, speed: 1 },
      { sourceFromMs: 4000, sourceToMs: 10000, speed: 1 }
    ],
    zooms: [straddling]
  })));
  assert.equal(cut.length, 1);
  assert.equal(cut[0].start, 1.5);
  assert.equal(cut[0].end, 2);
});
