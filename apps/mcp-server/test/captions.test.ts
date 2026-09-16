import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DemoProjectSchema } from "@autodemo/schema";
import { buildProject, updateProject } from "../src/project.ts";
import { projectUpdateInput } from "../src/server.ts";

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
  editList: [{ sourceFromMs: 0, sourceToMs: 10000, speed: 1 }],
  callouts: [],
  ...overrides
});

test("the schema accepts a caption track and treats its absence as 'no captions'", () => {
  // Half one: a project written before captions existed stays valid, and the
  // missing field means an empty track — NOT the silent death `trims` died of.
  const legacy = DemoProjectSchema.parse(baseProject());
  assert.deepEqual(legacy.captions, []);

  // Half two: a real caption with per-word timestamps survives parsing intact.
  const withCaptions = DemoProjectSchema.parse(baseProject({
    captions: [{
      fromMs: 1000,
      toMs: 3000,
      text: "Open the panel",
      words: [
        { text: "Open", fromMs: 1000, toMs: 1800 },
        { text: "the", fromMs: 1800, toMs: 2300 },
        { text: "panel", fromMs: 2300, toMs: 3000 }
      ]
    }]
  }));
  assert.equal(withCaptions.captions.length, 1);
  assert.equal(withCaptions.captions[0].words.length, 3);
  assert.equal(withCaptions.captions[0].words[2].toMs, 3000);
});

test("the schema refuses a caption window that does not move forward", () => {
  assert.equal(DemoProjectSchema.safeParse(baseProject({
    captions: [{ fromMs: 2000, toMs: 2000, text: "x", words: [] }]
  })).success, false);
  assert.equal(DemoProjectSchema.safeParse(baseProject({
    captions: [{ fromMs: 2000, toMs: 1000, text: "x", words: [] }]
  })).success, false);
  // And empty caption text is not a caption.
  assert.equal(DemoProjectSchema.safeParse(baseProject({
    captions: [{ fromMs: 0, toMs: 1000, text: "", words: [] }]
  })).success, false);
});

test("project_update accepts captions, so prose can be written without re-recording", async (t) => {
  // Half one: the MCP tool surface takes the field. A field refused here cannot
  // be edited at all — this is the seam `trims` died at.
  const parsed = projectUpdateInput.parse({
    projectPath: "/tmp/project.json",
    captions: [{
      fromMs: 500,
      toMs: 2500,
      text: "We start on the dashboard",
      words: [{ text: "We", fromMs: 500, toMs: 900 }, { text: "start", fromMs: 900, toMs: 2500 }]
    }]
  });
  assert.equal(parsed.captions?.length, 1);
  assert.equal(parsed.captions?.[0].words.length, 2);

  // Half two: it survives all the way to disk, through updateProject.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autodemo-caption-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manifestPath = path.join(dir, "capture.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    videoPath: path.join(dir, "page.webm"),
    width: 1920, height: 1080, durationMs: 7000,
    actions: [{ id: "a1", type: "click", atMs: 3000, durationMs: 20, x: 0.5, y: 0.5 }]
  }));
  const { project: before, projectPath } = await buildProject(manifestPath, "Caption me");
  // Control: this capture has no labels, so the skeleton is empty and the
  // assertion below cannot pass over a track that was already full.
  assert.deepEqual(before.captions, []);

  await updateProject(projectPath, { captions: parsed.captions });
  const written = JSON.parse(await fs.readFile(projectPath, "utf8"));
  assert.equal(written.captions.length, 1);
  assert.equal(written.captions[0].text, "We start on the dashboard");
  // Everything the patch did not mention survived.
  assert.deepEqual(written.editList, before.editList);
  assert.equal(written.title, "Caption me");
});

test("buildProject seeds a caption skeleton from the labels the recorder captured", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autodemo-caption-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const manifestPath = path.join(dir, "capture.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    videoPath: path.join(dir, "page.webm"),
    width: 1920, height: 1080, durationMs: 9000,
    actions: [
      { id: "a1", type: "click", atMs: 1000, durationMs: 20, x: 0.4, y: 0.3, label: "New client" },
      { id: "a2", type: "click", atMs: 5000, durationMs: 20, x: 0.6, y: 0.7 },
      { id: "a3", type: "click", atMs: 6000, durationMs: 20, x: 0.6, y: 0.7, label: "Save" }
    ]
  }));

  const { project } = await buildProject(manifestPath, "Labelled demo");

  // Half one: labelled actions become captions, already timed and split by word.
  assert.equal(project.captions.length, 2);
  assert.equal(project.captions[0].text, "New client");
  assert.equal(project.captions[0].fromMs, 1000);
  assert.equal(project.captions[0].toMs, 3200); // 1000 + CAPTION_HOLD_MS (2200)
  assert.deepEqual(project.captions[0].words.map((w) => w.text), ["New", "client"]);
  assert.equal(project.captions[0].words.at(-1)!.toMs, 3200);

  // Half two: the unlabelled action produced nothing — the skeleton follows the
  // labels, it does not invent a caption for every click.
  assert.deepEqual(project.captions.map((c) => c.text), ["New client", "Save"]);
});

test("the caption style knobs are reachable from the MCP surface", () => {
  // A knob the tool refuses cannot be dialled at all — the `trims` lesson. So
  // the surface must carry every style field the compositor reads.
  const parsed = projectUpdateInput.parse({
    projectPath: "/tmp/project.json",
    style: { captionColor: "#cccccc", captionActiveColor: "#fff000", captionAccent: "#ff0000", captionEmphasis: 0.2, captionScale: 1.4 }
  });
  assert.equal(parsed.style?.captionActiveColor, "#fff000");
  assert.equal(parsed.style?.captionEmphasis, 0.2);

  // Other half: the range is enforced here too, not only deeper in the schema.
  assert.equal(projectUpdateInput.safeParse({
    projectPath: "/tmp/project.json", style: { captionEmphasis: 3 }
  }).success, false);
});
