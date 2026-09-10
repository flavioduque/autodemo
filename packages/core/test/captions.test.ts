import test from "node:test";
import assert from "node:assert/strict";
import { buildCaptionSkeleton, distributeWords, MIN_WORD_MS } from "../src/captions.ts";

/**
 * Expected values are computed BY HAND from the rule, never by calling the code:
 *
 *   minMs   = min(MIN_WORD_MS, span / n)
 *   slack   = span - n * minMs
 *   dur_i   = minMs + slack * len_i / sum(len)
 *
 * "Open the settings panel" over [0, 4000): lengths 4, 3, 8, 5 (sum 20), n = 4.
 * minMs = min(90, 1000) = 90 -> floor 360 ms, slack = 3640 ms.
 *   Open     90 + 3640 * 4/20 =  90 +  728 =  818
 *   the      90 + 3640 * 3/20 =  90 +  546 =  636
 *   settings 90 + 3640 * 8/20 =  90 + 1456 = 1546
 *   panel    90 + 3640 * 5/20 =  90 +  910 = 1000
 * Sum 4000, so the boundaries are 0 | 818 | 1454 | 3000 | 4000.
 */
test("distributeWords splits a window proportionally to token length", () => {
  assert.equal(MIN_WORD_MS, 90, "the hand-computed table above assumes a 90 ms floor");

  const words = distributeWords("Open the settings panel", 0, 4000);

  assert.deepEqual(words, [
    { text: "Open", fromMs: 0, toMs: 818 },
    { text: "the", fromMs: 818, toMs: 1454 },
    { text: "settings", fromMs: 1454, toMs: 3000 },
    { text: "panel", fromMs: 3000, toMs: 4000 }
  ]);
});

test("the last word ends exactly at toMs, on a window that does not start at zero", () => {
  // Same sentence, shifted by 12 345 ms and 3 s long: the shift is pure addition.
  const words = distributeWords("Open the settings panel", 12_345, 15_345);
  assert.equal(words[0].fromMs, 12_345);
  assert.equal(words.at(-1)!.toMs, 15_345, "the caption must not outlive its own window");

  // And no gap or overlap between consecutive words.
  for (let i = 1; i < words.length; i++) assert.equal(words[i].fromMs, words[i - 1].toMs);
});

test("a single word spans the whole window", () => {
  assert.deepEqual(distributeWords("Save", 1000, 2500), [{ text: "Save", fromMs: 1000, toMs: 2500 }]);
});

test("a window too short for the floor is still divided, never inverted", () => {
  // 3 words over 120 ms: minMs = min(90, 40) = 40, slack = 0, so each word gets
  // exactly 40 ms regardless of its length. Hand-computed: 1000 | 1040 | 1080 | 1120.
  const words = distributeWords("a bb ccc", 1000, 1120);
  assert.deepEqual(words.map((w) => w.fromMs), [1000, 1040, 1080]);
  assert.deepEqual(words.map((w) => w.toMs), [1040, 1080, 1120]);
  for (const w of words) assert.ok(w.toMs > w.fromMs, "no word may have zero or negative duration");
});

test("degenerate input yields no words instead of a broken track", () => {
  assert.deepEqual(distributeWords("   ", 0, 1000), []);
  assert.deepEqual(distributeWords("hello", 1000, 1000), []);
  assert.deepEqual(distributeWords("hello", 2000, 1000), []);
});

test("distributeWords is a pure function of its arguments", () => {
  // Same input, two calls: identical output. A render worker that visits this
  // caption at a different wall-clock instant must get the same timings.
  const a = distributeWords("Deterministic by construction", 500, 4500);
  const b = distributeWords("Deterministic by construction", 500, 4500);
  assert.deepEqual(a, b);
});

test("a caption skeleton never overlaps itself, even when labels come 500 ms apart", () => {
  // These instants are the REAL ones from the recorded fixture capture: the
  // three fills land 529 and 396 ms apart. Two captions on screen at once is
  // not a caption track, it is a stack.
  const actions = [
    { id: "a", type: "click" as const, atMs: 2278, durationMs: 0, label: "New client" },
    { id: "b", type: "fill" as const, atMs: 6534, durationMs: 0, label: "Name" },
    { id: "c", type: "fill" as const, atMs: 7063, durationMs: 0, label: "Email" },
    { id: "d", type: "fill" as const, atMs: 7459, durationMs: 0, label: "Phone" },
    { id: "e", type: "click" as const, atMs: 7994, durationMs: 0, label: "Save client" }
  ];
  const captions = buildCaptionSkeleton(actions, 10315);

  // Half one (seed): the skeleton really produced the five lines.
  assert.deepEqual(captions.map((c) => c.text), ["New client", "Name", "Email", "Phone", "Save client"]);

  // Half two: no line survives into the next one's window.
  for (let i = 1; i < captions.length; i++) {
    assert.ok(
      captions[i - 1].toMs <= captions[i].fromMs,
      `"${captions[i - 1].text}" (${captions[i - 1].fromMs}-${captions[i - 1].toMs}) overlaps "${captions[i].text}" at ${captions[i].fromMs}`
    );
  }
  // And each word stays inside its own caption.
  for (const c of captions) {
    assert.equal(c.words[0].fromMs, c.fromMs);
    assert.equal(c.words.at(-1)!.toMs, c.toMs);
  }
});
