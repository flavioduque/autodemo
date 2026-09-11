import test from "node:test";
import assert from "node:assert/strict";
import { sourceMs, outputMs, type SourceTimeMs, type OutputTimeMs } from "@demomotion/schema";
import { totalOutputMs, outputToSource, sourceToOutput, isCut, type EditList, type EditSegment } from "../src/index.ts";

/** Test-fixture ingress: a segment from two source instants typed by hand. */
const seg = (from: number, to: number, speed: number): EditSegment =>
  ({ sourceFromMs: sourceMs(from), sourceToMs: sourceMs(to), speed });

// Fixture and every expected value below come from
// docs/superpowers/specs/2026-09-09-demomotion-foundation-design.md §3,
// calculated by hand. They are NEVER recomputed by the code under test.
//
//   seg0: source [0, 2000)     speed 1   -> output duration 2000 -> output [0, 2000)
//   seg1: source [5000, 8000)  speed 2   -> output duration 1500 -> output [2000, 3500)
//   seg2: source [9000, 10000) speed 0.5 -> output duration 2000 -> output [3500, 5500)
//
// Source material in [2000, 5000) and [8000, 9000) is in no segment: it is CUT.
const FIXTURE: EditList = [
  seg(0, 2000, 1),
  seg(5000, 8000, 2),
  seg(9000, 10000, 0.5)
];

test("totalOutputMs sums segment durations divided by speed", () => {
  assert.equal(totalOutputMs(FIXTURE), 5500);
  // Negative half: the speed ramps must actually be applied. 6000 is the sum of
  // the raw source spans (2000 + 3000 + 1000) — the answer of an implementation
  // that ignores `speed`. 10000 is the whole capture span, ignoring the cuts.
  assert.notEqual(totalOutputMs(FIXTURE), 6000);
  assert.notEqual(totalOutputMs(FIXTURE), 10000);
});

test("an empty EditList produces an empty video", () => {
  // Positive half first, so a stub returning 0 for everything cannot pass:
  // a real list still measures 5500.
  assert.equal(totalOutputMs(FIXTURE), 5500);
  assert.equal(totalOutputMs([]), 0);
});

test("outputToSource maps output instants back onto the capture", () => {
  // Hand-calculated table from the spec §3. Each row: [outputMs, sourceMs].
  const table: Array<[OutputTimeMs, SourceTimeMs]> = [
    [outputMs(0), sourceMs(0)],
    [outputMs(1000), sourceMs(1000)],
    [outputMs(2000), sourceMs(5000)],
    [outputMs(2500), sourceMs(6000)],
    [outputMs(3500), sourceMs(9000)],
    [outputMs(4500), sourceMs(9500)]
  ];
  for (const [outMs, srcMs] of table) {
    assert.equal(outputToSource(FIXTURE, outMs), srcMs, `outputMs ${outMs}`);
  }
});

test("outputToSource returns null outside the whole list", () => {
  // Positive half first: an instant that IS inside the list maps to a real
  // number. Without this, a function that always returned null would pass.
  assert.equal(outputToSource(FIXTURE, outputMs(4500)), 9500);
  // Output is half-open [0, 5500): the very last instant is 5500-exclusive.
  assert.equal(outputToSource(FIXTURE, outputMs(5500)), null);
  assert.equal(outputToSource(FIXTURE, outputMs(9000)), null);
  assert.equal(outputToSource(FIXTURE, outputMs(-1)), null);
  assert.equal(outputToSource([], outputMs(0)), null);
});

test("sourceToOutput projects kept capture instants onto the final video", () => {
  // Hand-calculated table from the spec §3. Each row: [sourceMs, outputMs].
  const table: Array<[SourceTimeMs, OutputTimeMs]> = [
    [sourceMs(1000), outputMs(1000)],
    [sourceMs(6000), outputMs(2500)],
    [sourceMs(9500), outputMs(4500)]
  ];
  for (const [srcMs, outMs] of table) {
    assert.equal(sourceToOutput(FIXTURE, srcMs), outMs, `sourceMs ${srcMs}`);
  }
});

