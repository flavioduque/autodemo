import type { DemoProject } from "@demomotion/schema";
import { sourceToOutput, totalOutputMs, cursorTrack, CURSOR_APPROACH_MS, CURSOR_PULSE_MS, type EditList } from "@demomotion/core";

/** Seconds, trimmed to a stable decimal form. No locale, no rounding surprises. */
function sec(ms: number): string {
  return String(Number((ms / 1000).toFixed(6)));
}

/** CSS pixels, same stable decimal form. */
function cssPx(value: number): string {
  return `${Number(value.toFixed(6))}px`;
}

/**
 * The content box: the largest rectangle with the SOURCE aspect ratio that fits
 * inside the padded frame. Letterboxing, never cropping — this is the fix for
 * the `objectFit: "cover"` defect, which silently discarded 4.82% of the frame.
 */
export function contentBox(project: DemoProject) {
  const pad = project.style.padding;
  const frameW = project.width - pad * 2;
  const frameH = project.height - pad * 2;
  const sourceAspect = project.width / project.height;
  const width = Math.min(frameW, frameH * sourceAspect);
  const height = width / sourceAspect;
  return { width, height, left: (project.width - width) / 2, top: (project.height - height) / 2 };
}

/** One camera move, already projected onto the output time base (seconds). */
export type CameraKeyframe = { start: number; end: number; scale: number; x: number; y: number };

/** Rounds to a stable number of decimals without dragging in float noise. */
function round(value: number, decimals = 6): number {
  return Number(value.toFixed(decimals));
}

/**
 * Projects the zoom track from sourceMs onto outputMs through the EditList.
 * Spec section 3: zooms are anchored in what happened, not in where it ended up.
 */
export function cameraTrack(project: DemoProject): CameraKeyframe[] {
  const track: CameraKeyframe[] = [];
  for (const zoom of project.zooms) {
    const span = projectSpan(project.editList, zoom.fromMs, zoom.toMs);
    if (!span) continue;
    track.push({ start: span.start, end: span.end, scale: zoom.scale, x: zoom.x, y: zoom.y });
  }
  return track.sort((a, b) => a.start - b.start);
}

/**
 * Projects a [fromMs, toMs) source span onto the output time base, in seconds.
 *
 * Returns null when the span's anchor instant was cut — it belongs to no segment,
 * so there is no moment in the final video to show it at. A span that runs past
 * the end of its own segment is clipped there: the material it was describing
 * stops at the cut, so the overlay must stop with it.
 */
function projectSpan(list: EditList, fromMs: number, toMs: number): { start: number; end: number } | null {
  const startMs = sourceToOutput(list, fromMs);
  if (startMs === null) return null;
  const segment = list.find((s) => fromMs >= s.sourceFromMs && fromMs < s.sourceToMs);
  if (!segment) return null;
  const clampedToMs = Math.min(toMs, segment.sourceToMs);
  const endMs = startMs + (clampedToMs - fromMs) / segment.speed;
  if (endMs <= startMs) return null;
  return { start: round(startMs / 1000), end: round(endMs / 1000) };
}

/** Minimal HTML text/attribute escaping. Callout text is author-supplied. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type CompositorOptions = {
  /** Relative src for the source clip, as placed beside index.html. */
  videoSrc?: string;
  /** Relative src for the GSAP runtime, vendored beside index.html. */
  gsapSrc?: string;
};

