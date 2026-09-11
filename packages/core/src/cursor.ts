import { type DemoAction, type SourceTimeMs, type DurationMs, durationMs, addMs, subMs, spanMs, maxOf } from "@demomotion/schema";

export type CursorSample = { x: number; y: number; visible: boolean; clickPhase: number | null };
export type CursorKeyframe = { sourceMs: SourceTimeMs; x: number; y: number; click: boolean };

/**
 * How long before a target the cursor takes to travel to it. The cursor holds on
 * the previous target and only starts moving inside this window, Screen-Studio
 * style — a raw recording has no such anticipation. 450-600 ms reads as purposeful
 * without feeling laggy; 500 is the middle of that band.
 */
export const CURSOR_APPROACH_MS: DurationMs = durationMs(500);

/** How long the click pulse stays alive after a click instant (350-450 ms band). */
export const CURSOR_PULSE_MS: DurationMs = durationMs(400);

function positioned(actions: DemoAction[]): CursorKeyframe[] {
  return actions
    .filter((a) => typeof a.x === "number" && typeof a.y === "number")
    .map((a) => ({ sourceMs: a.atMs, x: a.x!, y: a.y!, click: a.type === "click" }))
    .sort((p, q) => p.sourceMs - q.sourceMs);
}

/** The positioned keyframes the cursor is pinned to, in sourceMs order. */
export function cursorTrack(actions: DemoAction[]): CursorKeyframe[] {
  return positioned(actions);
}

/** Ease-out (quickly off the mark, then settling). p in [0,1]. */
function easeOut(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}

export function cursorAt(actions: DemoAction[], sourceMs: SourceTimeMs): CursorSample {
  const kf = positioned(actions);
  if (kf.length === 0 || sourceMs < kf[0].sourceMs) {
    return { x: 0, y: 0, visible: false, clickPhase: null };
  }

  // `prevIndex` is the last target reached at or before this instant.
  let prevIndex = 0;
  for (let i = 0; i < kf.length; i++) {
    if (kf[i].sourceMs <= sourceMs) prevIndex = i;
    else break;
  }
  const prev = kf[prevIndex];
  const next = kf[prevIndex + 1];

  let x = prev.x;
  let y = prev.y;
  if (next) {
    // The approach opens APPROACH_MS before `next`, but never before `prev` was
    // reached (targets closer together share a shorter window). Before it, the
    // cursor holds on `prev`; inside it, it eases from `prev` to `next`.
    const approachStart = maxOf(prev.sourceMs, subMs(next.sourceMs, CURSOR_APPROACH_MS));
    if (sourceMs > approachStart) {
      const p = easeOut(spanMs(sourceMs, approachStart) / spanMs(next.sourceMs, approachStart));
      x = prev.x + (next.x - prev.x) * p;
      y = prev.y + (next.y - prev.y) * p;
    }
  }

  // The pulse belongs to a click instant, alive for [clickMs, clickMs + PULSE_MS).
  // Fills position the cursor but do not pulse — only a real click rings.
  let clickPhase: number | null = null;
  for (const k of kf) {
    if (k.click && sourceMs >= k.sourceMs && sourceMs < addMs(k.sourceMs, CURSOR_PULSE_MS)) {
      clickPhase = spanMs(sourceMs, k.sourceMs) / CURSOR_PULSE_MS;
      break;
    }
  }

  return { x, y, visible: true, clickPhase };
}
