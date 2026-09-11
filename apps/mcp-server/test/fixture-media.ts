import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// The source clip the render-level tests composite.
//
// It used to be one specific capture sitting in this machine's `data/sessions`,
// referenced by absolute path. `data/` is gitignored, so on a fresh clone the
// documented command
//
//   DEMOMOTION_RENDER_TESTS=1 pnpm --filter @demomotion/mcp-server test
//
// failed on a missing file. This module produces that clip instead, on demand,
// and caches it under a gitignored path.
//
// WHAT IT DRAWS, AND WHY IT IS DRAWN RATHER THAN CAPTURED
// ------------------------------------------------------
// The render tests assert on pixels of the SOURCE, not on the capture pipeline:
// the four corner markers must come out square (the objectFit:cover crop), the
// held tail must not go black, and two instants either side of a cut must be
// visually different enough for a crossfade to have something to dissolve.
// So this module reproduces the fixture target app's visual contract — the same
// four corner markers, at the same size, in the same colours, plus its on-screen
// elapsed-time clock — with an exact, deterministic geometry:
//
//   * markers are EXACTLY 128x128 and flush to the frame edge, so "the marker
//     came out square" measures the compositor and nothing else;
//   * the clip is EXACTLY 9.08 s at 25 fps in VP8/WebM — the same shape as the
//     capture it replaces, including the deliberate mismatch with the 10.315 s
//     the render tests declare (that gap IS the black-tail trap) and the
//     deliberate 25-vs-30 fps mismatch with the composition;
//   * the picture changes state once, at 4.6 s, so a cut between media 3 s and
//     media 7 s has two genuinely different sides.
//
// Capturing the fixture through the product instead would re-derive none of
// those properties: today's screencast adapter emits a 30 fps CFR MP4 whose
// duration MATCHES the manifest — by design, it is the fix for the very defect
// these tests pin — so a real capture could not reproduce the trap at all.
// It would also make a capture bug fail the compositor's tests. The capture path
// is exercised through the product where it belongs, in capture-alignment.test.ts
// and mcp-e2e.test.ts.
//
// The colours and sizes below are the fixture's. `fixture-media.test.ts` reads
// fixtures/target-app/styles.css and app.js and fails if they ever drift apart.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");

/** Gitignored (see .gitignore). Never commit the generated video. */
export const CACHE_DIR = path.join(REPO, "data/test-media");
export const CACHE_VIDEO = path.join(CACHE_DIR, "fixture-source.webm");
const CACHE_MANIFEST = path.join(CACHE_DIR, "fixture-source.manifest.json");

export const WIDTH = 1920;
export const HEIGHT = 1080;
/** Deliberately NOT the composition's 30 fps. */
export const FPS = 25;
/** Deliberately shorter than the 10.315 s the render tests declare. */
export const DURATION_SEC = 9.08;
export const FRAME_COUNT = Math.round(DURATION_SEC * FPS); // 227
/** The instant the page changes state, between media 3 s and media 7 s. */
export const STATE_CHANGE_SEC = 4.6;

/** `.corner { width: 128px; height: 128px; border: 6px solid #000 }` */
export const CORNER_SIZE = 128;
export const CORNER_BORDER = 6;

/** `.corner--tl/tr/bl/br { background: ... }` in fixtures/target-app/styles.css. */
export const CORNER_COLORS = {
  tl: "#e11d48",
  tr: "#16a34a",
  bl: "#2563eb",
  br: "#f59e0b"
} as const;

/** `.clock { background: #000; color: #00ff66; border: 6px solid #00ff66 }` */
export const CLOCK_BG = "#000000";
export const CLOCK_FG = "#00ff66";
/** app.js: `"T+" + String(ms).padStart(5, "0") + " ms"`. */
export const CLOCK_PAD = 5;
export const clockText = (ms: number) => `T+${String(ms).padStart(CLOCK_PAD, "0")} ms`;

/**
 * Bumped by hand whenever anything above, or `drawFrame` below, changes what the
 * pixels look like. It goes into the cache manifest: an old cache made by an
 * older recipe is regenerated instead of being silently reused.
 */
const RECIPE_VERSION = 1;

type RGB = [number, number, number];