export function generateComposition(project: DemoProject, options: CompositorOptions = {}): string {
  const videoSrc = options.videoSrc ?? "source.webm";
  const gsapSrc = options.gsapSrc ?? "gsap.min.js";
  const totalMs = totalOutputMs(project.editList);
  if (totalMs <= 0) {
    throw new Error("Cannot render: the project's edit list keeps no material, so the output would be empty.");
  }
  const box = contentBox(project);
  const cameraJson = JSON.stringify(cameraTrack(project));

  // The cursor is a SYNTHETIC layer: the deterministic screencast never draws the
  // pointer, so we composite it. Like zooms and callouts it is anchored in
  // sourceMs (its keyframes are action instants); the runtime projects OUTPUT time
  // back to sourceMs through the EditList, so a click whose instant was cut is
  // never sampled and its pulse never fires. The pointer is drawn at a constant
  // pixel size OUTSIDE the #cam wrapper, so the camera zoom does not scale it. That
  // it still lands on the clicked control under zoom is not luck: the auto-zoom is
  // centred on the same (x,y), and a CSS scale leaves its transform-origin fixed.
  const cursorJson = JSON.stringify({
    track: cursorTrack(project.actions),
    editList: project.editList,
    approachMs: CURSOR_APPROACH_MS,
    pulseMs: CURSOR_PULSE_MS
  });

  // Callouts live in sourceMs too (spec section 3), so they travel through the
  // same projection: cut the material and the callout moves or disappears with it.
  const callouts = project.callouts.flatMap((callout, index) => {
    const span = projectSpan(project.editList, callout.fromMs, callout.toMs);
    if (!span) return [];
    const style = `left:${round(callout.x * 100, 4)}%;top:${round(callout.y * 100, 4)}%`;
    return [`<div id="callout-${index}" class="callout" data-start="${span.start}" data-duration="${round(span.end - span.start)}" data-track-index="1" style="${style}">${escapeHtml(callout.text)}</div>`];
  }).join("\n    ");

  // Clip starts are the cumulative output positions of the edit list. Each clip's
  // duration is derived from the NEXT clip's start (and the last one from the
  // composition's end) so the track tiles the composition with no gap and no
  // uncovered tail. A gap or a short tail renders silently black.
  const starts: number[] = [];
  let cursor = 0;
  for (const segment of project.editList) {
    starts.push(cursor);
    cursor += (segment.sourceToMs - segment.sourceFromMs) / segment.speed;
  }

  const videos = project.editList.map((segment, i) => {
    const startMs = starts[i];
    const endMs = i + 1 < starts.length ? starts[i + 1] : totalMs;
    return `<video id="clip-${i}" class="seg" data-start="${sec(startMs)}" data-duration="${sec(endMs - startMs)}"`
      + ` data-media-start="${sec(segment.sourceFromMs)}" data-playback-rate="${segment.speed}"`
      + ` data-track-index="0" src="${escapeHtml(videoSrc)}" muted playsinline></video>`;
  }).join("\n      ");

  const stageStyle = [
    "position:absolute",
    `left:${cssPx(box.left)}`,
    `top:${cssPx(box.top)}`,
    `width:${cssPx(box.width)}`,
    `height:${cssPx(box.height)}`,
    "overflow:hidden",
    `border-radius:${cssPx(project.style.radius)}`,
    "background:#000",
    project.style.shadow ? "box-shadow:0 30px 80px rgba(0,0,0,0.45)" : "box-shadow:none"
  ].join(";");

  const camStyle = ["position:absolute", "left:0", "top:0", `width:${cssPx(box.width)}`, `height:${cssPx(box.height)}`, "will-change:transform"].join(";");

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${project.width}px;height:${project.height}px;overflow:hidden;background:${project.style.background}}
  #root{position:relative;width:${project.width}px;height:${project.height}px;overflow:hidden;background:${project.style.background}}
  video.seg{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain;display:block}
  .callout{position:absolute;transform:translate(-50%,-50%);max-width:${Math.round(project.width * 0.7)}px;
    padding:16px 24px;border-radius:18px;background:rgba(8,12,24,.88);color:#fff;
    font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
    font-size:${Math.max(22, Math.round(project.width * 0.018))}px;font-weight:650;line-height:1.2;
    box-shadow:0 16px 50px rgba(0,0,0,.32)}
  /* Synthetic cursor. The SVG path tip is at its (0,0), so left/top is the tip.
     Drawn at a constant pixel size and OUTSIDE #cam, so the camera never scales it. */
  #cursor{position:absolute;left:0;top:0;width:28px;height:28px;opacity:0;pointer-events:none;
    overflow:visible;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));will-change:left,top,opacity;z-index:2}
  #cursor-ring{position:absolute;left:0;top:0;width:46px;height:46px;margin:-23px 0 0 -23px;
    border-radius:50%;border:3px solid rgba(56,189,248,.95);opacity:0;pointer-events:none;
    transform:scale(.3);will-change:transform,opacity;z-index:2}
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="${project.width}" data-height="${project.height}" data-fps="${project.fps}" data-start="0" data-duration="${sec(totalMs)}">
    <div id="stage" style="${stageStyle}">
      <div id="cam" style="${camStyle}">
      ${videos}
      </div>
      <div id="cursor-ring"></div>
      <svg id="cursor" width="28" height="28" viewBox="0 0 16 20" aria-hidden="true"><path d="M0 0 L0 15 L4.2 11.3 L6.9 17.8 L9.3 16.8 L6.6 10.4 L12 10.4 Z" fill="#fff" stroke="#12151c" stroke-width="1.1" stroke-linejoin="round"/></svg>
    </div>
    ${callouts}
  </div>
  <script type="application/json" id="demomotion-cursor">${cursorJson}</script>
  <script type="application/json" id="demomotion-camera">${cameraJson}</script>
  <script src="${escapeHtml(gsapSrc)}"></script>
  <script>
    // The camera is a PURE FUNCTION of output time, evaluated with real GSAP
    // eases. HyperFrames renders frames out of order across parallel workers, so
    // nothing here may depend on the order in which times are visited.
    (function () {
      var camera = JSON.parse(document.getElementById("demomotion-camera").textContent);
      var cam = document.getElementById("cam");
      var easeIn = gsap.parseEase("power3.out");
      var easeOut = gsap.parseEase("power2.inOut");
      var TOTAL = ${sec(totalMs)};

      function cameraAt(t) {
        for (var i = 0; i < camera.length; i++) {
          var k = camera[i];
          if (t < k.start || t >= k.end) continue;
          var span = k.end - k.start;
          var enter = Math.min(0.25, span * 0.3);
          var exit = Math.min(0.3, span * 0.3);
          var amount = k.scale - 1;
          var scale;
          if (t < k.start + enter) scale = 1 + amount * easeIn((t - k.start) / enter);
          else if (t > k.end - exit) scale = 1 + amount * (1 - easeOut((t - (k.end - exit)) / exit));
          else scale = k.scale;
          return { scale: scale, x: k.x, y: k.y };
        }
        return { scale: 1, x: 0.5, y: 0.5 };
      }

      function apply(t) {
        var c = cameraAt(t);
        cam.style.transformOrigin = c.x * 100 + "% " + c.y * 100 + "%";
        cam.style.transform = "scale(" + c.scale + ")";
      }

      // --- Synthetic cursor layer. Anchored in sourceMs; projected to output
      // through the EditList, so a click whose instant was cut is never sampled
      // and its pulse never fires. outputToSource and cursorAt mirror the pure
      // @demomotion/core functions exactly (same windows, same easing). ---
      var cursorData = JSON.parse(document.getElementById("demomotion-cursor").textContent);
      var cursorKf = cursorData.track;
      var cursorEdit = cursorData.editList;
      var APPROACH = cursorData.approachMs;
      var PULSE = cursorData.pulseMs;
      var cursorEl = document.getElementById("cursor");
      var ringEl = document.getElementById("cursor-ring");

      function outputToSource(ms) {
        var from = 0;
        for (var i = 0; i < cursorEdit.length; i++) {
          var s = cursorEdit[i];
          var to = from + (s.sourceToMs - s.sourceFromMs) / s.speed;
          if (ms >= from && ms < to) return s.sourceFromMs + (ms - from) * s.speed;
          from = to;
        }
        return null;
      }

      function cursorEaseOut(p) { return 1 - Math.pow(1 - p, 3); }

      function cursorAt(sourceMs) {
        if (cursorKf.length === 0 || sourceMs < cursorKf[0].sourceMs) return null;
        var pi = 0;
        for (var i = 0; i < cursorKf.length; i++) { if (cursorKf[i].sourceMs <= sourceMs) pi = i; else break; }
        var prev = cursorKf[pi], next = cursorKf[pi + 1];
        var x = prev.x, y = prev.y;
        if (next) {
          var aStart = Math.max(prev.sourceMs, next.sourceMs - APPROACH);
          if (sourceMs > aStart) {
            var p = cursorEaseOut((sourceMs - aStart) / (next.sourceMs - aStart));
            x = prev.x + (next.x - prev.x) * p;
            y = prev.y + (next.y - prev.y) * p;
          }
        }
        var phase = null;
        for (var j = 0; j < cursorKf.length; j++) {
          var k = cursorKf[j];
          if (k.click && sourceMs >= k.sourceMs && sourceMs < k.sourceMs + PULSE) { phase = (sourceMs - k.sourceMs) / PULSE; break; }
        }
        return { x: x, y: y, clickPhase: phase };
      }

      function applyCursor(t) {
        var sourceMs = outputToSource(t * 1000);
        var s = sourceMs === null ? null : cursorAt(sourceMs);
        if (!s) { cursorEl.style.opacity = "0"; ringEl.style.opacity = "0"; return; }
        cursorEl.style.left = s.x * 100 + "%";
        cursorEl.style.top = s.y * 100 + "%";
        cursorEl.style.opacity = "1";
        if (s.clickPhase === null) { ringEl.style.opacity = "0"; return; }
        // The ring expands and fades on the click: a beat a raw recording lacks.
        ringEl.style.left = s.x * 100 + "%";
        ringEl.style.top = s.y * 100 + "%";
        ringEl.style.transform = "scale(" + (0.35 + s.clickPhase * 1.05) + ")";
        ringEl.style.opacity = "" + (0.6 * (1 - s.clickPhase));
      }

      // The camera is driven by a property SETTER, not by an onUpdate callback:
      // GSAP's seek() suppresses callbacks by default, but it always writes the
      // tweened property. So the frame is correct whichever seek API drives it.
      var driver = { _t: 0 };
      Object.defineProperty(driver, "t", {
        configurable: true,
        get: function () { return this._t; },
        set: function (value) { this._t = value; apply(value); applyCursor(value); }
      });

      window.__timelines = window.__timelines || {};
      var tl = gsap.timeline({ paused: true });
      tl.to(driver, { t: TOTAL, duration: TOTAL, ease: "none" }, 0);
      apply(0);
      applyCursor(0);
      window.__timelines["root"] = tl;
    })();
  </script>
</body>
</html>
`;
}
