import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import * as schema from "@demomotion/schema";
import { DemoProjectSchema } from "@demomotion/schema";
import { generateComposition } from "@demomotion/compositor";
import { buildProject, updateProject } from "../src/project.ts";

/** A minimal valid project, minus whatever the test under way is varying. */
const baseProject = (overrides: Record<string, unknown> = {}) => ({
  version: 1 as const,
  title: "Demo",
  sourceVideo: "/tmp/demo.webm",
  width: 1920,
  height: 1080,
  fps: 30,
  durationMs: 10000,
  style: { background: "#0b1020", padding: 56, radius: 24, shadow: true },
  actions: [],
  zooms: [],
  callouts: [],
  ...overrides
});

test("the project schema accepts a valid editList and rejects impossible segments", () => {
  // Positive half: the fixture from the spec §3 is legal and survives parsing.
  const valid = DemoProjectSchema.parse(baseProject({
    editList: [
      { sourceFromMs: 0, sourceToMs: 2000, speed: 1 },
      { sourceFromMs: 5000, sourceToMs: 8000, speed: 2 },
      { sourceFromMs: 9000, sourceToMs: 10000, speed: 0.5 }
    ]
  }));
  assert.equal(valid.editList.length, 3);
  assert.equal(valid.editList[1].speed, 2);

  // Negative half: a segment must move forward in the source.
  assert.equal(DemoProjectSchema.safeParse(baseProject({
    editList: [{ sourceFromMs: 2000, sourceToMs: 2000, speed: 1 }]
  })).success, false);
  assert.equal(DemoProjectSchema.safeParse(baseProject({
    editList: [{ sourceFromMs: 2000, sourceToMs: 1000, speed: 1 }]
  })).success, false);

  // Negative half: speed 0 would make the segment infinitely long, and a
  // negative speed would play it backwards. Neither is a valid edit.
  assert.equal(DemoProjectSchema.safeParse(baseProject({
    editList: [{ sourceFromMs: 0, sourceToMs: 1000, speed: 0 }]
  })).success, false);
  assert.equal(DemoProjectSchema.safeParse(baseProject({
    editList: [{ sourceFromMs: 0, sourceToMs: 1000, speed: -1 }]
  })).success, false);
});

test("the orphan `trims` field no longer exists anywhere in the schema", () => {
  // Positive half: the replacement is present and exported.
  assert.equal("EditSegmentSchema" in schema, true);
  // Negative half: the orphan is not.
  assert.equal("TrimSchema" in schema, false);

  // A project file written before this change still carries `trims`. Parsing it
  // must not resurrect the field — the editList is the only edit structure.
  const parsed = DemoProjectSchema.parse(baseProject({
    editList: [{ sourceFromMs: 0, sourceToMs: 10000, speed: 1 }],
    trims: [{ fromMs: 1000, toMs: 2000 }]
  }));
  assert.equal("trims" in parsed, false);
  assert.equal(parsed.editList.length, 1);
});

test("buildProject gives a fresh project an identity editList over the whole capture", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "demomotion-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const manifestPath = path.join(dir, "capture.json");
  // 7000 is a literal chosen here, independent of anything the code computes.
  await fs.writeFile(manifestPath, JSON.stringify({
    videoPath: path.join(dir, "page.webm"),
    width: 1920,
    height: 1080,
    durationMs: 7000,
    actions: []
  }));

  const { project } = await buildProject(manifestPath, "Fresh demo");

  // Positive half: one segment, whole capture, normal speed. Nothing is cut and
  // nothing is sped up, so the render is byte-for-byte the old behaviour.
  assert.deepEqual(project.editList, [{ sourceFromMs: 0, sourceToMs: 7000, speed: 1 }]);
  // Negative half: the orphan is not written back into the project file.
  assert.equal("trims" in project, false);

  // And the same holds for what actually lands on disk, not just in memory.
  const written = JSON.parse(await fs.readFile(path.join(dir, "project.json"), "utf8"));
  assert.deepEqual(written.editList, [{ sourceFromMs: 0, sourceToMs: 7000, speed: 1 }]);
  assert.equal("trims" in written, false);
});

test("updateProject persists an edit and leaves the rest of the project alone", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "demomotion-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // Seed through the product: the project comes out of buildProject, the same
  // path an agent takes, not from a hand-written project.json.
  const manifestPath = path.join(dir, "capture.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    videoPath: path.join(dir, "page.webm"),
    width: 1920,
    height: 1080,
    durationMs: 7000,
    actions: [{ id: "a1", type: "click", atMs: 3000, durationMs: 20, x: 0.5, y: 0.5 }]
  }));
  const { project: before, projectPath } = await buildProject(manifestPath, "Cut me");
  // Control: the identity edit is really there before we change it, so the
  // assertion below cannot pass over an already-empty timeline.
  assert.deepEqual(before.editList, [{ sourceFromMs: 0, sourceToMs: 7000, speed: 1 }]);
  assert.equal(before.zooms.length, 1);

  const edited = [
    { sourceFromMs: 0, sourceToMs: 2000, speed: 1 },
    { sourceFromMs: 5000, sourceToMs: 7000, speed: 2 }
  ];
  await updateProject(projectPath, { editList: edited });

  // Positive half: the edit reached the file, not just the return value.
  const written = JSON.parse(await fs.readFile(projectPath, "utf8"));
  assert.deepEqual(written.editList, edited);

  // Other half: everything the patch did not mention survived untouched.
  assert.equal(written.title, "Cut me");
  assert.equal(written.durationMs, 7000);
  assert.deepEqual(written.zooms, before.zooms);
  assert.deepEqual(written.actions, before.actions);
});

test("an existing 16:9 capture can be reframed to 9:16 without recording again", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "demomotion-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // Seed through the product: the project comes out of buildProject, exactly as
  // an agent would have it after a landscape recording.
  const manifestPath = path.join(dir, "capture.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    videoPath: path.join(dir, "page.webm"),
    width: 1920,
    height: 1080,
    durationMs: 7000,
    actions: [{ id: "a1", type: "click", atMs: 3000, durationMs: 20, x: 0.7, y: 0.4 }]
  }));
  const { project: before, projectPath } = await buildProject(manifestPath, "Reframe me");

  // Control: a fresh project has NO output frame, and renders landscape. Without
  // this the assertion below could pass on a project that was already vertical.
  assert.equal(before.output, undefined);
  assert.match(generateComposition(before), /data-width="1920" data-height="1080"/);

  const after = await updateProject(projectPath, { output: { width: 1080, height: 1920 } });

  // Positive half: the new frame reached the file, and the composition built
  // from that file is vertical.
  const written = JSON.parse(await fs.readFile(projectPath, "utf8"));
  assert.deepEqual(written.output, { width: 1080, height: 1920 });
  assert.match(generateComposition(after), /data-width="1080" data-height="1920"/);

  // Other half: nothing about the RECORDING moved. The capture's own frame, its
  // duration, its actions and the zooms derived from them are untouched — which
  // is the point of reframing being an edit rather than a re-record.
  assert.equal(written.width, 1920);
  assert.equal(written.height, 1080);
  assert.equal(written.durationMs, 7000);
  assert.deepEqual(written.actions, before.actions);
  assert.deepEqual(written.zooms, before.zooms);
  assert.equal(written.sourceVideo, before.sourceVideo);
});
