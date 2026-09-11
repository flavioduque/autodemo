import {
  type DemoAction, type DemoZoom, type DurationMs,
  SOURCE_ZERO, durationMs, addMs, subMs, minOf, maxOf, captureEnd
} from "@demomotion/schema";

/** How far ahead of the interaction a zoom opens: the eye arrives before the click. */
const ZOOM_LEAD_MS: DurationMs = durationMs(220);
/** How long a zoom stays on a click, and on a fill (typing takes longer to read). */
const ZOOM_CLICK_HOLD_MS: DurationMs = durationMs(1200);
const ZOOM_FILL_HOLD_MS: DurationMs = durationMs(1450);
/** Two zooms closer than this (and near each other on screen) merge into one. */
const ZOOM_MERGE_GAP_MS: DurationMs = durationMs(120);

export function buildAutoZooms(actions: DemoAction[], captureDurationMs: DurationMs): DemoZoom[] {
  const end = captureEnd(captureDurationMs);
  const candidates = actions
    .filter((a) => (a.type === "click" || a.type === "fill") && typeof a.x === "number" && typeof a.y === "number")
    .map((a) => ({
      fromMs: maxOf(SOURCE_ZERO, subMs(a.atMs, ZOOM_LEAD_MS)),
      toMs: minOf(end, addMs(a.atMs, a.type === "fill" ? ZOOM_FILL_HOLD_MS : ZOOM_CLICK_HOLD_MS)),
      x: a.x!,
      y: a.y!,
      scale: a.type === "fill" ? 1.22 : 1.36
    }))
    .filter((z) => z.toMs > z.fromMs);

  const merged: DemoZoom[] = [];
  for (const current of candidates) {
    const last = merged.at(-1);
    if (last && current.fromMs <= addMs(last.toMs, ZOOM_MERGE_GAP_MS) && distance(last, current) < 0.16) {
      last.toMs = maxOf(last.toMs, current.toMs);
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
export * from "./captions.ts";
export * from "./framing.ts";
