import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli.ts";

// The bin is the ONLY way an npx user reaches the server. What the parser
// refuses cannot be launched at all, so the accepted grammar is a seam.

test("no arguments means the MCP stdio server, and `mcp` says so explicitly", () => {
  assert.deepEqual(parseArgs([]), { command: "mcp" });
  assert.deepEqual(parseArgs(["mcp"]), { command: "mcp" });
});

test("render takes a project path and an optional --out", () => {
  assert.deepEqual(parseArgs(["render", "p.json"]), { command: "render", project: "p.json", out: undefined });
  assert.deepEqual(parseArgs(["render", "p.json", "--out", "x.mp4"]), { command: "render", project: "p.json", out: "x.mp4" });
  assert.deepEqual(parseArgs(["render", "--out", "x.mp4", "p.json"]), { command: "render", project: "p.json", out: "x.mp4" });
  assert.deepEqual(parseArgs(["render", "p.json", "--out=x.mp4"]), { command: "render", project: "p.json", out: "x.mp4" });
});

test("version and help, in both spellings", () => {
  assert.deepEqual(parseArgs(["--version"]), { command: "version" });
  assert.deepEqual(parseArgs(["-v"]), { command: "version" });
  assert.deepEqual(parseArgs(["--help"]), { command: "help" });
  assert.deepEqual(parseArgs(["-h"]), { command: "help" });
  assert.deepEqual(parseArgs(["help"]), { command: "help" });
});

test("the negative half: what is refused is refused by name", () => {
  assert.throws(() => parseArgs(["render"]), /render needs a project\.json path/);
  assert.throws(() => parseArgs(["render", "a.json", "b.json"]), /unexpected argument: b\.json/);
  assert.throws(() => parseArgs(["render", "a.json", "--out"]), /--out needs a file path/);
  assert.throws(() => parseArgs(["render", "a.json", "--nope"]), /unknown option: --nope/);
  assert.throws(() => parseArgs(["mcp", "extra"]), /unexpected argument: extra/);
  assert.throws(() => parseArgs(["frobnicate"]), /unknown command: frobnicate/);
});