function rgb(hex: string): RGB {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// --- A 5x7 bitmap font ------------------------------------------------------
// Drawn here rather than by ffmpeg's `drawtext`, which needs libfreetype and a
// system font file: neither is guaranteed on a contributor's box or on a CI
// runner, and a source clip that silently loses its text on one platform is not
// the same test input on both.

const GLYPHS: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "@": ["01110", "10001", "10111", "10101", "10111", "10000", "01110"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"]
};

const GLYPH_W = 5;
const GLYPH_H = 7;

/** A mutable RGB24 frame with the handful of primitives the scene needs. */
class Frame {
  readonly data: Buffer;

  constructor(readonly width: number, readonly height: number) {
    this.data = Buffer.alloc(width * height * 3);
  }

  fill(color: RGB) {
    for (let i = 0; i < this.data.length; i += 3) {
      this.data[i] = color[0];
      this.data[i + 1] = color[1];
      this.data[i + 2] = color[2];
    }
  }

  rect(x: number, y: number, w: number, h: number, color: RGB) {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let py = y0; py < y1; py++) {
      let i = (py * this.width + x0) * 3;
      for (let px = x0; px < x1; px++) {
        this.data[i++] = color[0];
        this.data[i++] = color[1];
        this.data[i++] = color[2];
      }
    }
  }

  /** A rectangle with a border: the fixture's markers, panels and rows. */
  box(x: number, y: number, w: number, h: number, fill: RGB, border: RGB, borderWidth: number) {
    this.rect(x, y, w, h, border);
    this.rect(x + borderWidth, y + borderWidth, w - 2 * borderWidth, h - 2 * borderWidth, fill);
  }

  /** Upper-cased 5x7 text. `scale` is the pixel size of one font cell. */
  text(x: number, y: number, value: string, color: RGB, scale: number) {
    let cursor = x;
    for (const raw of value.toUpperCase()) {
      const glyph = GLYPHS[raw] ?? GLYPHS[" "];
      for (let row = 0; row < GLYPH_H; row++) {
        for (let col = 0; col < GLYPH_W; col++) {
          if (glyph[row][col] === "1") {
            this.rect(cursor + col * scale, y + row * scale, scale, scale, color);
          }
        }
      }
      cursor += (GLYPH_W + 1) * scale;
    }
  }

  textWidth(value: string, scale: number) {
    return value.length * (GLYPH_W + 1) * scale - scale;
  }
}

// --- The scene --------------------------------------------------------------

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];
const INK: RGB = rgb("#101828");         // body text
const MUTED: RGB = rgb("#475467");       // .row__email / .row__phone
const PANEL_BG: RGB = rgb("#f8fafc");    // .panel
const PANEL_BORDER: RGB = rgb("#e2e8f0");
const PRIMARY: RGB = rgb("#4338ca");     // .btn--primary
const TOAST_BG: RGB = rgb("#dcfce7");    // .toast
const TOAST_BORDER: RGB = rgb("#16a34a");
const TOAST_INK: RGB = rgb("#14532d");
const NEW_ROW_BG: RGB = rgb("#f0fdf4");  // .row--new

const CONTENT_X = 390;
const CONTENT_W = 1140;

type Row = { name: string; email: string; phone: string; fresh: boolean };

const LIST_ROWS: Row[] = [
  { name: "Grace Hopper", email: "grace@navy.mil", phone: "+1 202 555 0141", fresh: false },
  { name: "Alan Turing", email: "alan@bletchley.uk", phone: "+44 20 7946 0123", fresh: false }
];

const SAVED_ROWS: Row[] = [
  { name: "Ada Lovelace", email: "ada@example.com", phone: "+55 11 98888-1815", fresh: true },
  ...LIST_ROWS
];

function drawCorner(frame: Frame, label: keyof typeof CORNER_COLORS) {
  const x = label === "tl" || label === "bl" ? 0 : WIDTH - CORNER_SIZE;
  const y = label === "tl" || label === "tr" ? 0 : HEIGHT - CORNER_SIZE;
  frame.box(x, y, CORNER_SIZE, CORNER_SIZE, rgb(CORNER_COLORS[label]), BLACK, CORNER_BORDER);
  const scale = 8;
  const text = label.toUpperCase();
  frame.text(
    x + (CORNER_SIZE - frame.textWidth(text, scale)) / 2,
    y + (CORNER_SIZE - GLYPH_H * scale) / 2,
    text, WHITE, scale
  );
}

