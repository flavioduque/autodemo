import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PACING_NAMES, PACING_PRESETS, renderPacingTable } from "../src/pacing.ts";

// The pacing presets are the point where SKILL.md section 2 stops being advice
// and becomes what `demo_create` does. Two things can go wrong with numbers
// that live in two places: the code drifts from the table an agent reads, or
// the table drifts from the code. The second test below makes both a failure.

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../skills/demomotion/SKILL.md");

test("the three presets carry the numbers SKILL.md section 2 promises, typed here by hand", () => {
  assert.deepEqual(PACING_NAMES, ["product-demo", "tutorial", "social"]);

  const demo = PACING_PRESETS["product-demo"];
  assert.equal(demo.output, undefined, "product demo publishes at the capture's own frame");
  assert.equal(demo.typeDelayMs, 40);
  assert.equal(demo.typeOnlyFirstField, false);
  assert.equal(demo.waitAfterNavigationMs, 1200);
  assert.equal(demo.waitBetweenFieldsMs, 900);
  assert.equal(demo.finalHoldMs, 2500);
  assert.equal(demo.readingPauseMs, 2000);
  assert.equal(demo.captionHoldMs, 2200);
  assert.equal(demo.cutTransitionMs, 180);
  assert.equal(demo.fillerSpeed, undefined);

  const tutorial = PACING_PRESETS.tutorial;
  assert.equal(tutorial.output, undefined);
  assert.equal(tutorial.typeDelayMs, 55);
  assert.equal(tutorial.typeOnlyFirstField, false);
  assert.equal(tutorial.waitAfterNavigationMs, 2000);
  assert.equal(tutorial.waitBetweenFieldsMs, 1500);
  assert.equal(tutorial.finalHoldMs, 3500);
  assert.equal(tutorial.readingPauseMs, 3000);
  assert.equal(tutorial.captionHoldMs, 3000);
  assert.equal(tutorial.cutTransitionMs, 220);
  assert.equal(tutorial.fillerSpeed, undefined);

  // The original defect (#1): a "social" cut that came out 16:9. Vertical is
  // the preset's DEFAULT, not something the caller has to remember.
  const social = PACING_PRESETS.social;
  assert.deepEqual(social.output, { width: 1080, height: 1920 });
  assert.equal(social.typeDelayMs, 30);
  assert.equal(social.typeOnlyFirstField, true);
  assert.equal(social.waitAfterNavigationMs, 700);
  assert.equal(social.waitBetweenFieldsMs, 300);
  assert.equal(social.finalHoldMs, 1500);
  assert.equal(social.readingPauseMs, 900);
  assert.equal(social.captionHoldMs, 1600);
  assert.equal(social.cutTransitionMs, 120);
  assert.deepEqual(social.fillerSpeed, { min: 2, max: 2.5 });

  // Every value that is a duration or a delay is a whole, positive millisecond.
  for (const name of PACING_NAMES) {
    const p = PACING_PRESETS[name];
    for (const knob of ["typeDelayMs", "waitAfterNavigationMs", "waitBetweenFieldsMs", "finalHoldMs", "readingPauseMs", "captionHoldMs", "cutTransitionMs"] as const) {
      assert.ok(Number.isInteger(p[knob]) && p[knob] > 0, `${name}.${knob} = ${p[knob]}`);
    }
    // Inside the bounds the tools enforce, or the preset could never be applied.
    assert.ok(p.typeDelayMs <= 200, `${name}.typeDelayMs exceeds browser_fill's cap`);
    assert.ok(p.cutTransitionMs <= 2000, `${name}.cutTransitionMs exceeds project_update's cap`);
    for (const knob of ["waitAfterNavigationMs", "waitBetweenFieldsMs", "finalHoldMs"] as const) {
      assert.ok(p[knob] >= 50 && p[knob] <= 30_000, `${name}.${knob} is outside browser_wait's 50-30000 ms range`);
    }
  }
});

test("the knob table in SKILL.md is the one the code renders, cell for cell", async () => {
  const skill = await fs.readFile(SKILL, "utf8");
  const rendered = renderPacingTable();

  // Seed first: the table really is in the skill, at the place section 2 puts it.
  const start = skill.indexOf("| Knob | ");
  assert.ok(start > 0, "SKILL.md no longer has a `| Knob |` table");
  const end = skill.indexOf("\n\n", start);
  const inSkill = skill.slice(start, end);
  assert.ok(inSkill.split("\n").length >= 4, "the table in SKILL.md has no rows");

  assert.equal(inSkill, rendered,
    "SKILL.md section 2 and src/pacing.ts disagree. Paste the table below into SKILL.md, or fix the preset:\n\n" + rendered + "\n");
});
