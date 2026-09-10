import test from "node:test";
import assert from "node:assert/strict";
import { assembleGrid } from "../src/capture-adapter.ts";

// Fast, pure unit tests for the constant-fps grid assembly. Expected values are
// worked out by hand below (independent of the implementation), so the test can
// actually disagree with the code.

test("assembleGrid places each screencast frame on the constant-fps grid by its own time", () => {
  // 10 fps => grid slots at 0.0, 0.1, 0.2, ... seconds.
  // Screencast (variable-rate) frames appeared at these times (seconds):
  //   frame 0 @ 0.00   frame 1 @ 0.25   frame 2 @ 0.55   frame 3 @ 0.90
  // Duration 1.0s -> round(1.0 * 10) = 10 grid slots, i = 0..9 at t = i/10.
  const frames = [0.0, 0.25, 0.55, 0.9];
  const grid = assembleGrid(frames, 10, 1.0);

  // Hand-computed: for slot i, the last frame whose time <= i/10.
  //   t=0.0 ->0  0.1->0  0.2->0   (0.25 not yet)
  //   t=0.3 ->1  0.4->1  0.5->1   (0.55 not yet)
  //   t=0.6 ->2  0.7->2  0.8->2   (0.90 not yet)
  //   t=0.9 ->3
  assert.deepEqual(grid, [0, 0, 0, 1, 1, 1, 2, 2, 2, 3]);
  // Invariant: one entry per output frame, and slot i IS sourceMs = i/fps*1000.
  assert.equal(grid.length, 10);
});

test("assembleGrid repeats the last frame across an idle gap (screencast emits only on change)", () => {
  // A single frame at t=0, then the page is idle for the whole second. Every
  // grid slot must reuse frame 0 — an idle stretch costs nothing but repeats.
  const grid = assembleGrid([0.0], 30, 1.0);
  assert.equal(grid.length, 30);
  assert.ok(grid.every((k) => k === 0));

  // Positive counterpart: when a second frame DOES arrive mid-way, the grid
  // switches to it at exactly the right slot and not before.
  // 30 fps, frame 1 at t=0.5s -> first slot with i/30 >= 0.5 is i=15 (15/30=0.5).
  const grid2 = assembleGrid([0.0, 0.5], 30, 1.0);
  assert.equal(grid2[14], 0); // 14/30 = 0.4667 < 0.5
  assert.equal(grid2[15], 1); // 15/30 = 0.5   >= 0.5
});

test("assembleGrid keeps the exact frame<->sourceMs invariant for a hand-picked case", () => {
  // 25 fps, frames at 0, 0.20, 0.44 s over 0.6s => round(0.6*25)=15 slots.
  // Boundary check independent of code: slot time = i/25 s = i*40 ms.
  //   i=0..4 (0..160ms) -> frame 0        (0.20s=200ms not yet at i=4:160ms)
  //   i=5..10 (200..400ms) -> frame 1     (0.44s=440ms not yet at i=10:400ms)
  //   i=11..14 (440..560ms) -> frame 2
  const grid = assembleGrid([0.0, 0.2, 0.44], 25, 0.6);
  assert.equal(grid.length, 15);
  const expected = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2];
  assert.deepEqual(grid, expected);

  // The invariant restated: for any slot i, sourceMs = i/fps*1000, and the frame
  // shown is the last one that had appeared by then. Verify slot 5 explicitly:
  // sourceMs = 5/25*1000 = 200ms, frame at 0.20s just became current -> index 1.
  assert.equal(grid[5], 1);
});

test("assembleGrid is empty only when there were no frames at all", () => {
  assert.deepEqual(assembleGrid([], 30, 5), []);
  // Non-vacuous counterpart: one frame yields a non-empty grid.
  assert.equal(assembleGrid([0], 30, 5).length, 150);
});
