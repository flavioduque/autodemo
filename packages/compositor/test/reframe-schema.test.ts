import test from "node:test";
import assert from "node:assert/strict";
import { DemoProjectSchema, outputSize, sourceSize } from "@autodemo/schema";
import { GOLDEN_INPUT } from "./golden-project.ts";

/**
 * Source and output are two different frames.
 *
 * `width`/`height` keep their meaning — the RECORDED frame, the one every
 * normalized coordinate in the project (actions, zooms, callouts) is expressed
 * against. The new, optional `output` is the frame the video is rendered at.
 * Absent means "the same as the source", which is what a single pair meant.
 */

test("the output frame is optional, and absent means the source frame", () => {
  // Positive half: an output frame of a DIFFERENT aspect is accepted and kept.
  const vertical = DemoProjectSchema.parse({ ...GOLDEN_INPUT, output: { width: 1080, height: 1920 } });
  assert.deepEqual(vertical.output, { width: 1080, height: 1920 });
  assert.deepEqual(outputSize(vertical), { width: 1080, height: 1920 });
  // ...and it did not disturb the source frame, which is still the capture's.
  assert.deepEqual(sourceSize(vertical), { width: 1920, height: 1080 });

  // Other half: a project written before this field existed still parses, and
  // its output frame is its source frame — today's single-pair behaviour.
  const legacy = DemoProjectSchema.parse(GOLDEN_INPUT);
  assert.equal(legacy.output, undefined);
  assert.deepEqual(outputSize(legacy), { width: 1920, height: 1080 });

  // Negative half: the pair is atomic. Half an output frame is not an output frame.
  assert.equal(DemoProjectSchema.safeParse({ ...GOLDEN_INPUT, output: { width: 1080 } }).success, false);
  assert.equal(DemoProjectSchema.safeParse({ ...GOLDEN_INPUT, output: { width: 0, height: 1920 } }).success, false);
});
