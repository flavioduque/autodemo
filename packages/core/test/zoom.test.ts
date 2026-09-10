import test from "node:test";
import assert from "node:assert/strict";
import { buildAutoZooms } from "../src/index.ts";

const action = (overrides: Record<string, unknown>) => ({
  id: crypto.randomUUID(), type: "click" as const, atMs: 1000, durationMs: 20, x: .5, y: .5, ...overrides
});

test("creates click zoom around interaction", () => {
  const z = buildAutoZooms([action({})], 5000);
  assert.equal(z.length, 1);
  assert.equal(z[0].fromMs, 780);
  assert.equal(z[0].toMs, 2200);
  assert.equal(z[0].scale, 1.36);
});

test("merges nearby overlapping interactions", () => {
  const z = buildAutoZooms([
    action({atMs: 1000, x: .50, y: .50}),
    action({atMs: 1500, x: .54, y: .52})
  ], 5000);
  assert.equal(z.length, 1);
  assert.ok(z[0].toMs >= 2700);
});

test("does not create zoom when coordinates are absent", () => {
  const z = buildAutoZooms([action({x: undefined, y: undefined})], 5000);
  assert.equal(z.length, 0);
});
