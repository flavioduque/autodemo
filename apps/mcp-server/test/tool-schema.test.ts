import test from "node:test";
import assert from "node:assert/strict";
import { projectUpdateInput, browserFillInput } from "../src/index.ts";

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

// The default matters as much as the knob. An agent sends what it is told to
// send: an optional "look less rushed" parameter would stay unset on almost
// every demo, and browser_fill would keep producing the instant, machine-looking
// fill the feedback was about. So typing is what an unspecified call gets.
test("browser_fill types by default, and instant is an explicit opt-out", () => {
  // Positive half: a call that says nothing about typing still types, in the
  // 25-60 ms/char band the tool documents.
  const plain = browserFillInput.parse({
    sessionId: "s", selector: "#name", value: "Ada Lovelace"
  });
  assert.ok(plain.typeDelayMs >= 25 && plain.typeDelayMs <= 60,
    `an unspecified browser_fill got typeDelayMs ${plain.typeDelayMs}, outside the documented 25-60 ms band`);

  // The other half: the escape hatch is reachable, and so is an explicit slower
  // pace. Without this, a change that ignored the parameter entirely would pass.
  assert.equal(browserFillInput.parse({
    sessionId: "s", selector: "#token", value: "8f2c-uuid", typeDelayMs: 0
  }).typeDelayMs, 0);
  assert.equal(browserFillInput.parse({
    sessionId: "s", selector: "#name", value: "Ada", typeDelayMs: 60
  }).typeDelayMs, 60);

  // Negative half: the bounds are real. A negative delay is meaningless and a
  // huge one outlasts anyone's patience.
  assert.equal(browserFillInput.safeParse({
    sessionId: "s", selector: "#name", value: "Ada", typeDelayMs: -1
  }).success, false);
  assert.equal(browserFillInput.safeParse({
    sessionId: "s", selector: "#name", value: "Ada", typeDelayMs: 5000
  }).success, false);
});
