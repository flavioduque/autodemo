import test from "node:test";
import assert from "node:assert/strict";
import { generateComposition } from "../src/index.ts";
import { project, overlays } from "./helpers.ts";

const EARLY = { fromMs: 3000, toMs: 4500, text: 'Click "New client" & <save>', x: 0.25, y: 0.85 };
const LATE = { fromMs: 6000, toMs: 7000, text: "Done", x: 0.5, y: 0.85 };

test("SEED: callouts become timed overlays at their own source instants", () => {
  const html = generateComposition(project({
    durationMs: 10000,
    editList: [{ sourceFromMs: 0, sourceToMs: 10000, speed: 1 }],
    callouts: [EARLY, LATE]
  }));

  const o = overlays(html);
  assert.equal(o.length, 2);
  assert.equal(o[0].start, 3);
  assert.equal(o[0].duration, 1.5);
  assert.equal(o[1].start, 6);
  assert.equal(o[1].duration, 1);

  // The text is escaped, so quotes and angle brackets cannot break the document.
  assert.equal(o[0].text, "Click &quot;New client&quot; &amp; &lt;save&gt;");
  assert.ok(html.includes("left:25%"), "callout x must become a percentage position");
  assert.ok(html.includes("top:85%"), "callout y must become a percentage position");
});

test("callouts are projected through the EditList exactly like zooms", () => {
  const html = generateComposition(project({
    durationMs: 10000,
    editList: [
      { sourceFromMs: 0, sourceToMs: 2000, speed: 1 },
      { sourceFromMs: 4000, sourceToMs: 10000, speed: 1 }
    ],
    callouts: [EARLY, LATE]
  }));

  const o = overlays(html);
  // Half one: the callout whose instant was cut is gone.
  assert.equal(o.length, 1, `expected only the surviving callout, got ${JSON.stringify(o)}`);
  // Half two: the surviving one is still there, shifted by the 2000 ms cut.
  assert.equal(o[0].text, "Done");
  assert.equal(o[0].start, 4);
  assert.equal(o[0].duration, 1);
});
