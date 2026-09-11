import type { DemoProject } from "@demomotion/schema";
import { outputSize, sourceSize } from "@demomotion/schema";
import { sourceToOutput, totalOutputMs, cursorTrack, framingTrack, referenceCrop, CURSOR_APPROACH_MS, CURSOR_PULSE_MS, type EditList } from "@demomotion/core";

/** Seconds, trimmed to a stable decimal form. No locale, no rounding surprises. */
function sec(ms: number): string {
  return String(Number((ms / 1000).toFixed(6)));
}

/** CSS pixels, same stable decimal form. */
function cssPx(value: number): string {
  return `${Number(value.toFixed(6))}px`;
}

/**
 * The content box: the largest rectangle with the CAMERA's aspect ratio that
 * fits inside the padded OUTPUT frame. Letterboxing against the background,
 * never cropping the camera — this is the fix for the `objectFit: "cover"`
 * defect, which silently discarded 4.82% of the frame.
 *
 * The camera's aspect ratio is the output frame's, because the camera rectangle
 * is what fills this box (spec §5). Without reframing the output frame IS the
 * source frame, so this is the source aspect ratio and the box is exactly what
 * it always was.
 */
export function contentBox(project: DemoProject) {
  const pad = project.style.padding;
  const out = outputSize(project);
  const frameW = out.width - pad * 2;
  const frameH = out.height - pad * 2;
  const cameraAspect = out.width / out.height;
  const width = Math.min(frameW, frameH * cameraAspect);
  const height = width / cameraAspect;
  return { width, height, left: (out.width - width) / 2, top: (out.height - height) / 2 };
}

/**
 * The reframing crop: which slice of the source frame the output frame shows.
 *
 * `null` when the two frames have the same aspect ratio — the overwhelmingly
 * common case, and the one that must render byte-for-byte as it did before
 * reframing existed. The comparison is a CROSS PRODUCT so that "the same aspect"
 * is exact for any pixel size, 1920x1080 and 3840x2160 included.
 */
