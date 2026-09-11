import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORNER_COLORS, CORNER_SIZE, CORNER_BORDER, CLOCK_BG, CLOCK_FG, CLOCK_PAD, clockText,
  WIDTH, HEIGHT, STATE_CHANGE_SEC, DURATION_SEC, FPS, FRAME_COUNT,
  sceneFrame, pixelAt
} from "./fixture-media.ts";

// ---------------------------------------------------------------------------
// The source clip the render tests composite is drawn, not captured. Two things
// have to hold for that to be legitimate, and neither of them needs ffmpeg or a
// browser — so both are checked here, in the DEFAULT suite:
//
//   1. the drawing keeps the fixture target app's visual contract. If someone
//      recolours a marker in styles.css and this file is not updated, the render
//      tests would go on measuring a colour the product no longer uses.
//   2. the scene really has the properties the render tests rely on: square
//      markers flush to the corners, a clock that ticks, and two visibly
//      different states either side of the cut. Checked at the source, so a
//      broken generator cannot be mistaken for a broken compositor.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "../../../fixtures/target-app");

/** The declarations of one CSS rule, by its exact selector. */
function ruleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[},/])\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
  return match ? match[1] : null;
}

/** One declaration's value, matched on the whole property name. */
function decl(body: string, property: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i").exec(body);
  return match ? match[1].trim() : null;
}

test("the drawn source clip still wears the fixture target app's colours and sizes", async () => {
  const css = await fs.readFile(path.join(FIXTURE, "styles.css"), "utf8");

  // SEED FIRST: the parser actually found the rules. Without this, every
  // comparison below could be `null === null` over a file that never parsed.
  const corner = ruleBody(css, ".corner");
  assert.ok(corner, "no .corner rule found in styles.css — the parser, not the fixture, is broken");
  const clock = ruleBody(css, ".clock");
  assert.ok(clock, "no .clock rule found in styles.css");
  const perCorner = Object.keys(CORNER_COLORS).map((key) => ({ key, body: ruleBody(css, `.corner--${key}`) }));
  assert.equal(perCorner.filter((c) => c.body).length, 4,
    `expected four .corner--* rules, found ${perCorner.filter((c) => c.body).length}`);

  // ...and the parser discriminates: a selector the fixture does not have comes
  // back empty, so "it matched" means something.
  assert.equal(ruleBody(css, ".corner--nowhere"), null, "the rule parser matches selectors that do not exist");

  // Half one: geometry. The render tests measure squareness of a 128x128 marker.
  assert.equal(decl(corner!, "width"), `${CORNER_SIZE}px`);
  assert.equal(decl(corner!, "height"), `${CORNER_SIZE}px`);
  assert.equal(decl(corner!, "border"), `${CORNER_BORDER}px solid #000000`);

  // Half two: colour, per corner. The render tests hunt for #e11d48 by value.
  for (const { key, body } of perCorner) {
    assert.equal(decl(body!, "background"), CORNER_COLORS[key as keyof typeof CORNER_COLORS],
      `.corner--${key} drifted away from the drawn clip`);
  }
  // The four are genuinely four: a parser that returned the same body for every
  // selector would satisfy the loop above and prove nothing.
  assert.equal(new Set(Object.values(CORNER_COLORS)).size, 4, "two corners share a colour");

  assert.equal(decl(clock!, "background"), CLOCK_BG);
  assert.equal(decl(clock!, "color"), CLOCK_FG);

  // The clock's text comes from app.js, not from the stylesheet.
  const appJs = await fs.readFile(path.join(FIXTURE, "app.js"), "utf8");
  assert.match(appJs, new RegExp(`padStart\\(${CLOCK_PAD},`), "the fixture clock no longer pads to CLOCK_PAD digits");
  assert.match(appJs, /"T\+"\s*\+\s*pad\(ms\)\s*\+\s*" ms"/, "the fixture clock no longer reads T+NNNNN ms");
  assert.equal(clockText(4218), "T+04218 ms");
});