test("sourceToOutput returns null for a capture instant that was cut", () => {
  // Positive half FIRST: a source instant that IS inside a segment maps to a
  // real number. Without this, a function that always returned null would pass.
  const kept = sourceToOutput(FIXTURE, sourceMs(1000));
  assert.equal(typeof kept, "number");
  assert.equal(kept, 1000);
  // Negative half: [2000, 5000) and [8000, 9000) are in no segment -> cut.
  assert.equal(sourceToOutput(FIXTURE, sourceMs(3000)), null);
  assert.equal(sourceToOutput(FIXTURE, sourceMs(8500)), null);
  // Outside the capture covered by the list is likewise in no segment.
  assert.equal(sourceToOutput(FIXTURE, sourceMs(-100)), null);
  assert.equal(sourceToOutput(FIXTURE, sourceMs(10000)), null);
});

test("isCut tells kept capture instants apart from cut ones", () => {
  // Positive half: material inside a segment survives the edit.
  assert.equal(isCut(FIXTURE, sourceMs(1000)), false);
  assert.equal(isCut(FIXTURE, sourceMs(9500)), false);
  // Negative half: material in the gaps between segments was cut.
  assert.equal(isCut(FIXTURE, sourceMs(3000)), true);
  assert.equal(isCut(FIXTURE, sourceMs(8500)), true);
});

// The default edit a freshly built project gets: one segment, whole capture,
// speed 1. Output and source must coincide exactly — nothing is cut, nothing
// is shifted.
const IDENTITY: EditList = [seg(0, 4000, 1)];

test("a single full-speed segment leaves the timeline untouched", () => {
  assert.equal(totalOutputMs(IDENTITY), 4000);
  assert.equal(outputToSource(IDENTITY, outputMs(0)), 0);
  assert.equal(outputToSource(IDENTITY, outputMs(2500)), 2500);
  assert.equal(sourceToOutput(IDENTITY, sourceMs(2500)), 2500);
  assert.equal(isCut(IDENTITY, sourceMs(2500)), false);
  // Negative half: the identity edit still ends. Beyond the capture there is
  // nothing to show, and 4000 itself is the exclusive end.
  assert.equal(sourceToOutput(IDENTITY, sourceMs(4000)), null);
  assert.equal(outputToSource(IDENTITY, outputMs(4000)), null);
});

test("segment boundaries are half-open: the start belongs in, the end belongs out", () => {
  // CONVENTION: every interval is [fromMs, toMs) on BOTH time bases. The instant
  // exactly at `sourceFromMs` is inside the segment; the instant exactly at
  // `sourceToMs` is already outside it. Same for output.

  // Source base. seg0 is source [0, 2000), seg1 is source [5000, 8000).
  assert.equal(sourceToOutput(FIXTURE, sourceMs(0)), 0);          // seg0 start: inside
  assert.equal(sourceToOutput(FIXTURE, sourceMs(1999)), 1999);    // last instant of seg0
  assert.equal(sourceToOutput(FIXTURE, sourceMs(2000)), null);    // seg0 end: already cut
  assert.equal(isCut(FIXTURE, sourceMs(2000)), true);
  assert.equal(sourceToOutput(FIXTURE, sourceMs(5000)), 2000);    // seg1 start: inside
  assert.equal(isCut(FIXTURE, sourceMs(5000)), false);
  assert.equal(sourceToOutput(FIXTURE, sourceMs(8000)), null);    // seg1 end: already cut

  // Output base. seg0 is output [0, 2000), seg1 is output [2000, 3500).
  assert.equal(outputToSource(FIXTURE, outputMs(1999)), 1999);    // last instant of seg0
  assert.equal(outputToSource(FIXTURE, outputMs(2000)), 5000);    // seg1 start, not seg0 end
  assert.equal(outputToSource(FIXTURE, outputMs(3500)), 9000);    // seg2 start, not seg1 end
});