export function reframeCrop(project: DemoProject): { width: number; height: number } | null {
  const source = sourceSize(project);
  const out = outputSize(project);
  if (out.width * source.height === out.height * source.width) return null;
  return referenceCrop(source, out);
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


/** One caption, already projected onto the output time base (seconds). */
export type CaptionLayer = {
  id: string;
  /** The whole line, kept for the case where a caption carries no word timings. */
  text: string;
  start: number;
  end: number;
  words: Array<{ id: string; text: string; start: number; end: number }>;
};

/**
 * Projects the caption track from sourceMs onto outputMs through the EditList.
 *
 * Captions are anchored in what was said over what happened, so they travel the
 * same road as zooms, callouts and the cursor: a caption whose source instant
 * was cut has no moment left to appear at, and a WORD whose instant was cut is
 * dropped from the line it belonged to. A caption clipped by a cut stops with
 * the material it was describing.
 *
 * Overlapping captions are impossible on screen (one line at a time) and
 * illegal on a HyperFrames track (two clips may not overlap on the same
 * data-track-index), so an earlier caption that runs into a later one is
 * trimmed at the later one's start.
 */
export function captionTrack(project: DemoProject): CaptionLayer[] {
  const layers: CaptionLayer[] = [];
  project.captions.forEach((caption, index) => {
    const span = projectSpan(project.editList, caption.fromMs, caption.toMs);
    if (!span) return;
    const id = `cap-${index}`;
    const words: CaptionLayer["words"] = [];
    caption.words.forEach((word, wordIndex) => {
      const wordSpan = projectSpan(project.editList, word.fromMs, word.toMs);
      if (!wordSpan) return;
      // A word that landed outside its own caption's window belongs to material
      // the caption no longer covers — a later segment, after a cut.
      if (wordSpan.start < span.start || wordSpan.start >= span.end) return;
      words.push({ id: `${id}-w-${wordIndex}`, text: word.text, start: wordSpan.start, end: round(Math.min(wordSpan.end, span.end)) });
    });
    layers.push({ id, text: caption.text, start: span.start, end: span.end, words });
  });

  layers.sort((a, b) => a.start - b.start);
  for (let i = 1; i < layers.length; i++) {
    const previous = layers[i - 1];
    if (previous.end > layers[i].start) {
      previous.end = layers[i].start;
      previous.words = previous.words
        .filter((w) => w.start < previous.end)
        .map((w) => ({ ...w, end: round(Math.min(w.end, previous.end)) }));
    }
  }
  return layers.filter((layer) => layer.end > layer.start);
}

/** Minimal HTML text/attribute escaping. Callout and caption text is author-supplied. */
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
  const out = outputSize(project);
  const cameraJson = JSON.stringify(cameraTrack(project));

  // --- Reframing (spec §5) ---------------------------------------------------
  //
  // `crop` is null unless the output frame has a different aspect ratio from the
  // capture. When it is null EVERY line below takes the pre-reframing branch,
  // down to the text of the runtime script, so an existing project renders the
  // document it has always rendered. That is not politeness: reframing is a
  // change that could plausibly crop every demo in existence, and the only proof
  // that it does not is that the untouched case is untouched.
  //
  // When it is not null, #cam is laid out at the size the WHOLE source frame
  // takes when the reference crop exactly covers the stage, and the camera
  // transform slides the wanted rectangle into view. #stage already clips.
  const crop = reframeCrop(project);
  const camBox = crop
    ? { width: box.width / crop.width, height: box.height / crop.height }
    : { width: box.width, height: box.height };
  const frameJson = crop
    ? JSON.stringify({ track: framingTrack(project.actions), crop, camWidth: camBox.width, camHeight: camBox.height })
    : null;
  const frameIsland = frameJson === null
    ? ""
    : `\n  <script type="application/json" id="demomotion-frame">${frameJson}</script>`;

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

  // Captions live in sourceMs like everything else, so they travel through the
  // same projection as zooms and callouts. Each caption is ONE timed clip on its
  // own track; the words inside it are plain spans the runtime highlights.
  const captions = captionTrack(project);
  const captionFontPx = Math.max(22, Math.round(out.width * 0.0225 * project.style.captionScale));
  const captionsHtml = captions.map((layer) => {
    const body = layer.words.length > 0
      ? layer.words.map((w) => `<span class="cap-w" id="${w.id}">${escapeHtml(w.text)}</span>`).join(" ")
      : escapeHtml(layer.text);
    return `<div id="${layer.id}" class="cap clip" data-start="${round(layer.start)}" data-duration="${round(layer.end - layer.start)}" data-track-index="2"><div class="cap-band">${body}</div></div>`;
  }).join("\n    ");

  const captionJson = JSON.stringify({
    groups: captions.map((layer) => ({
      id: layer.id,
      start: layer.start,
      end: layer.end,
      words: layer.words.map((w) => ({ id: w.id, start: w.start, end: w.end }))
    })),
    idle: project.style.captionColor,
    active: project.style.captionActiveColor,
    accent: project.style.captionAccent,
    emphasis: project.style.captionEmphasis
  });

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

  // A cut is a hard jump; the junction the EditList already declares is exactly
  // where a transition belongs. A crossfade between two points of the SAME video
  // needs the two sides ALIVE AT ONCE, which HyperFrames forbids on one track —
  // so clips alternate tracks and the incoming one fades in over the outgoing.
  //
  // The incoming clip starts `lead` earlier and reaches `lead` further back into
  // its own media, i.e. it borrows the HANDLE that a real NLE borrows: the
  // material immediately before the cut. Two consequences, both deliberate:
  //   - the composition's total length does NOT change, so every sourceMs ->
  //     outputMs projection (zooms, callouts, cursor, captions) still holds;
  //   - cut material is briefly on screen, but only UNDER a clip that is still
  //     partly transparent. It is never shown at full opacity.
  // The lead is clamped by both sides: it cannot read before the start of the
  // media, and it cannot start before the clip it is dissolving from.
  const cutMs = project.style.cutTransitionMs;
  const leads = project.editList.map((segment, i) => {
    if (i === 0 || cutMs <= 0) return 0;
    const previousOutputMs = starts[i] - starts[i - 1];
    return Math.max(0, Math.min(cutMs, segment.sourceFromMs / segment.speed, previousOutputMs));
  });

  const videos = project.editList.map((segment, i) => {
    const lead = leads[i];
    const startMs = starts[i] - lead;
    const endMs = i + 1 < starts.length ? starts[i + 1] : totalMs;
    return `<video id="clip-${i}" class="seg" data-start="${sec(startMs)}" data-duration="${sec(endMs - startMs)}"`
      + ` data-media-start="${sec(segment.sourceFromMs - lead * segment.speed)}" data-playback-rate="${segment.speed}"`
      // Neighbours alternate tracks so their overlap is legal; DOM order (not the
      // track index) decides what is painted on top, and the incoming clip is
      // later in the document, so it dissolves IN over the outgoing one.
      + ` data-track-index="${i % 2}" src="${escapeHtml(videoSrc)}" muted playsinline></video>`;
  }).join("\n      ");

  const transitionJson = JSON.stringify({
    crossfades: leads.flatMap((lead, i) => lead > 0 ? [{ id: `clip-${i}`, start: round((starts[i] - lead) / 1000), duration: round(lead / 1000) }] : []),
    opening: round(project.style.openingFadeMs / 1000),
    ending: round(project.style.endingFadeMs / 1000),
    total: round(totalMs / 1000)
  });

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

  const camStyle = ["position:absolute", "left:0", "top:0", `width:${cssPx(camBox.width)}`, `height:${cssPx(camBox.height)}`, "will-change:transform"].join(";");

  // The camera writer and the cursor placer, as TEXT rather than as one function
  // with a branch inside it. When there is no crop these are LITERALLY the lines
  // the composition has emitted since before reframing existed — which is what
  // makes "an un-reframed project renders the same document" a fact about the
  // generator and not a hope about a conditional.
  const applyJs = crop === null
    ? `      function apply(t) {
        var c = cameraAt(t);
        cam.style.transformOrigin = c.x * 100 + "% " + c.y * 100 + "%";
        cam.style.transform = "scale(" + c.scale + ")";
      }`
    : `      // --- Reframing (spec section 5). The output frame's aspect ratio differs
      // from the capture's, so the camera is a RECTANGLE in normalized source
      // coordinates instead of a scale about an origin: it CROPS. #cam holds the
      // whole source frame at CAM_W x CAM_H, and the transform slides the wanted
      // rectangle onto the stage, which clips. frameCentreAt mirrors the pure
      // framingCentreAt in @demomotion/core exactly (same smoothstep, same holds).
      var frameData = JSON.parse(document.getElementById("demomotion-frame").textContent);
      var frameKf = frameData.track;
      var CROP_W = frameData.crop.width;
      var CROP_H = frameData.crop.height;
      var CAM_W = frameData.camWidth;
      var CAM_H = frameData.camHeight;

      function frameClamp(value, max) { return value < 0 ? 0 : value > max ? max : value; }

      function frameCentreAt(sourceMs) {
        if (frameKf.length === 0) return { x: 0.5, y: 0.5 };
        var first = frameKf[0];
        if (sourceMs <= first.sourceMs) return { x: first.x, y: first.y };
        var last = frameKf[frameKf.length - 1];
        if (sourceMs >= last.sourceMs) return { x: last.x, y: last.y };
        var i = 0;
        for (var k = 0; k < frameKf.length; k++) { if (frameKf[k].sourceMs <= sourceMs) i = k; else break; }
        var prev = frameKf[i], next = frameKf[i + 1];
        var u = (sourceMs - prev.sourceMs) / (next.sourceMs - prev.sourceMs);
        // Smoothstep: zero slope at both ends, so the camera dwells on the action
        // it just reached and drifts to the next one instead of snapping.
        var p = u * u * (3 - 2 * u);
        return { x: prev.x + (next.x - prev.x) * p, y: prev.y + (next.y - prev.y) * p };
      }

      // The camera rectangle at OUTPUT time t. The reframing crop is aimed at the
      // action being followed and clamped to the capture's edges; the zoom then
      // shrinks that rectangle around its anchor, keeping the anchor's relative
      // position inside it — the same rule the un-reframed camera follows, which
      // is why a zoom can never push the rectangle out of the crop it lives in.
      function cameraRect(t) {
        var c = cameraAt(t);
        var sourceMs = outputToSource(t * 1000);
        var centre = sourceMs === null ? { x: 0.5, y: 0.5 } : frameCentreAt(sourceMs);
        var fx = frameClamp(centre.x - CROP_W / 2, 1 - CROP_W);
        var fy = frameClamp(centre.y - CROP_H / 2, 1 - CROP_H);
        var u = frameClamp((c.x - fx) / CROP_W, 1);
        var v = frameClamp((c.y - fy) / CROP_H, 1);
        var w = CROP_W / c.scale;
        var h = CROP_H / c.scale;
        return { x: fx + u * (CROP_W - w), y: fy + v * (CROP_H - h), width: w, height: h, scale: c.scale };
      }

      function apply(t) {
        var r = cameraRect(t);
        cam.style.transformOrigin = "0 0";
        cam.style.transform = "translate(" + (-r.x * CAM_W * r.scale) + "px, " + (-r.y * CAM_H * r.scale) + "px) scale(" + r.scale + ")";
      }`;

  const applyCursorJs = crop === null
    ? `      function applyCursor(t) {
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
      }`
    : `      function applyCursor(t) {
        var sourceMs = outputToSource(t * 1000);
        var s = sourceMs === null ? null : cursorAt(sourceMs);
        if (!s) { cursorEl.style.opacity = "0"; ringEl.style.opacity = "0"; return; }
        // Under reframing the stage is a CROP of the capture, so a normalized
        // source point has to travel through the same rectangle the picture does
        // or the pointer lands where the control is not. A point outside the
        // rectangle maps outside the stage, which clips it — the cursor is not
        // drawn over material the vertical cut does not show.
        var r = cameraRect(t);
        var cx = (s.x - r.x) / r.width;
        var cy = (s.y - r.y) / r.height;
        cursorEl.style.left = cx * 100 + "%";
        cursorEl.style.top = cy * 100 + "%";
        cursorEl.style.opacity = "1";
        if (s.clickPhase === null) { ringEl.style.opacity = "0"; return; }
        // The ring expands and fades on the click: a beat a raw recording lacks.
        ringEl.style.left = cx * 100 + "%";
        ringEl.style.top = cy * 100 + "%";
        ringEl.style.transform = "scale(" + (0.35 + s.clickPhase * 1.05) + ")";
        ringEl.style.opacity = "" + (0.6 * (1 - s.clickPhase));
      }`;

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${out.width}px;height:${out.height}px;overflow:hidden;background:${project.style.background}}
  #root{position:relative;width:${out.width}px;height:${out.height}px;overflow:hidden;background:${project.style.background}}
  video.seg{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain;display:block}
  .callout{position:absolute;transform:translate(-50%,-50%);max-width:${Math.round(out.width * 0.7)}px;
    padding:16px 24px;border-radius:18px;background:rgba(8,12,24,.88);color:#fff;
    font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
    font-size:${Math.max(22, Math.round(out.width * 0.018))}px;font-weight:650;line-height:1.2;
    box-shadow:0 16px 50px rgba(0,0,0,.32)}
  /* Synthetic cursor. The SVG path tip is at its (0,0), so left/top is the tip.
     Drawn at a constant pixel size and OUTSIDE #cam, so the camera never scales it. */
  #cursor{position:absolute;left:0;top:0;width:28px;height:28px;opacity:0;pointer-events:none;
    overflow:visible;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));will-change:left,top,opacity;z-index:2}
  #cursor-ring{position:absolute;left:0;top:0;width:46px;height:46px;margin:-23px 0 0 -23px;
    border-radius:50%;border:3px solid rgba(56,189,248,.95);opacity:0;pointer-events:none;
    transform:scale(.3);will-change:transform,opacity;z-index:2}
  /* Caption band: bottom third, full-width flex container so the line centres
     without left:50% + translateX(-50%), which clips at the composition edge
     (references/captions.md, "Container pattern"). The band starts at opacity 0
     and the timeline reveals it — outside its own window a caption cannot leak. */
  /* class="clip" is what the HyperFrames runtime and Studio use to recognise a
     timed element; without it hyperframes lint warns (timed_element_missing_clip_class). */
  .cap{position:absolute;left:0;right:0;bottom:${Math.round(out.height * 0.072)}px;
    display:flex;justify-content:center;opacity:0;pointer-events:none;z-index:3}
  .cap-band{max-width:${Math.round(out.width * 0.72)}px;padding:14px 28px;border-radius:16px;
    /* Scrim, not a bare text shadow: this sits over arbitrary product UI, and a
       shadow alone is not legible over a light dashboard. */
    background:rgba(6,10,22,.86);box-shadow:0 14px 44px rgba(0,0,0,.34);
    font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
    font-size:${captionFontPx}px;font-weight:600;line-height:1.3;text-align:center;text-wrap:balance;
    color:${escapeHtml(project.style.captionColor)};text-shadow:0 2px 6px rgba(0,0,0,.5)}
  /* inline-block so the active word can take a transform; the transparent border
     is the slot the accent underline fades into, so nothing reflows on highlight. */
  /* Horizontal padding, not just the HTML space between spans: the active word
     takes a scale transform, and an inline-block grows from its centre, so at
     rest-adjacent sizes it visually swallows the gap and reads as "wordword".
     The em padding keeps a gap that scales with the type; the HTML space is
     still there so lines can wrap between words. */
  .cap-w{display:inline-block;border-bottom:2px solid rgba(0,0,0,0);
    padding:0 .08em 2px;will-change:transform,color}
  /* Opening and closing fade, painted in the background colour over everything.
     Starts transparent: with both fades at 0 ms it is simply never touched. */
  #fade{position:absolute;left:0;top:0;width:100%;height:100%;background:${project.style.background};
    opacity:0;pointer-events:none;z-index:9}
