import type { DemoProject } from "@demomotion/schema";
import { sourceToOutput, totalOutputMs, type EditList } from "@demomotion/core";

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
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="${project.width}" data-height="${project.height}" data-fps="${project.fps}" data-start="0" data-duration="${sec(totalMs)}">
    <div id="stage" style="${stageStyle}">
      <div id="cam" style="${camStyle}">
      ${videos}
      </div>
    </div>
    ${callouts}
  </div>
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

      // The camera is driven by a property SETTER, not by an onUpdate callback:
      // GSAP's seek() suppresses callbacks by default, but it always writes the
      // tweened property. So the frame is correct whichever seek API drives it.
      var driver = { _t: 0 };
      Object.defineProperty(driver, "t", {
        configurable: true,
        get: function () { return this._t; },
        set: function (value) { this._t = value; apply(value); }
      });

      window.__timelines = window.__timelines || {};
      var tl = gsap.timeline({ paused: true });
      tl.to(driver, { t: TOTAL, duration: TOTAL, ease: "none" }, 0);
      apply(0);
      window.__timelines["root"] = tl;
    })();
  </script>
</body>
</html>
`;
}
