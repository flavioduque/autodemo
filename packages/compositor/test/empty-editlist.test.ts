import test from "node:test";
import assert from "node:assert/strict";
import { generateComposition } from "../src/index.ts";
import { project } from "./helpers.ts";

test("an edit list that keeps nothing is refused, and one that keeps something is not", () => {
  // Half one: the schema allows an empty list, and it means "nothing survives".
  // A zero-length composition is not a video, so say so instead of handing
  // HyperFrames a 0 s timeline and letting it fail with something unrelated.
  assert.throws(
    () => generateComposition(project({ editList: [] })),
    /edit list/i
  );

  // Half two: the guard must not reject a real edit. One kept millisecond is
  // enough to be a video.
  const html = generateComposition(project({ editList: [{ sourceFromMs: 0, sourceToMs: 1, speed: 1 }] }));
  assert.ok(html.includes('data-duration="0.001"'));
});
