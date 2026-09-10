import test from "node:test";
import assert from "node:assert/strict";
import { generateComposition } from "../src/index.ts";
import { project, captionGroups, captionTrack } from "./helpers.ts";

/** "Open the settings panel" over [2000, 6000): the hand-computed split from
 *  packages/core/test/captions.test.ts, shifted to start at 2000 ms. */
const CAPTION = {
  fromMs: 2000,
  toMs: 6000,
  text: "Open the settings panel",
  words: [
    { text: "Open", fromMs: 2000, toMs: 2818 },
    { text: "the", fromMs: 2818, toMs: 3454 },
    { text: "settings", fromMs: 3454, toMs: 5000 },
    { text: "panel", fromMs: 5000, toMs: 6000 }
  ]
};

test("SEED: a caption becomes exactly one timed layer, with one span per word", () => {
  const html = generateComposition(project({
    durationMs: 10000,
    editList: [{ sourceFromMs: 0, sourceToMs: 10000, speed: 1 }],
    captions: [CAPTION]
  }));

  const groups = captionGroups(html);
  assert.equal(groups.length, 1, "exactly one caption layer");
  assert.equal(groups[0].start, 2);      // 2000 ms of identity edit
  assert.equal(groups[0].duration, 4);   // 6000 - 2000

  // The word markup is really there — one span per word, in reading order.
  assert.deepEqual(groups[0].words, ["Open", "the", "settings", "panel"]);

  // And the runtime gets each word's own window, in OUTPUT seconds.
  const track = captionTrack(html);
  assert.equal(track.groups.length, 1);
  assert.deepEqual(track.groups[0].words.map((w) => [w.start, w.end]), [
    [2, 2.818], [2.818, 3.454], [3.454, 5], [5, 6]
  ]);
});

test("a caption is timed to its own window and to nothing else", () => {
  const html = generateComposition(project({
    durationMs: 10000,
    captions: [CAPTION, { fromMs: 7000, toMs: 8000, text: "Done", words: [{ text: "Done", fromMs: 7000, toMs: 8000 }] }]
  }));

  const groups = captionGroups(html);
  assert.equal(groups.length, 2);
  // Half one: each caption is alive exactly across its own window...
  assert.deepEqual(groups.map((g) => [g.start, g.start + g.duration]), [[2, 6], [7, 8]]);
  // Half two: ...and dead everywhere else — the windows do not touch, so the
  // instant t = 6.5 s belongs to no caption layer at all.
  for (const g of groups) assert.ok(!(6.5 >= g.start && 6.5 < g.start + g.duration), "a caption is alive outside its window");
});

test("a caption whose source instant was CUT does not appear — uncut, the same caption does", () => {
  const cutList = [
    { sourceFromMs: 0, sourceToMs: 1000, speed: 1 },
    { sourceFromMs: 7000, sourceToMs: 10000, speed: 1 }
  ];

  // Half one (seed first): with the whole capture kept, the caption IS emitted.
  const kept = captionGroups(generateComposition(project({ durationMs: 10000, captions: [CAPTION] })));
  assert.equal(kept.length, 1, "the caption must be visible somewhere before absence proves anything");
  assert.deepEqual(kept[0].words, ["Open", "the", "settings", "panel"]);

  // Half two: the SAME caption, with [1000, 7000) cut away, is gone entirely —
  // no layer, no word spans, nothing in the runtime track.
  const html = generateComposition(project({ durationMs: 10000, editList: cutList, captions: [CAPTION] }));
  assert.deepEqual(captionGroups(html), []);
  assert.deepEqual(captionTrack(html).groups, []);
  assert.ok(!html.includes("settings"), "cut caption text still reached the document");
});

test("words cut away mid-caption disappear; the surviving words keep their own timing", () => {
  // The caption opens at 2000 ms and the cut starts at 3600 ms, so "Open" and
  // "the" survive, "settings" (3454-5000) is clipped at the cut, and "panel"
  // (5000-6000) is gone. Hand-computed: output = source here, the cut is later.
  const html = generateComposition(project({
    durationMs: 10000,
    editList: [
      { sourceFromMs: 0, sourceToMs: 3600, speed: 1 },
      { sourceFromMs: 8000, sourceToMs: 10000, speed: 1 }
    ],
    captions: [CAPTION]
  }));

  const groups = captionGroups(html);
  assert.equal(groups.length, 1);
  // The group itself is clipped at the cut: 2.0 s -> 3.6 s.
  assert.equal(groups[0].start, 2);
  assert.equal(groups[0].duration, 1.6);

  // Half one: the words whose instant survived are still there.
  assert.deepEqual(groups[0].words, ["Open", "the", "settings"]);
  // Half two: the word that was cut is not — and the clipped one does not run
  // past the material it describes.
  assert.ok(!html.includes("panel"), "a word whose source instant was cut is still in the document");
  const words = captionTrack(html).groups[0].words;
  assert.equal(words.at(-1)!.end, 3.6);
});

test("a speed ramp compresses the caption and its words with the material", () => {
  // The whole capture at 2x: every source instant lands at half its time.
  const html = generateComposition(project({
    durationMs: 10000,
    editList: [{ sourceFromMs: 0, sourceToMs: 10000, speed: 2 }],
    captions: [CAPTION]
  }));
  const g = captionTrack(html).groups[0];
  assert.equal(g.start, 1);   // 2000 ms / 2
  assert.equal(g.end, 3);     // 6000 ms / 2
  assert.deepEqual(g.words.map((w) => w.start), [1, 1.409, 1.727, 2.5]);
});

test("caption text is escaped, and the style knobs reach the document", () => {
  const html = generateComposition(project({
    durationMs: 10000,
    captions: [{ fromMs: 0, toMs: 1000, text: '<b>"x"</b>', words: [{ text: '<b>"x"</b>', fromMs: 0, toMs: 1000 }] }],
    style: { background: "#0b1020", padding: 56, radius: 24, shadow: true, captionActiveColor: "#ff0055", captionEmphasis: 0.2, captionScale: 1, captionColor: "#c8d2e6", captionAccent: "#38bdf8" }
  }));
  assert.ok(!html.includes("<b>"), "caption text was not escaped");
  assert.ok(html.includes("&lt;b&gt;"), "the escaped text is missing entirely");
  const track = captionTrack(html);
  assert.equal(track.active, "#ff0055");
  assert.equal(track.emphasis, 0.2);
});

test("a project with no captions emits no caption layer at all", () => {
  const html = generateComposition(project({ durationMs: 10000, captions: [] }));
  assert.deepEqual(captionGroups(html), []);
  assert.deepEqual(captionTrack(html).groups, []);
});