function drawClock(frame: Frame, ms: number) {
  const scale = 12;
  const text = clockText(ms);
  const textW = frame.textWidth(text, scale);
  const boxW = textW + 2 * 36;
  const boxH = GLYPH_H * scale + 2 * 18;
  const x = Math.round((WIDTH - boxW) / 2);
  frame.rect(x, 0, boxW, boxH + 6, rgb(CLOCK_FG));       // the #00ff66 border
  frame.rect(x + 6, 0, boxW - 12, boxH, rgb(CLOCK_BG));  // border-top: none
  frame.text(x + 36, 18, text, rgb(CLOCK_FG), scale);
}

function drawRows(frame: Frame, x: number, y: number, w: number, rows: Row[]): number {
  let cursor = y;
  for (const row of rows) {
    frame.box(x, cursor, w, 66, row.fresh ? NEW_ROW_BG : WHITE, row.fresh ? TOAST_BORDER : PANEL_BORDER, 2);
    frame.text(x + 22, cursor + 22, row.name, INK, 3);
    frame.text(x + 340, cursor + 22, row.email, MUTED, 3);
    frame.text(x + 740, cursor + 22, row.phone, MUTED, 3);
    cursor += 78;
  }
  return cursor;
}

/**
 * One frame of the scene at output time `t` (seconds).
 *
 * Before STATE_CHANGE_SEC the page is the client list; after it, the "saved"
 * state — a toast band plus a fresh row, which pushes the whole list down. That
 * is what makes media 3 s and media 7 s two different pictures.
 */
function drawFrame(t: number): Frame {
  const frame = new Frame(WIDTH, HEIGHT);
  frame.fill(WHITE);

  // Header: brand on the left, the "New client" button on the right.
  frame.text(CONTENT_X, 190, "ACME CRM", INK, 5);
  frame.box(CONTENT_X + CONTENT_W - 230, 176, 230, 62, PRIMARY, PRIMARY, 2);
  frame.text(CONTENT_X + CONTENT_W - 230 + 26, 194, "NEW CLIENT", WHITE, 3);

  const saved = t >= STATE_CHANGE_SEC;
  let panelY = 280;
  if (saved) {
    frame.box(CONTENT_X, panelY, CONTENT_W, 86, TOAST_BG, TOAST_BORDER, 3);
    frame.text(CONTENT_X + 26, panelY + 30, "CLIENT SAVED SUCCESSFULLY: ADA LOVELACE", TOAST_INK, 4);
    panelY += 118;
  }

  const rows = saved ? SAVED_ROWS : LIST_ROWS;
  const panelH = 96 + rows.length * 78;
  frame.box(CONTENT_X, panelY, CONTENT_W, panelH, PANEL_BG, PANEL_BORDER, 2);
  frame.text(CONTENT_X + 30, panelY + 28, `CLIENTS ${rows.length}`, INK, 4);
  drawRows(frame, CONTENT_X + 30, panelY + 82, CONTENT_W - 60, rows);

  // Drawn last so nothing can cover them — exactly as z-index does in the fixture.
  drawClock(frame, Math.floor(t * 1000));
  for (const label of ["tl", "tr", "bl", "br"] as const) drawCorner(frame, label);
  return frame;
}

/**
 * One frame of the scene, as RGB24, without touching ffmpeg.
 *
 * Exported so the scene's own contract — markers square, in their corners, in
 * the fixture's colours; the clock ticking; the two states differing — can be
 * asserted in the DEFAULT suite, with no ffmpeg and no browser. Those properties
 * are what the render tests measure through the compositor; if they were only
 * ever checked there, a broken generator would read as a broken compositor.
 */
export function sceneFrame(t: number): { width: number; height: number; data: Buffer } {
  const frame = drawFrame(t);
  return { width: frame.width, height: frame.height, data: frame.data };
}

/** The colour at one pixel of a frame produced by `sceneFrame`. */
export function pixelAt(frame: { width: number; data: Buffer }, x: number, y: number): RGB {
  const i = (y * frame.width + x) * 3;
  return [frame.data[i], frame.data[i + 1], frame.data[i + 2]];
}

// --- Encoding and caching ---------------------------------------------------

