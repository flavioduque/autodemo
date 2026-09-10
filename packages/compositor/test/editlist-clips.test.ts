import test from "node:test";
import assert from "node:assert/strict";
import { generateComposition } from "../src/index.ts";
import { project, clips, rootAttr } from "./helpers.ts";

/** Media seconds a clip consumes: its output length times its constant rate. */
function mediaSpan(c: { mediaStart: number; duration: number; rate: number }) {
  return { from: c.mediaStart, to: c.mediaStart + c.duration * c.rate };
}

test("each EditSegment becomes one clip carrying its media offset and its speed", () => {
  // Hand-computed: keep [0,2000) at 1x -> 2000 ms out; keep [5000,8000) at 2x ->
  // 3000/2 = 1500 ms out. Total 3500 ms. [2000,5000) and [8000,...) are cut.
  const html = generateComposition(project({
    durationMs: 10000,
    editList: [
      { sourceFromMs: 0, sourceToMs: 2000, speed: 1 },
      { sourceFromMs: 5000, sourceToMs: 8000, speed: 2 }
    ]
  }));

  assert.equal(Number(rootAttr(html, "data-duration")), 3.5);

  const c = clips(html);
  assert.equal(c.length, 2);
  assert.deepEqual(c[0], { start: 0, duration: 2, mediaStart: 0, rate: 1 });
  assert.deepEqual(c[1], { start: 2, duration: 1.5, mediaStart: 5, rate: 2 });

  // Half one (seed first): the KEPT material is really reachable. The second clip
  // walks media 5.0 s -> 8.0 s, which is exactly the segment that was kept.
  const kept = mediaSpan(c[1]);
  assert.equal(kept.from, 5);
  assert.equal(kept.to, 8);

  // Half two: material inside no segment is reachable from no clip.
  for (const cut of [3, 4.9, 9]) {
    for (const clip of c) {
      const span = mediaSpan(clip);
      assert.ok(!(cut >= span.from && cut < span.to), `cut material at ${cut}s is still shown by a clip ${JSON.stringify(span)}`);
    }
  }
});

test("the source clip is referenced by the name the renderer places beside index.html", () => {
  const html = generateComposition(project({}), { videoSrc: "source.mp4" });
  assert.ok(html.includes('src="source.mp4"'));
  assert.ok(!html.includes('src="source.webm"'));
});
