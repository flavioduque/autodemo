import type { DemoAction, DemoZoom } from "@demomotion/schema";

export function buildAutoZooms(actions: DemoAction[], durationMs: number): DemoZoom[] {
  const candidates = actions
    .filter((a) => (a.type === "click" || a.type === "fill") && typeof a.x === "number" && typeof a.y === "number")
    .map((a) => ({
      fromMs: Math.max(0, a.atMs - 220),
      toMs: Math.min(durationMs, a.atMs + (a.type === "fill" ? 1450 : 1200)),
      x: a.x!,
      y: a.y!,
      scale: a.type === "fill" ? 1.22 : 1.36
    }))
    .filter((z) => z.toMs > z.fromMs);

  const merged: DemoZoom[] = [];
  for (const current of candidates) {
    const last = merged.at(-1);
    if (last && current.fromMs <= last.toMs + 120 && distance(last, current) < 0.16) {
      last.toMs = Math.max(last.toMs, current.toMs);
      last.x = (last.x + current.x) / 2;
      last.y = (last.y + current.y) / 2;
      last.scale = Math.max(last.scale, current.scale);
    } else {
      merged.push({...current});
    }
  }
  return merged;
}

function distance(a: {x:number;y:number}, b: {x:number;y:number}) {
  return Math.hypot(a.x-b.x, a.y-b.y);
}

export function compactInteractiveElements(items: Array<{tag:string; text:string; role?:string; selector:string}>, limit = 80) {
  return items
    .filter((i) => i.text || i.role || ["input","button","a","select","textarea"].includes(i.tag))
    .slice(0, limit);
}

export * from "./editlist.ts";
export * from "./cursor.ts";