/** How the cache knows it is looking at output of THIS recipe. */
function recipeFingerprint(): string {
  const descriptor = JSON.stringify({
    version: RECIPE_VERSION,
    WIDTH, HEIGHT, FPS, DURATION_SEC, FRAME_COUNT, STATE_CHANGE_SEC,
    CORNER_SIZE, CORNER_BORDER, CORNER_COLORS, CLOCK_BG, CLOCK_FG, CLOCK_PAD,
    // The drawing and encoding code itself: a change to the scene, or to the
    // codec settings, invalidates the cache even if no constant above moved.
    draw: crypto.createHash("sha256")
      .update(String(drawFrame) + String(drawRows) + String(drawClock) + String(drawCorner) + String(encode))
      .digest("hex")
  });
  return crypto.createHash("sha256").update(descriptor).digest("hex");
}

type Manifest = {
  recipe: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  codec: string;
};

const EXPECTED_CODEC = "vp8";

function runTool(bin: string, args: string[], onStdin?: (stdin: NodeJS.WritableStream) => Promise<void>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: [onStdin ? "pipe" : "ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout!.on("data", (d) => { out += d.toString(); });
    child.stderr!.on("data", (d) => { err += d.toString(); });
    child.on("error", (cause) => reject(missingToolError(bin, cause)));
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${bin} exited ${code}\n${err.slice(-4000)}`));
    });
    if (onStdin) {
      child.stdin!.on("error", () => { /* reported through the exit code */ });
      onStdin(child.stdin!).then(() => child.stdin!.end(), reject);
    }
  });
}

function missingToolError(bin: string, cause: unknown): Error {
  const why = (cause as NodeJS.ErrnoException)?.code === "ENOENT"
    ? `\`${bin}\` is not on PATH.`
    : `\`${bin}\` could not be started (${String(cause)}).`;
  return new Error(
    `${why}\n\n` +
    "The render-level tests build their source clip with ffmpeg; without it there is\n" +
    "no source video and nothing to render, so this is a failure and not a skip.\n" +
    "Install it:\n" +
    "  macOS:          brew install ffmpeg\n" +
    "  Debian/Ubuntu:  sudo apt-get install -y ffmpeg\n" +
    "  Windows:        winget install Gyan.FFmpeg\n" +
    "ffmpeg and ffprobe must BOTH be on PATH."
  );
}

async function probe(video: string): Promise<{ width: number; height: number; fps: number; durationSec: number; codec: string }> {
  const raw = await runTool("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,avg_frame_rate",
    "-show_entries", "format=duration",
    "-of", "json", video
  ]);
  const parsed = JSON.parse(raw) as {
    streams?: Array<{ codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }>;
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];
  if (!stream) throw new Error(`ffprobe found no video stream in ${video}`);
  const [num, den] = (stream.avg_frame_rate ?? "0/1").split("/").map(Number);
  return {
    width: Number(stream.width),
    height: Number(stream.height),
    fps: den ? num / den : 0,
    durationSec: Number(parsed.format?.duration ?? NaN),
    codec: String(stream.codec_name)
  };
}

async function sha256(file: string): Promise<string> {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

/** Everything the cache must satisfy, or the reason it does not. */
async function cacheProblem(recipe: string): Promise<string | null> {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await fs.readFile(CACHE_MANIFEST, "utf8")) as Manifest;
  } catch (cause) {
    return `no usable cache manifest (${(cause as Error).message})`;
  }
  if (manifest.recipe !== recipe) return "the cached clip was made by an older recipe";

  let size: number;
  try {
    size = (await fs.stat(CACHE_VIDEO)).size;
  } catch {
    return "the cached clip is missing";
  }
  // A truncated file — an interrupted write, a full disk — is caught here and by
  // the digest below, never used as if it were whole.
  if (size !== manifest.bytes) return `the cached clip is ${size} bytes, the manifest says ${manifest.bytes}`;
  if (await sha256(CACHE_VIDEO) !== manifest.sha256) return "the cached clip's digest does not match the manifest";

  const actual = await probe(CACHE_VIDEO);
  if (actual.codec !== EXPECTED_CODEC) return `the cached clip is ${actual.codec}, expected ${EXPECTED_CODEC}`;
  if (actual.width !== WIDTH || actual.height !== HEIGHT) return `the cached clip is ${actual.width}x${actual.height}`;
  if (Math.abs(actual.fps - FPS) > 0.01) return `the cached clip runs at ${actual.fps} fps`;
  if (Math.abs(actual.durationSec - DURATION_SEC) > 0.02) return `the cached clip lasts ${actual.durationSec}s`;
  return null;
}

