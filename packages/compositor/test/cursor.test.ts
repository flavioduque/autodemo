import test from "node:test";
import assert from "node:assert/strict";
import { generateComposition } from "../src/index.ts";
import { project, runtime } from "./helpers.ts";

/** A fill that positions the cursor but does not pulse, and a click that pulses. */
const FILL_A = { id: "a", type: "fill" as const, atMs: 500, durationMs: 0, x: 0.1, y: 0.1 };
const CLICK_B = { id: "b", type: "click" as const, atMs: 5000, durationMs: 0, x: 0.8, y: 0.6 };

function pct(value: string): number {
  const m = /^([\d.]+)%$/.exec(value ?? "");
  if (!m) throw new Error(`not a percentage: ${value}`);
  return Number(m[1]);
}

test("the composition has exactly one cursor layer and one cursor runtime registration", () => {
  const html = generateComposition(project({
    durationMs: 10000,
    editList: [{ sourceFromMs: 0, sourceToMs: 10000, speed: 1 }],
    actions: [FILL_A, CLICK_B]
  }));

  assert.equal((html.match(/id="cursor"/g) ?? []).length, 1, "exactly one cursor pointer layer");
  assert.equal((html.match(/id="cursor-ring"/g) ?? []).length, 1, "exactly one click-pulse ring");
  assert.equal((html.match(/id="autodemo-cursor"/g) ?? []).length, 1, "exactly one cursor data island");
  // The pointer is an inline SVG — no external asset, no CDN (HyperFrames blocks fetches).
  assert.ok(/<svg[^>]*id="cursor"/.test(html), "the cursor must be an inline SVG");
  assert.ok(!/Math\.random|Date\.now|new Date/.test(html), "runtime stays deterministic");
});

test("at a click's output instant the ring shows and the pointer sits on the click", async () => {
  const { timelines, cursor, ring } = await runtime(generateComposition(project({
    durationMs: 10000,
    editList: [{ sourceFromMs: 0, sourceToMs: 10000, speed: 1 }],
    actions: [FILL_A, CLICK_B]
  })));
  const tl = timelines.root;

  // Click B is at source 5000; with an identity edit that is output second 5.
  tl.seek(5.0);
  assert.ok(Number(ring.style.opacity) > 0, `ring must be lit at the click, opacity was ${ring.style.opacity}`);
  assert.ok(Math.abs(pct(cursor.style.left) - 80) < 0.001, `pointer x should be 80%, was ${cursor.style.left}`);
  assert.ok(Math.abs(pct(cursor.style.top) - 60) < 0.001, `pointer y should be 60%, was ${cursor.style.top}`);
  assert.equal(Number(cursor.style.opacity), 1, "pointer visible at the click");

  // Negative half for the ring: at second 2 the fill has positioned the cursor but
  // there is no click, so the ring is dark while the pointer is still shown.
  tl.seek(2.0);
  assert.equal(Number(ring.style.opacity), 0, "no click at second 2 — ring must be dark");
  assert.equal(Number(cursor.style.opacity), 1, "pointer still visible between clicks");
});

test("a click cut by the EditList never lights the ring — uncut, the same click does", async () => {
  const actions = [FILL_A, CLICK_B];

  // Control: with nothing cut, scanning the output finds the click's pulse.
  const uncut = await runtime(generateComposition(project({
    durationMs: 10000, actions,
    editList: [{ sourceFromMs: 0, sourceToMs: 10000, speed: 1 }]
  })));
  let litUncut = false;
  for (let t = 0; t <= 10; t += 0.05) { uncut.timelines.root.seek(t); if (Number(uncut.ring.style.opacity) > 0) litUncut = true; }
  assert.ok(litUncut, "the uncut click must light the ring somewhere — else the test below is vacuous");

  // [4000, 6000) removed, swallowing B's whole pulse window [5000, 5400). Output
  // runs 0..8 s. No output frame can sample the cut click, so the ring stays dark.
  const cut = await runtime(generateComposition(project({
    durationMs: 10000, actions,
    editList: [
      { sourceFromMs: 0, sourceToMs: 4000, speed: 1 },
      { sourceFromMs: 6000, sourceToMs: 10000, speed: 1 }
    ]
  })));
  let litCut = false;
  let cursorSeen = false;
  for (let t = 0; t <= 8; t += 0.05) {
    cut.timelines.root.seek(t);
    if (Number(cut.ring.style.opacity) > 0) litCut = true;
    if (Number(cut.cursor.style.opacity) > 0) cursorSeen = true;
  }
  assert.equal(litCut, false, "the cut click must never light the ring");
  // Not vacuous: the surviving fill keeps the cursor on screen in the cut render.
  assert.ok(cursorSeen, "the cursor must still appear from the surviving fill");
});
