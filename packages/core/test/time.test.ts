import test from "node:test";
import assert from "node:assert/strict";
import {
  sourceMs, outputMs, durationMs, frameIndex,
  SOURCE_ZERO, OUTPUT_ZERO, ZERO_MS,
  addMs, subMs, spanMs, atSpeed, scaleMs, minOf, maxOf, roundMs,
  captureEnd, outputEnd, frameIndexAt, frameSourceMs
} from "@demomotion/schema";

/**
 * The brands are compile-time only (test/time-brands.test-d.ts is where the
 * compiler is the subject). What runs here is the other half of the promise:
 * every helper ERASES to the arithmetic it names, so nothing rendered can
 * change because of them. Expected values are hand-written literals.
 */

test("the constructors are the identity at runtime: a brand is not a wrapper", () => {
  assert.equal(sourceMs(1234), 1234);
  assert.equal(outputMs(1234), 1234);
  assert.equal(durationMs(1234), 1234);
  assert.equal(frameIndex(12), 12);
  assert.equal(typeof sourceMs(1), "number");
  // The origins are the number zero, and JSON sees plain numbers.
  assert.equal(SOURCE_ZERO, 0);
  assert.equal(OUTPUT_ZERO, 0);
  assert.equal(ZERO_MS, 0);
  assert.equal(JSON.stringify({ atMs: sourceMs(42) }), '{"atMs":42}');
});

test("the arithmetic helpers are the operators they name", () => {
  assert.equal(addMs(sourceMs(1000), durationMs(250)), 1250);
  assert.equal(addMs(outputMs(1000), durationMs(250)), 1250);
  assert.equal(addMs(durationMs(100), durationMs(250)), 350);
  assert.equal(subMs(sourceMs(1000), durationMs(250)), 750);
  assert.equal(spanMs(sourceMs(1000), sourceMs(250)), 750);
  // A span is signed: `to - from`, so an inverted window is negative, not clamped.
  assert.equal(spanMs(sourceMs(250), sourceMs(1000)), -750);
  // Twice the speed halves the length; a slow-motion 0.5 doubles it.
  assert.equal(atSpeed(durationMs(3000), 2), 1500);
  assert.equal(atSpeed(durationMs(1000), 0.5), 2000);
  assert.equal(scaleMs(durationMs(180), 1.5), 270);
  assert.equal(minOf(sourceMs(7), sourceMs(3), sourceMs(5)), 3);
  assert.equal(maxOf(durationMs(7), durationMs(3), durationMs(5)), 7);
  assert.equal(roundMs(sourceMs(1234.5)), 1235);
  assert.equal(roundMs(sourceMs(1234.4)), 1234);
});

test("a length measured from an origin is that base's exclusive end", () => {
  assert.equal(captureEnd(durationMs(10315)), 10315);
  assert.equal(outputEnd(durationMs(5500)), 5500);
});

test("frame index <-> source instant follows the adapter's CFR invariant exactly", () => {
  // round(sourceMs / 1000 * fps), the formula capture-adapter.ts documents.
  assert.equal(frameIndexAt(sourceMs(0), 30), 0);
  assert.equal(frameIndexAt(sourceMs(1000), 30), 30);
  assert.equal(frameIndexAt(sourceMs(3000), 25), 75);
  // 1016.67 ms at 30 fps is frame 30.5 -> rounds to 31 (half up).
  assert.equal(frameIndexAt(sourceMs(1016.67), 30), 31);
  // The inverse: slot 5 at 25 fps is 200 ms (grid-assembly.test.ts's hand case).
  assert.equal(frameSourceMs(frameIndex(5), 25), 200);
  assert.equal(frameSourceMs(frameIndex(30), 30), 1000);
  // Round trip on a grid instant is exact.
  assert.equal(frameIndexAt(frameSourceMs(frameIndex(77), 30), 30), 77);
});
