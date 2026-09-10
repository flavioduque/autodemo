import test from "node:test";
import assert from "node:assert/strict";
import { generateComposition } from "../src/index.ts";
import { project, clips, rootAttr } from "./helpers.ts";

/**
 * THE TRAP (proven by execution in the HyperFrames spike): a <video> clip whose
 * data-duration is shorter than the composition goes silently black for the
 * remainder — no error, exit code 0. So the clip track must cover the whole
 * composition, and the LAST clip must reach the composition's end.
 */

test("identity edit: the single clip lasts as long as the whole composition", () => {
  // Source media is 9.08 s; the capture manifest says 10.315 s. The clip must
  // still be authored at the composition length, never at the media length.
  const html = generateComposition(project({ durationMs: 10315, editList: [{ sourceFromMs: 0, sourceToMs: 10315, speed: 1 }] }));

  assert.equal(rootAttr(html, "data-duration"), "10.315"); // hand-computed: 10315 ms / 1000
  const c = clips(html);
  assert.equal(c.length, 1);
  assert.equal(c[0].start, 0);
  assert.equal(c[0].duration, 10.315);
});

test("edited timeline: clips tile the composition with no gap, and the last one reaches the end", () => {
  // Hand-computed from spec section 3: keep [0,2000) at 1x -> 2000 ms of output,
  // then [5000,8000) at 1x -> 3000 ms. Total output 5000 ms; [2000,5000) is cut.
  //
  // Transitions off: with a crossfade the clips deliberately OVERLAP, which is
  // still gapless but no longer exactly adjacent. The same tail invariant with
  // transitions on is asserted in transitions.test.ts.
  const html = generateComposition(project({
    durationMs: 10000,
    style: { cutTransitionMs: 0 },
    editList: [
      { sourceFromMs: 0, sourceToMs: 2000, speed: 1 },
      { sourceFromMs: 5000, sourceToMs: 8000, speed: 1 }
    ]
  } as never));

  const total = Number(rootAttr(html, "data-duration"));
  assert.equal(total, 5);

  const c = clips(html);
  assert.equal(c.length, 2);

  // Half one: the tail cannot go black — the last clip runs to the very end.
  assert.equal(c[1].start + c[1].duration, total);

  // Half two: the cut is real. Covering the tail must NOT be done by stretching
  // every clip over the whole composition, which would delete the edit.
  assert.equal(c[0].start, 0);
  assert.equal(c[0].duration, 2);
  assert.equal(c[1].start, 2);
  assert.equal(c[1].duration, 3);

  // And there is no uncovered instant between them.
  for (let i = 1; i < c.length; i++) assert.equal(c[i].start, c[i - 1].start + c[i - 1].duration);
});