async function encode(target: string) {
  await runTool("ffmpeg", [
    "-y",
    "-f", "rawvideo", "-pix_fmt", "rgb24",
    "-s", `${WIDTH}x${HEIGHT}`, "-r", String(FPS),
    "-i", "-",
    "-c:v", "libvpx",
    "-pix_fmt", "yuv420p",
    "-b:v", "3M",
    "-deadline", "realtime",
    "-cpu-used", "8",
    "-auto-alt-ref", "0",
    "-r", String(FPS),
    // Stated explicitly: the file is written under a temporary name, so ffmpeg
    // cannot infer the container from the extension.
    "-f", "webm",
    target
  ], async (stdin) => {
    for (let i = 0; i < FRAME_COUNT; i++) {
      const frame = drawFrame(i / FPS);
      // Back-pressure. `close` and `error` settle the wait too: if ffmpeg dies
      // mid-pipe the drain would never come, and the generator would hang
      // instead of surfacing ffmpeg's own exit code.
      if (!stdin.write(frame.data)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            stdin.removeListener("drain", done);
            stdin.removeListener("close", done);
            stdin.removeListener("error", done);
            resolve();
          };
          stdin.once("drain", done);
          stdin.once("close", done);
          stdin.once("error", done);
        });
      }
    }
  });
}

async function generate(recipe: string): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  // Written under a temporary name and only then renamed, so a crashed or killed
  // run can never leave behind a half-written file that looks like a valid cache.
  const temp = `${CACHE_VIDEO}.${process.pid}.tmp`;
  try {
    await encode(temp);
    const actual = await probe(temp);
    if (actual.codec !== EXPECTED_CODEC || actual.width !== WIDTH || actual.height !== HEIGHT
      || Math.abs(actual.fps - FPS) > 0.01 || Math.abs(actual.durationSec - DURATION_SEC) > 0.02) {
      throw new Error(
        `ffmpeg produced ${actual.codec} ${actual.width}x${actual.height} @ ${actual.fps} fps, ` +
        `${actual.durationSec}s — expected ${EXPECTED_CODEC} ${WIDTH}x${HEIGHT} @ ${FPS} fps, ${DURATION_SEC}s. ` +
        "The render tests depend on all of those, so the clip is rejected rather than used. " +
        "A build of ffmpeg without libvpx is the usual cause (`ffmpeg -encoders | grep libvpx`)."
      );
    }
    const manifest: Manifest = {
      recipe,
      bytes: (await fs.stat(temp)).size,
      sha256: await sha256(temp),
      width: actual.width,
      height: actual.height,
      fps: actual.fps,
      durationSec: actual.durationSec,
      codec: actual.codec
    };
    // Video first, then the manifest that vouches for it: a run interrupted
    // between the two leaves a clip with no manifest, which reads as "no cache"
    // rather than as a clip someone has verified.
    await fs.rename(temp, CACHE_VIDEO);
    const manifestTemp = `${CACHE_MANIFEST}.${process.pid}.tmp`;
    await fs.writeFile(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fs.rename(manifestTemp, CACHE_MANIFEST);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

let pending: Promise<string> | undefined;

/**
 * The absolute path of the source clip, generating it if the cache is absent,
 * stale or damaged.
 *
 * Never skips and never falls back: if ffmpeg cannot produce the clip the caller
 * gets an error naming exactly what is missing. A render test that quietly opted
 * out on a fresh clone would leave the suite green while proving nothing, which
 * is the same failure mode in a different disguise.
 */
export function fixtureSourceVideo(): Promise<string> {
  pending ??= (async () => {
    const recipe = recipeFingerprint();
    const problem = await cacheProblem(recipe);
    if (problem) {
      process.stderr.write(`[fixture-media] regenerating ${path.relative(REPO, CACHE_VIDEO)}: ${problem}\n`);
      await generate(recipe);
      const stillWrong = await cacheProblem(recipe);
      if (stillWrong) throw new Error(`the freshly generated source clip is still not usable: ${stillWrong}`);
    }
    return CACHE_VIDEO;
  })();
  return pending;
}
