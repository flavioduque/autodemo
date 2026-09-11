import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateComposition } from "../src/index.ts";
import { goldenProject, GOLDEN_INPUT } from "./golden-project.ts";
import { DemoProjectSchema } from "@demomotion/schema";

/**
 * THE CONTROL FOR REFRAMING.
 *
 * `test/golden/native-16x9.html` was produced by the compositor as it stood at
 * commit 32ea370 — BEFORE the source/output split existed — by generating a
 * composition from `GOLDEN_INPUT`. It is a frozen artefact: there is no script
 * in the tree that regenerates it, because regenerating it is exactly how this
 * control would be defeated.
 *
 * Reframing is a change that could plausibly crop EVERY project. Without this
 * half, an implementation that always cropped would still pass the vertical
 * tests. So: a project whose output frame is absent — and one whose output frame
 * is spelled out but has the source's aspect — must produce the SAME DOCUMENT,
 * byte for byte, as before reframing existed.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = fs.readFileSync(path.join(HERE, "golden", "native-16x9.html"), "utf8");

test("a project with no output frame renders byte-for-byte the pre-reframing document", () => {
  const html = generateComposition(goldenProject(), { videoSrc: "source.webm", gsapSrc: "gsap.min.js" });

  // Seed check: the golden really has something in it to disagree with.
  assert.ok(GOLDEN.length > 10_000, `the golden file is only ${GOLDEN.length} bytes — it cannot be a whole composition`);
  assert.ok(/id="demomotion-camera"/.test(GOLDEN) && /<video/.test(GOLDEN));

  assert.equal(html, GOLDEN);
});

test("naming the output frame at the SOURCE aspect changes nothing either", () => {
  // The other half: "absent" and "explicitly the same" must not be two different
  // renders. An agent that reframes and then reframes back gets its video back.
  const explicit = DemoProjectSchema.parse({ ...GOLDEN_INPUT, output: { width: 1920, height: 1080 } });
  const html = generateComposition(explicit, { videoSrc: "source.webm", gsapSrc: "gsap.min.js" });
  assert.equal(html, GOLDEN);
});
