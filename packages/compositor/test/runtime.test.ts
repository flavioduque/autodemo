import test from "node:test";
import assert from "node:assert/strict";
import { generateComposition } from "../src/index.ts";
import { project, runtime, scaleOf } from "./helpers.ts";

/** Identity edit, one 1000 ms zoom at source 6000. */
function html() {
  return generateComposition(project({
    durationMs: 10000,
    editList: [{ sourceFromMs: 0, sourceToMs: 10000, speed: 1 }],
    zooms: [{ fromMs: 6000, toMs: 7000, x: 0.75, y: 0.2, scale: 1.4 }]
  }));
}

test("HyperFrames determinism rules: no wall clock, no randomness, paused registered timeline", async () => {
  const page = html();
  assert.ok(!/Math\.random/.test(page), "composition must not call Math.random()");
  assert.ok(!/Date\.now|new Date/.test(page), "composition must not read the wall clock");

  const { timelines } = await runtime(page);
  assert.ok(timelines.root, "the root timeline must be registered on window.__timelines");
  assert.equal(timelines.root.paused(), true, "the timeline must be created paused");
  assert.ok(Math.abs(timelines.root.duration() - 10) < 1e-6, "the timeline must span the whole composition");
});

test("the camera animates the wrapper, never the <video>", async () => {
  const { script, cam, timelines } = await runtime(html());
  assert.ok(!/\bvideo\b|\.seg\b/.test(script), "the runtime script must not touch the video elements");
  timelines.root.seek(6.5);
  assert.ok(/scale\(/.test(cam.style.transform), "the wrapper div carries the camera transform");
});

test("the camera holds, enters and exits with a real ease", async () => {
  const { timelines, cam } = await runtime(html());
  const tl = timelines.root;

  // Outside the zoom the camera is neutral.
  tl.seek(0);
  assert.equal(scaleOf(cam), 1);
  tl.seek(5.9);
  assert.equal(scaleOf(cam), 1);

  // Enter ramp: span 1.0 s -> enter = min(0.25, 0.3) = 0.25 s.
  // Half-way through the ramp, a LINEAR interpolation would give 1.20. GSAP names
  // power3 after the QUART curve (power0=linear, power1=quad, power2=cubic,
  // power3=quart), so power3.out gives 1 + 0.4 * (1 - (1 - 0.5)^4) = 1.375.
  tl.seek(6.125);
  const mid = scaleOf(cam);
  assert.ok(Math.abs(mid - 1.375) < 1e-6, `expected 1.375 from power3.out, got ${mid}`);
  assert.ok(mid - 1.2 > 0.1, "the ramp is linear — the spec asks for real easing");

  // Both halves must still meet: the ramp reaches the target and holds it.
  tl.seek(6.25);
  assert.ok(Math.abs(scaleOf(cam) - 1.4) < 1e-6);
  tl.seek(6.5);
  assert.ok(Math.abs(scaleOf(cam) - 1.4) < 1e-6);
  assert.equal(cam.style.transformOrigin, "75% 20%");

  // Exit ramp brings it back down, and the camera is neutral again afterwards.
  tl.seek(6.85);
  assert.ok(scaleOf(cam) < 1.4 && scaleOf(cam) > 1);
  tl.seek(7.0);
  assert.equal(scaleOf(cam), 1);
});

test("seek order does not change what a frame looks like", async () => {
  const { timelines, cam } = await runtime(html());
  const tl = timelines.root;
  tl.seek(6.5);
  const forward = `${cam.style.transform}|${cam.style.transformOrigin}`;
  tl.seek(9.9);
  tl.seek(0.1);
  tl.seek(6.5);
  assert.equal(`${cam.style.transform}|${cam.style.transformOrigin}`, forward);
});
