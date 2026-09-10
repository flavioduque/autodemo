import test from "node:test";
import assert from "node:assert/strict";
import { cursorAt, CURSOR_APPROACH_MS, CURSOR_PULSE_MS } from "../src/cursor.ts";
import { sourceToOutput, type EditList } from "../src/editlist.ts";

/**
 * Synthetic track, hand-chosen so every expected value below is independent of
 * the code under test. Two clicks carry normalized coordinates:
 *   A: click at sourceMs 1000, (0.2, 0.3)
 *   B: click at sourceMs 5000, (0.8, 0.6)
 * A `wait` with no coordinates sits between them and must be ignored.
 */
const A = { id: "a", type: "click" as const, atMs: 1000, durationMs: 0, x: 0.2, y: 0.3 };
const WAIT = { id: "w", type: "wait" as const, atMs: 3000, durationMs: 0 };
const B = { id: "b", type: "click" as const, atMs: 5000, durationMs: 0, x: 0.8, y: 0.6 };
const ACTIONS = [A, WAIT, B];

test("SEED + visibility: the cursor is hidden before the first positioned action and shown from it on", () => {
  // Constants are what the hand calculations below assume.
  assert.equal(CURSOR_APPROACH_MS, 500);
  assert.equal(CURSOR_PULSE_MS, 400);

  // Negative half: before A's instant there is nothing to point at.
  assert.equal(cursorAt(ACTIONS, 0).visible, false);
  assert.equal(cursorAt(ACTIONS, 999).visible, false);

  // Positive half: from A's instant on it is visible and sitting exactly on A.
  const atA = cursorAt(ACTIONS, 1000);
  assert.equal(atA.visible, true);
  assert.equal(atA.x, 0.2);
  assert.equal(atA.y, 0.3);
});

test("the cursor holds on the previous target, then eases to the next inside the approach window", () => {
  // Positive half: at each click's own instant the cursor is exactly on it.
  assert.deepEqual([cursorAt(ACTIONS, 1000).x, cursorAt(ACTIONS, 1000).y], [0.2, 0.3]);
  assert.deepEqual([cursorAt(ACTIONS, 5000).x, cursorAt(ACTIONS, 5000).y], [0.8, 0.6]);

  // Negative half: the approach for B opens at 5000 - 500 = 4500. At 4000, BEFORE
  // the window, the cursor is still parked on A — it does NOT slide the whole time,
  // and it is NOT already at the target (a function returning the next target
  // constantly would fail here).
  const before = cursorAt(ACTIONS, 4000);
  assert.deepEqual([before.x, before.y], [0.2, 0.3]);

  // Inside the window, ease-out (fast then settling). Half-way (4750) the progress
  // is 0.5; easeOutCubic(0.5) = 1 - 0.5^3 = 0.875. Hand-calculated, not via the code:
  //   x = 0.2 + (0.8 - 0.2) * 0.875 = 0.725
  //   y = 0.3 + (0.6 - 0.3) * 0.875 = 0.5625
  const mid = cursorAt(ACTIONS, 4750);
  assert.ok(Math.abs(mid.x - 0.725) < 1e-9, `expected x 0.725, got ${mid.x}`);
  assert.ok(Math.abs(mid.y - 0.5625) < 1e-9, `expected y 0.5625, got ${mid.y}`);
});

test("the click pulse is active across its window and null everywhere else", () => {
  // Positive half: B clicks at 5000, pulse window [5000, 5400). clickPhase runs
  // 0..1 across it: at the instant it is 0; 200 ms in (5200) it is 200/400 = 0.5.
  assert.equal(cursorAt(ACTIONS, 5000).clickPhase, 0);
  assert.ok(Math.abs(cursorAt(ACTIONS, 5200).clickPhase! - 0.5) < 1e-9);

  // Negative half: just past the window the pulse is gone, and BETWEEN clicks the
  // cursor is still visible but not pulsing (proving the pulse is not always on).
  assert.equal(cursorAt(ACTIONS, 5400).clickPhase, null);
  const between = cursorAt(ACTIONS, 4999);
  assert.equal(between.visible, true);
  assert.equal(between.clickPhase, null);
});

test("projected through the EditList, a cut click reaches no output frame — uncut, it does", () => {
  const uncut: EditList = [{ sourceFromMs: 0, sourceToMs: 10000, speed: 1 }];
  // Removes [4000, 6000), which swallows B's whole pulse window [5000, 5400).
  const cut: EditList = [
    { sourceFromMs: 0, sourceToMs: 4000, speed: 1 },
    { sourceFromMs: 6000, sourceToMs: 10000, speed: 1 }
  ];

  // Seed: in source time B really does pulse, so there is something to lose.
  assert.equal(cursorAt(ACTIONS, 5000).clickPhase, 0);

  // Uncut: B's instant projects to an output time, and the SAME click is visible
  // and pulsing at that projected instant.
  const out = sourceToOutput(uncut, 5000);
  assert.equal(out, 5000);
  assert.equal(cursorAt(ACTIONS, out!).clickPhase, 0);

  // Cut: no instant of B's pulse window maps to any output time at all, so no
  // output frame can ever sample the pulse.
  for (const ms of [5000, 5200, 5399]) {
    assert.equal(sourceToOutput(cut, ms), null, `source ${ms} must be cut`);
  }

  // The control is not vacuous: A survives the SAME cut, so the cursor does still
  // appear in the output — it is only the cut click that vanishes.
  assert.equal(sourceToOutput(cut, 1000), 1000);
  assert.equal(cursorAt(ACTIONS, 1000).visible, true);
});
