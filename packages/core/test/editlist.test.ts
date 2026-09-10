import test from "node:test";
import assert from "node:assert/strict";
import { totalOutputMs, outputToSource, sourceToOutput, isCut, type EditList } from "../src/index.ts";

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
  { sourceFromMs: 0, sourceToMs: 2000, speed: 1 },
  { sourceFromMs: 5000, sourceToMs: 8000, speed: 2 },
  { sourceFromMs: 9000, sourceToMs: 10000, speed: 0.5 }
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
  const table: Array<[number, number]> = [
    [0, 0],
    [1000, 1000],
    [2000, 5000],
    [2500, 6000],
    [3500, 9000],
    [4500, 9500]
  ];
  for (const [outputMs, sourceMs] of table) {
    assert.equal(outputToSource(FIXTURE, outputMs), sourceMs, `outputMs ${outputMs}`);
  }
});

test("outputToSource returns null outside the whole list", () => {
  // Positive half first: an instant that IS inside the list maps to a real
  // number. Without this, a function that always returned null would pass.
  assert.equal(outputToSource(FIXTURE, 4500), 9500);
  // Output is half-open [0, 5500): the very last instant is 5500-exclusive.
  assert.equal(outputToSource(FIXTURE, 5500), null);
  assert.equal(outputToSource(FIXTURE, 9000), null);
  assert.equal(outputToSource(FIXTURE, -1), null);
  assert.equal(outputToSource([], 0), null);
});

test("sourceToOutput projects kept capture instants onto the final video", () => {
  // Hand-calculated table from the spec §3. Each row: [sourceMs, outputMs].
  const table: Array<[number, number]> = [
    [1000, 1000],
    [6000, 2500],
    [9500, 4500]
  ];
  for (const [sourceMs, outputMs] of table) {
    assert.equal(sourceToOutput(FIXTURE, sourceMs), outputMs, `sourceMs ${sourceMs}`);
  }
});

test("sourceToOutput returns null for a capture instant that was cut", () => {
  // Positive half FIRST: a source instant that IS inside a segment maps to a
  // real number. Without this, a function that always returned null would pass.
  const kept = sourceToOutput(FIXTURE, 1000);
  assert.equal(typeof kept, "number");
  assert.equal(kept, 1000);
  // Negative half: [2000, 5000) and [8000, 9000) are in no segment -> cut.
  assert.equal(sourceToOutput(FIXTURE, 3000), null);
  assert.equal(sourceToOutput(FIXTURE, 8500), null);
  // Outside the capture covered by the list is likewise in no segment.
  assert.equal(sourceToOutput(FIXTURE, -100), null);
  assert.equal(sourceToOutput(FIXTURE, 10000), null);
});

test("isCut tells kept capture instants apart from cut ones", () => {
  // Positive half: material inside a segment survives the edit.
  assert.equal(isCut(FIXTURE, 1000), false);
  assert.equal(isCut(FIXTURE, 9500), false);
  // Negative half: material in the gaps between segments was cut.
  assert.equal(isCut(FIXTURE, 3000), true);
  assert.equal(isCut(FIXTURE, 8500), true);
});

// The default edit a freshly built project gets: one segment, whole capture,
// speed 1. Output and source must coincide exactly — nothing is cut, nothing
// is shifted.
const IDENTITY: EditList = [{ sourceFromMs: 0, sourceToMs: 4000, speed: 1 }];

test("a single full-speed segment leaves the timeline untouched", () => {
  assert.equal(totalOutputMs(IDENTITY), 4000);
  assert.equal(outputToSource(IDENTITY, 0), 0);
  assert.equal(outputToSource(IDENTITY, 2500), 2500);
  assert.equal(sourceToOutput(IDENTITY, 2500), 2500);
  assert.equal(isCut(IDENTITY, 2500), false);
  // Negative half: the identity edit still ends. Beyond the capture there is
  // nothing to show, and 4000 itself is the exclusive end.
  assert.equal(sourceToOutput(IDENTITY, 4000), null);
  assert.equal(outputToSource(IDENTITY, 4000), null);
});

test("segment boundaries are half-open: the start belongs in, the end belongs out", () => {
  // CONVENTION: every interval is [fromMs, toMs) on BOTH time bases. The instant
  // exactly at `sourceFromMs` is inside the segment; the instant exactly at
  // `sourceToMs` is already outside it. Same for output.

  // Source base. seg0 is source [0, 2000), seg1 is source [5000, 8000).
  assert.equal(sourceToOutput(FIXTURE, 0), 0);          // seg0 start: inside
  assert.equal(sourceToOutput(FIXTURE, 1999), 1999);    // last instant of seg0
  assert.equal(sourceToOutput(FIXTURE, 2000), null);    // seg0 end: already cut
  assert.equal(isCut(FIXTURE, 2000), true);
  assert.equal(sourceToOutput(FIXTURE, 5000), 2000);    // seg1 start: inside
  assert.equal(isCut(FIXTURE, 5000), false);
  assert.equal(sourceToOutput(FIXTURE, 8000), null);    // seg1 end: already cut

  // Output base. seg0 is output [0, 2000), seg1 is output [2000, 3500).
  assert.equal(outputToSource(FIXTURE, 1999), 1999);    // last instant of seg0
  assert.equal(outputToSource(FIXTURE, 2000), 5000);    // seg1 start, not seg0 end
  assert.equal(outputToSource(FIXTURE, 3500), 9000);    // seg2 start, not seg1 end
});
