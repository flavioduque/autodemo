import test from "node:test";
import assert from "node:assert/strict";
import { generateComposition } from "../src/index.ts";
import { project, stageStyle, px } from "./helpers.ts";

/**
 * The Remotion composition put the video in a padded box of a DIFFERENT aspect
 * ratio and used objectFit:"cover", which silently discarded 4.82% of the frame
 * height. The content box must instead carry the SOURCE aspect ratio and
 * letterbox inside the padded frame.
 */

test("landscape source: the content box keeps the source aspect and letterboxes horizontally", () => {
  const html = generateComposition(project({ width: 1920, height: 1080, style: { background: "#0b1020", padding: 56, radius: 24, shadow: true } }));
  const s = stageStyle(html);
  const w = px(s.width);
  const h = px(s.height);

  // Hand-computed: the padded frame is 1808 x 968. A 16:9 box fitted inside it is
  // height-constrained: h = 968, w = 968 * 16/9 = 1720.888...
  assert.equal(h, 968);
  assert.ok(Math.abs(w - 1720.888889) < 1e-5, `expected width ~1720.888889, got ${w}`);

  // Half one: nothing is cropped. The box must not exceed the padded frame...
  assert.ok(w <= 1808 + 1e-9 && h <= 968 + 1e-9, "content box overflows the padded frame");
  // ...and no `cover` may survive anywhere in the document.
  assert.ok(!/object-fit:\s*cover/.test(html), "generated HTML still uses object-fit: cover");

  // Half two: it is not merely small. It fills the padded frame in the
  // constraining dimension, so the demo is as large as it can be.
  assert.ok(Math.max(w / 1808, h / 968) > 1 - 1e-9, "content box does not fill the padded frame in either dimension");

  // Centred inside the composition.
  assert.ok(Math.abs(px(s.left) - (1920 - w) / 2) < 1e-5);
  assert.ok(Math.abs(px(s.top) - (1080 - h) / 2) < 1e-5);
});

test("portrait source: the same rule constrains the OTHER dimension", () => {
  const html = generateComposition(project({ width: 1080, height: 1920, style: { background: "#0b1020", padding: 40, radius: 24, shadow: true } }));
  const s = stageStyle(html);
  const w = px(s.width);
  const h = px(s.height);

  // Hand-computed: padded frame 1000 x 1840; a 9:16 box fitted inside it is
  // width-constrained: w = 1000, h = 1000 * 16/9 = 1777.777...
  assert.equal(w, 1000);
  assert.ok(Math.abs(h - 1777.777778) < 1e-5, `expected height ~1777.777778, got ${h}`);
  assert.ok(w <= 1000 + 1e-9 && h <= 1840 + 1e-9);
});