test("the drawn scene has the properties the render tests measure", () => {
  const frame = sceneFrame(3);
  assert.equal(frame.width, WIDTH);
  assert.equal(frame.height, HEIGHT);
  assert.equal(frame.data.length, WIDTH * HEIGHT * 3);

  const hex = (c: [number, number, number]) =>
    `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

  // Each marker is in its own corner, in its own colour. Inset past the 6 px
  // black border, and inset again from the far edge so the check is inside the
  // 128 px square rather than on its boundary.
  const inset = CORNER_BORDER + 4;
  const far = CORNER_SIZE - CORNER_BORDER - 4;
  assert.equal(hex(pixelAt(frame, inset, inset)), CORNER_COLORS.tl);
  assert.equal(hex(pixelAt(frame, WIDTH - inset - 1, inset)), CORNER_COLORS.tr);
  assert.equal(hex(pixelAt(frame, inset, HEIGHT - inset - 1)), CORNER_COLORS.bl);
  assert.equal(hex(pixelAt(frame, WIDTH - inset - 1, HEIGHT - inset - 1)), CORNER_COLORS.br);

  // The marker is a SQUARE, not a band: the pixel just outside the 128 px box is
  // the page background on both axes. Without this half, a marker stretched
  // across the whole top edge would satisfy the corner checks above.
  assert.equal(hex(pixelAt(frame, CORNER_SIZE + 4, far)), "#ffffff", "the top-left marker is wider than 128 px");
  assert.equal(hex(pixelAt(frame, far, CORNER_SIZE + 4)), "#ffffff", "the top-left marker is taller than 128 px");
  // ...and the marker really is there to be bounded — the seed for the line above.
  assert.equal(hex(pixelAt(frame, far, far)), CORNER_COLORS.tl, "the top-left marker does not fill its 128 px box");

  // The clock ticks: one frame later the picture is different, but only a little.
  // The render tests' hard-cut control asserts two neighbouring instants are
  // nearly identical (< 0.5), so a clock that redrew half the screen would break
  // it, and a clock that never changed would make it vacuous.
  const mad = (a: Buffer, b: Buffer) => {
    let total = 0;
    for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
    return total / a.length;
  };
  const next = sceneFrame(3 + 1 / FPS);
  const tick = mad(frame.data, next.data);
  assert.ok(tick > 0, "the scene is frozen — nothing on it marks the passage of time");
  assert.ok(tick < 1, `one frame of clock costs ${tick.toFixed(3)} of mean difference — too much`);

  // The two sides of the cut the crossfade test uses (media 3 s and media 7 s)
  // are genuinely different pictures, by a wide margin over the clock's tick.
  const after = sceneFrame(7);
  const change = mad(frame.data, after.data);
  assert.ok(change > 20 * tick,
    `media 3 s and 7 s differ by ${change.toFixed(3)}, barely more than one clock tick (${tick.toFixed(3)})`);

  // The state change is where it is claimed to be: between them, and nowhere near
  // either sample.
  assert.ok(STATE_CHANGE_SEC > 3 && STATE_CHANGE_SEC < 7, `the state change at ${STATE_CHANGE_SEC}s is not between the two samples`);
  assert.ok(mad(sceneFrame(STATE_CHANGE_SEC - 0.2).data, frame.data) < change / 4, "the page already changed before STATE_CHANGE_SEC");
  assert.ok(mad(sceneFrame(STATE_CHANGE_SEC + 0.2).data, after.data) < change / 4, "the page had not changed after STATE_CHANGE_SEC");
});

test("the drawn clip is shorter than the composition the render tests declare", () => {
  // The black-tail trap only exists while the media runs out before the timeline
  // does. This is the one invariant of the clip that the render tests cannot
  // restate for themselves without restating the bug.
  assert.ok(DURATION_SEC < 10.315, `the clip lasts ${DURATION_SEC}s — it covers the whole 10.315 s composition`);
  // ...and its frame rate is deliberately not the composition's 30.
  assert.notEqual(FPS, 30, "the clip runs at the composition's own frame rate, so no resampling is exercised");
  assert.equal(FRAME_COUNT, Math.round(DURATION_SEC * FPS));
});
