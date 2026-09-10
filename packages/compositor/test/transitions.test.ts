import test from "node:test";
import assert from "node:assert/strict";
import { generateComposition } from "../src/index.ts";
import { project, clips, clipTracks, rootAttr, transitions } from "./helpers.ts";

/** A project whose style overrides only the transition knobs. */
function withTransitions(over: Record<string, unknown>, style: Record<string, unknown> = {}) {
  return project({
    ...over,
    style: {
      background: "#0b1020", padding: 56, radius: 24, shadow: true,
      cutTransitionMs: 180, openingFadeMs: 320, endingFadeMs: 420,
      ...style
    }
  } as never);
}

const TWO_SEGMENTS = [
  { sourceFromMs: 0, sourceToMs: 2000, speed: 1 },
  { sourceFromMs: 5000, sourceToMs: 8000, speed: 2 }
];

test("SEED: a cut becomes a crossfade — two clips, two tracks, overlapping by the transition", () => {
  const html = generateComposition(withTransitions({ durationMs: 10000, editList: TWO_SEGMENTS }));

  // Hand-computed. Nominal (transition-free) placement is clip0 [0, 2) and clip1
  // [2, 3.5) with media 5.0 s at 2x. A 180 ms crossfade pulls clip1's START back
  // to 1.82 s and its media back by 180 ms * 2 = 360 ms, to 4.64 s. Nothing else
  // moves: the composition is still 3.5 s long.
  assert.equal(Number(rootAttr(html, "data-duration")), 3.5);
  const c = clips(html);
  assert.deepEqual(c[0], { start: 0, duration: 2, mediaStart: 0, rate: 1 });
  assert.deepEqual(c[1], { start: 1.82, duration: 1.68, mediaStart: 4.64, rate: 2 });

  // HyperFrames forbids two clips overlapping on the same data-track-index, and
  // a crossfade between two points of ONE video is exactly that overlap — so the
  // two sides must sit on different tracks.
  assert.deepEqual(clipTracks(html), [0, 1]);

  // The incoming clip is the one that fades, over exactly the transition window.
  const t = transitions(html);
  assert.deepEqual(t.crossfades, [{ id: "clip-1", start: 1.82, duration: 0.18 }]);
});

test("cutTransitionMs = 0 turns the crossfade off and restores the hard cut", () => {
  const html = generateComposition(withTransitions({ durationMs: 10000, editList: TWO_SEGMENTS }, { cutTransitionMs: 0 }));

  const c = clips(html);
  // Exactly adjacent, media untouched: the pre-transition behaviour, unchanged.
  assert.deepEqual(c[0], { start: 0, duration: 2, mediaStart: 0, rate: 1 });
  assert.deepEqual(c[1], { start: 2, duration: 1.5, mediaStart: 5, rate: 2 });
  assert.deepEqual(transitions(html).crossfades, []);
});

test("the transition is clamped by the material it has to borrow", () => {
  // A crossfade needs a HANDLE: the incoming clip has to show the 180 ms that
  // sits immediately before its own start. When there is less than that, the
  // transition shortens instead of reading past the beginning of the media.
  const shortHandle = generateComposition(withTransitions({
    durationMs: 10000,
    editList: [{ sourceFromMs: 2000, sourceToMs: 3000, speed: 1 }, { sourceFromMs: 100, sourceToMs: 900, speed: 1 }]
  }));
  const c = clips(shortHandle);
  assert.equal(c[1].mediaStart, 0, "the crossfade read past the start of the media");
  assert.equal(c[1].start, 0.9);   // nominal 1.0 s, pulled back by the 100 ms handle
  assert.deepEqual(transitions(shortHandle).crossfades, [{ id: "clip-1", start: 0.9, duration: 0.1 }]);

  // And it can never start before the clip it is dissolving FROM.
  const shortOutgoing = generateComposition(withTransitions({
    durationMs: 10000,
    editList: [{ sourceFromMs: 0, sourceToMs: 100, speed: 1 }, { sourceFromMs: 5000, sourceToMs: 6000, speed: 1 }]
  }));
  assert.equal(clips(shortOutgoing)[1].start, 0, "the incoming clip started before the outgoing one did");
  assert.deepEqual(transitions(shortOutgoing).crossfades, [{ id: "clip-1", start: 0, duration: 0.1 }]);
});