</style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="${out.width}" data-height="${out.height}" data-fps="${project.fps}" data-start="0" data-duration="${sec(totalMs)}">
    <div id="stage" style="${stageStyle}">
      <div id="cam" style="${camStyle}">
      ${videos}
      </div>
      <div id="cursor-ring"></div>
      <svg id="cursor" width="28" height="28" viewBox="0 0 16 20" aria-hidden="true"><path d="M0 0 L0 15 L4.2 11.3 L6.9 17.8 L9.3 16.8 L6.6 10.4 L12 10.4 Z" fill="#fff" stroke="#12151c" stroke-width="1.1" stroke-linejoin="round"/></svg>
    </div>
    ${callouts}
    ${captionsHtml}
    <div id="fade"></div>
  </div>
  <script type="application/json" id="demomotion-cursor">${cursorJson}</script>
  <script type="application/json" id="demomotion-camera">${cameraJson}</script>
  <script type="application/json" id="demomotion-captions">${captionJson}</script>
  <script type="application/json" id="demomotion-transitions">${transitionJson}</script>${frameIsland}
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

${applyJs}

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

${applyCursorJs}

      // --- Caption layer: word-by-word karaoke. ---
      //
      // The MECHANISM IS COPIED, not invented. Sources, both shipped with the
      // HyperFrames skill:
      //   references/captions.md          — one group element per caption with
      //     per-word spans, one group visible at a time, a hard tl.set kill at
      //     the group's end, and the self-lint below that seeks past each group
      //     and warns if anything is still visible.
      //   references/dynamic-techniques.md — "All energy levels use karaoke
      //     highlight as the baseline... low energy gets a gentle white shift
      //     with 3% scale". This is the low-energy end of that table on purpose:
      //     the captions sit over software UI, where a slam or scatter reads as
      //     cheap. The intensity is the captionEmphasis style knob.
      //
      // Tweens carry the state, never callbacks: GSAP's seek() suppresses
      // onUpdate but always WRITES a tweened property, so a cold render worker
      // landing on any frame resolves the same values. Every tween states both
      // endpoints explicitly (fromTo), so nothing depends on the order frames
      // are visited in.
      var captionData = JSON.parse(document.getElementById("demomotion-captions").textContent);
      var CAP_IDLE = captionData.idle;
      var CAP_ACTIVE = captionData.active;
      var CAP_ACCENT = captionData.accent;
      var CAP_POP = 1 + captionData.emphasis;
      var CAP_CLEAR = "rgba(0,0,0,0)";

      function buildCaptions(tl) {
        captionData.groups.forEach(function (group) {
          var groupEl = document.getElementById(group.id);
          if (!groupEl) return;
          // The band itself: revealed at the group's start, killed at its end.
          // The HyperFrames clip window (data-start/data-duration) already hides
          // it; this makes the kill deterministic on the timeline as well.
          tl.set(groupEl, { opacity: 1 }, group.start);
          tl.set(groupEl, { opacity: 0 }, group.end);

          group.words.forEach(function (word) {
            var el = document.getElementById(word.id);
            if (!el) return;
            // The highlight leads the word rather than lagging it: a short ramp,
            // capped so a long word does not fade in for a second.
            var ramp = Math.max(0.04, Math.min(0.14, (word.end - word.start) * 0.35));
            tl.fromTo(el,
              { color: CAP_IDLE, fontWeight: 600, scale: 1, borderBottomColor: CAP_CLEAR },
              { color: CAP_ACTIVE, fontWeight: 700, scale: CAP_POP, borderBottomColor: CAP_ACCENT,
                duration: ramp, ease: "power2.out" },
              word.start);
            tl.to(el,
              { color: CAP_IDLE, fontWeight: 600, scale: 1, borderBottomColor: CAP_CLEAR,
                duration: ramp, ease: "power2.inOut" },
              word.end);
          });
        });
      }

      // --- Transitions. ---
      //
      // The crossfade is the catalog's baseline dissolve, copied from
      // references/transitions/css-dissolve.md ("Crossfade — simple opacity
      // swap"), with one deliberate difference: only the INCOMING clip is
      // animated. It sits on top (later in the document), so fading it from 0 to
      // 1 over a fully opaque outgoing clip gives out*(1-a) + in*a — a correct
      // dissolve. Fading BOTH would dip the middle of the transition dark.
      //
      // The opening and closing fades are the catalog's "color dip", against the
      // composition background instead of black.
      var transitionData = JSON.parse(document.getElementById("demomotion-transitions").textContent);

      function buildTransitions(tl) {
        transitionData.crossfades.forEach(function (fade) {
          var el = document.getElementById(fade.id);
          if (!el) return;
          tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: fade.duration, ease: "power2.inOut" }, fade.start);
        });

        var fadeEl = document.getElementById("fade");
        if (!fadeEl) return;
        if (transitionData.opening > 0) {
          tl.fromTo(fadeEl, { opacity: 1 }, { opacity: 0, duration: transitionData.opening, ease: "power2.out" }, 0);
        }
        if (transitionData.ending > 0) {
          // Pinned to the END of the composition, so the last frame is the
          // background colour and not a half-faded frame.
          tl.fromTo(fadeEl, { opacity: 0 }, { opacity: 1, duration: transitionData.ending, ease: "power2.in" },
            Math.max(0, transitionData.total - transitionData.ending));
        }
      }

      // Self-lint, straight from references/captions.md: seek just past each
      // group and warn if its band is still visible. It runs at composition
      // init, BEFORE the timeline is published, so a leak is loud in the render
      // log instead of silently sitting over the next scene.
      function lintCaptions(tl) {
        if (typeof window.getComputedStyle !== "function") return;
        captionData.groups.forEach(function (group) {
          var el = document.getElementById(group.id);
          if (!el) return;
          tl.seek(group.end + 0.01);
          if (window.getComputedStyle(el).opacity !== "0") {
            console.warn("[caption-lint] " + group.id + " still visible at t=" + (group.end + 0.01).toFixed(2) + "s");
          }
        });
        tl.seek(0);
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
      buildCaptions(tl);
      buildTransitions(tl);
      apply(0);
      applyCursor(0);
      lintCaptions(tl);
      window.__timelines["root"] = tl;
    })();
  </script>
</body>
</html>
`;
}
