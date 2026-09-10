import test from "node:test";
import assert from "node:assert/strict";
import { projectUpdateInput } from "../src/index.ts";

// The MCP tool surface is the only interface this product has. What the tool
// refuses to accept cannot be edited at all, so the tool schema is a seam in
// its own right — a field accepted here but dropped later dies silently, which
// is exactly how `trims` died.

test("project_update accepts an editList and no longer accepts trims", () => {
  // Positive half: an edit with a cut and a speed ramp goes through intact.
  const parsed = projectUpdateInput.parse({
    projectPath: "/tmp/project.json",
    editList: [
      { sourceFromMs: 0, sourceToMs: 2000, speed: 1 },
      { sourceFromMs: 5000, sourceToMs: 8000, speed: 2 }
    ]
  });
  assert.equal(parsed.editList?.length, 2);
  assert.equal(parsed.editList?.[1].speed, 2);

  // Negative half: `trims` is not part of the surface any more, so an agent
  // that still sends it gets nothing — the key never reaches updateProject.
  const legacy = projectUpdateInput.parse({
    projectPath: "/tmp/project.json",
    trims: [{ fromMs: 1000, toMs: 2000 }]
  });
  assert.equal("trims" in legacy, false);

  // Negative half: the same segment validation as the project schema applies.
  assert.equal(projectUpdateInput.safeParse({
    projectPath: "/tmp/project.json",
    editList: [{ sourceFromMs: 1000, sourceToMs: 1000, speed: 1 }]
  }).success, false);
  assert.equal(projectUpdateInput.safeParse({
    projectPath: "/tmp/project.json",
    editList: [{ sourceFromMs: 0, sourceToMs: 1000, speed: 0 }]
  }).success, false);
});