test("transitions never uncover the tail: the clip track still tiles the whole composition", () => {
  // The black-tail trap: a clip track that does not reach the composition's end
  // renders silently black. Transitions move clip starts, so the invariant is
  // re-checked here with them on.
  const html = generateComposition(withTransitions({
    durationMs: 10000,
    editList: [
      { sourceFromMs: 0, sourceToMs: 2000, speed: 1 },
      { sourceFromMs: 5000, sourceToMs: 8000, speed: 1 },
      { sourceFromMs: 9000, sourceToMs: 10000, speed: 1 }
    ]
  }));
  const total = Number(rootAttr(html, "data-duration"));
  assert.equal(total, 6); // 2 + 3 + 1, unchanged by the transitions

  const c = clips(html);
  assert.equal(c.at(-1)!.start + c.at(-1)!.duration, total, "the last clip does not reach the end");
  // Every instant of the composition is covered by at least one clip, and each
  // clip starts before the previous one ends (overlap, never a gap).
  for (let i = 1; i < c.length; i++) {
    assert.ok(c[i].start <= c[i - 1].start + c[i - 1].duration, `gap before clip ${i}`);
  }
  // Neighbours are never on the same track, so no track carries an overlap.
  const tracks = clipTracks(html);
  for (let i = 1; i < tracks.length; i++) assert.notEqual(tracks[i], tracks[i - 1]);
});

test("cut material is only ever reachable inside a transition window, never at full opacity", () => {
  const html = generateComposition(withTransitions({ durationMs: 10000, editList: TWO_SEGMENTS }));
  const c = clips(html);
  const spans = c.map((clip) => ({ from: clip.mediaStart, to: clip.mediaStart + clip.duration * clip.rate }));

  // Half one: material deep inside the cut is reachable from no clip at all —
  // the edit is still real, the crossfade did not dissolve it away.
  for (const cut of [2.5, 3, 4]) {
    for (const span of spans) assert.ok(!(cut >= span.from && cut < span.to), `cut material at ${cut}s is on screen`);
  }

  // Half two: the 180 ms handle immediately before the cut IS reachable — a
  // crossfade has to show it — but only inside the fade, where the incoming clip
  // is still partly transparent over the outgoing one.
  const handle = 4.8;
  const shown = spans.filter((s) => handle >= s.from && handle < s.to);
  assert.equal(shown.length, 1, "the handle is not reachable at all, so the crossfade has nothing to dissolve");
  const fade = transitions(html).crossfades[0];
  // The instant the handle is on screen: media 4.8 s on clip-1 (rate 2, media
  // starts 4.64 s) lands at output 1.82 + (4.8 - 4.64)/2 = 1.9 s — inside the fade.
  const outputInstant = c[1].start + (handle - c[1].mediaStart) / c[1].rate;
  assert.ok(outputInstant >= fade.start && outputInstant < fade.start + fade.duration,
    `handle material shows at ${outputInstant}s, outside the fade [${fade.start}, ${fade.start + fade.duration})`);
});

test("the composition opens and closes on the background colour", () => {
  const html = generateComposition(withTransitions({ durationMs: 10000, editList: TWO_SEGMENTS }));
  const t = transitions(html);
  assert.equal(t.opening, 0.32);
  assert.equal(t.ending, 0.42);
  assert.ok(html.includes('id="fade"'), "no fade overlay in the document");

  // Other half: zero means off, and then there is nothing to animate.
  const off = transitions(generateComposition(withTransitions(
    { durationMs: 10000, editList: TWO_SEGMENTS },
    { openingFadeMs: 0, endingFadeMs: 0 }
  )));
  assert.equal(off.opening, 0);
  assert.equal(off.ending, 0);
});
