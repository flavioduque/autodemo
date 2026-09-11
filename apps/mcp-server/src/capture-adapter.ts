import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { CDPSession, Page } from "playwright";
import { type SourceTimeMs, type DurationMs, SOURCE_ZERO, sourceMs, durationMs } from "@demomotion/schema";

/**
 * Capture adapter contract (design spec §4).
 *
 * A capture adapter turns a live browser session into a constant-fps (CFR)
 * artifact plus a list of events, both expressed in ONE time base: `sourceMs`,
 * with `t=0` at the first captured frame.
 *
 * The invariant every adapter must uphold: output frame `i` corresponds to
 * `sourceMs = i / fps * 1000`. That is what makes `sourceMs -> frame index`
 * exact — `round(sourceMs / 1000 * fps)` — with no calibration and no offset
 * measurement. Playwright's `recordVideo` cannot uphold it (variable-framerate
 * webm whose start instant and cadence are not exposed), which is the whole
 * reason this adapter exists.
 */
export interface CaptureResult {
  fps: number;
  width: number;
  height: number;
  frameCount: number;
  artifact: { kind: "video"; path: string };
  durationMs: DurationMs;
}

/**
 * Pure grid-assembly. Screencast frames arrive only when the page changes, so
 * they are variable-framerate: `frameTimesSec` is an ascending list of each
 * frame's own timestamp, relative to the first frame (so `frameTimesSec[0] === 0`).
 *
 * We lay those frames onto a constant-fps grid of `round(durationSec * fps)`
 * slots. Slot `i` covers source time `i / fps`, and shows the most-recent frame
 * that was already on screen at that instant — i.e. the last frame whose time is
 * `<= i / fps`. Idle stretches simply repeat the previous frame's index, which
 * is why a static page costs almost nothing.
 *
 * Returns, for every grid slot, the index into `frameTimesSec` of the frame to
 * paint there. By construction the returned array has one entry per output
 * frame, and slot `i` is exactly `sourceMs = i / fps * 1000`.
 */
export function assembleGrid(frameTimesSec: number[], fps: number, durationSec: number): number[] {
  if (frameTimesSec.length === 0) return [];
  if (fps <= 0) throw new Error("fps must be positive");
  const frameCount = Math.max(1, Math.round(durationSec * fps));
  const grid = new Array<number>(frameCount);
  let k = 0;
  for (let i = 0; i < frameCount; i++) {
    const t = i / fps;
    // Advance to the last frame that had already appeared by grid time `t`.
    while (k + 1 < frameTimesSec.length && frameTimesSec[k + 1] <= t) k++;
    grid[i] = k;
  }
  return grid;
}

interface ScreencastFrameMeta {
  timestamp?: number; // Network.TimeSinceEpoch, seconds
}

interface ScreencastFrameParams {
  data: string; // base64 image
  sessionId: number;
  metadata: ScreencastFrameMeta;
}

/**
 * Deterministic screencast capture over CDP `Page.startScreencast`.
 *
 * Each frame is stamped with its CDP `metadata.timestamp`, normalized so the
 * first frame is `t0 = 0`. Events anchor to that same line via `nowSourceMs()`
 * (the timestamp of the most-recent screencast frame), so events and frames
 * share one clock. On `stop()` the variable-rate frames are resampled onto a
 * constant-fps grid and encoded to a CFR MP4 with ffmpeg.
 */
export class ScreencastCapture {
  private readonly cdp: CDPSession;
  private readonly framesDir: string;
  private readonly dir: string;
  readonly fps: number;

  private t0Sec: number | undefined;
  private t0Wall = 0;
  private lastRelSec = 0;
  private frameCountIn = 0;
  private readonly frameTimesSec: number[] = [];
  private readonly pendingWrites: Promise<unknown>[] = [];
  private stopped = false;

  // Warmup: when a screencast starts it first drains a backlog of already-buffered
  // frames whose content lags real time by hundreds of ms. We discard frames until
  // the pipeline is caught up — a frame's own `metadata.timestamp` (epoch seconds,
  // same clock as Date.now()) is within `warmupLagMs` of now — then take THAT frame
  // as t0. This removes the startup transient without touching per-event math; it
  // is not calibration (no measured offset is ever subtracted from a timestamp).
  private ready = false;
  private readonly warmupLagMs: number;
  private warmDeadlineWall = 0;

  private constructor(cdp: CDPSession, dir: string, fps: number) {
    this.cdp = cdp;
    this.dir = dir;
    this.framesDir = path.join(dir, "frames");
    this.fps = fps;
    this.warmupLagMs = Number(process.env.DEMOMOTION_WARMUP_LAG_MS) || 45;
    // Safety cap: never discard for longer than this, so a page that is genuinely
    // slow (never "catches up") still starts capturing.
    this.warmDeadlineWall = Date.now() + (Number(process.env.DEMOMOTION_WARMUP_MAX_MS) || 4000);
  }

  static async start(opts: {
    page: Page;
    dir: string;
    fps?: number;
    width: number;
    height: number;
    deviceScaleFactor?: number;
  }): Promise<ScreencastCapture> {
    const fps = opts.fps ?? (Number(process.env.DEMOMOTION_FPS) || 30);
    const dsf = opts.deviceScaleFactor ?? 1;
    const cdp = await opts.page.context().newCDPSession(opts.page);
    const cap = new ScreencastCapture(cdp, opts.dir, fps);
    await fs.mkdir(cap.framesDir, { recursive: true });

    cdp.on("Page.screencastFrame", (params: ScreencastFrameParams) => cap.onFrame(params));

    // maxWidth/maxHeight are in device pixels; multiply by DSF so a
    // deviceScaleFactor > 1 is actually captured above native resolution.
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      // Lower quality => faster JPEG encode => lower capture latency, at the cost
      // of sharpness. Default favors sharpness; tune with DEMOMOTION_SCREENCAST_QUALITY.
      quality: Math.min(100, Math.max(1, Number(process.env.DEMOMOTION_SCREENCAST_QUALITY) || 90)),
      everyNthFrame: 1,
      maxWidth: Math.ceil(opts.width * dsf),
      maxHeight: Math.ceil(opts.height * dsf)
    });
    return cap;
  }

  private onFrame(params: ScreencastFrameParams) {
    // Ack first so the next frame keeps flowing; a missed ack stalls the stream.
    void this.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    if (this.stopped) return;
    const nowWall = Date.now();
    const ts = typeof params.metadata.timestamp === "number" ? params.metadata.timestamp : nowWall / 1000;
    if (!this.ready) {
      const deliveryLagMs = nowWall - ts * 1000;
      if (deliveryLagMs > this.warmupLagMs && nowWall < this.warmDeadlineWall) {
        return; // still draining the startup backlog — discard this frame
      }
      this.ready = true;
      this.t0Sec = ts;
      this.t0Wall = nowWall;
    }
    const rel = Math.max(0, ts - (this.t0Sec as number));
    const idx = this.frameCountIn++;
    this.frameTimesSec[idx] = rel;
    this.lastRelSec = rel;
    const file = path.join(this.framesDir, `f${String(idx).padStart(6, "0")}.jpg`);
    this.pendingWrites.push(fs.writeFile(file, Buffer.from(params.data, "base64")));
  }

  /** Frames received so far — lets a caller prove the screencast is live before stopping. */
  get frameCount(): number {
    return this.frameCountIn;
  }

  /**
   * Current time on the capture's own line, in ms: the timestamp of the
   * most-recent screencast frame, normalized to the first frame = 0. This is the
   * time base events are stamped in — never `Date.now()`.
   *
   * INGRESS: this is where a CDP timestamp becomes a `SourceTimeMs`. Every
   * action's `atMs` descends from this one call.
   */
  nowSourceMs(): SourceTimeMs {
    if (this.t0Sec === undefined) return SOURCE_ZERO;
    return sourceMs(Math.round(this.lastRelSec * 1000));
  }

  async stop(): Promise<CaptureResult> {
    this.stopped = true;
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    await Promise.allSettled(this.pendingWrites);
    await this.cdp.detach().catch(() => {});

    // A missing encoder is a DEPENDENCY failure and must name itself before any
    // runtime condition: under load the screencast may have produced no frame
    // yet, and "no frames" would then mask the real, deterministic cause.
    await assertEncoderToolsOnPath();

    if (this.frameCountIn === 0 || this.t0Sec === undefined) {
      throw new Error("Screencast produced no frames; capture cannot be assembled.");
    }

    // Duration measured by wall clock since the first frame — independent of how
    // sparsely frames arrived, so a trailing idle stretch is not truncated.
    const durationSec = Math.max((Date.now() - this.t0Wall) / 1000, this.lastRelSec);
    const grid = assembleGrid(this.frameTimesSec.slice(0, this.frameCountIn), this.fps, durationSec);

    // Materialize the constant-fps sequence by hardlinking each grid slot to its
    // source frame (no byte duplication), then encode CFR with ffmpeg.
    const seqDir = path.join(this.dir, "seq");
    await fs.rm(seqDir, { recursive: true, force: true });
    await fs.mkdir(seqDir, { recursive: true });
    for (let i = 0; i < grid.length; i++) {
      const src = path.join(this.framesDir, `f${String(grid[i]).padStart(6, "0")}.jpg`);
      const dst = path.join(seqDir, `s${String(i).padStart(6, "0")}.jpg`);
      await fs.link(src, dst);
    }

    const videoPath = path.join(this.dir, "page.mp4");
    await encodeCfr(seqDir, videoPath, this.fps);
    const { width, height } = await probeSize(videoPath);

    // The frame sequence is large; keep only the CFR artifact by default.
    await fs.rm(seqDir, { recursive: true, force: true });
    if (process.env.DEMOMOTION_KEEP_FRAMES !== "1") {
      await fs.rm(this.framesDir, { recursive: true, force: true });
    }

    return {
      fps: this.fps,
      width,
      height,
      frameCount: grid.length,
      artifact: { kind: "video", path: videoPath },
      // INGRESS: the wall-clock length of the capture becomes a `DurationMs`.
      durationMs: durationMs(Math.round(durationSec * 1000))
    };
  }
}

/**
 * Turns the `spawn ffmpeg ENOENT` a missing binary produces into a refusal that
 * names the tool and the fix. It fires at `session_stop`, the first moment the
 * encoder is needed; `demomotion mcp` also warns about it at startup.
 */
/**
 * Resolves `ffmpeg` and `ffprobe` on PATH the way `spawn` would, so the refusal
 * is the same `toolMissingError` a failed spawn produces — only earlier and
 * deterministic, before any frame-dependent check.
 */
export async function assertEncoderToolsOnPath(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const tool of ["ffmpeg", "ffprobe"] as const) {
    let found = false;
    for (const dir of dirs) {
      for (const ext of exts) {
        try { await fs.access(path.join(dir, tool + ext), fs.constants.X_OK); found = true; break; } catch { /* keep looking */ }
      }
      if (found) break;
    }
    if (!found) {
      const enoent = Object.assign(new Error(`spawn ${tool} ENOENT`), { code: "ENOENT" });
      throw toolMissingError(tool, enoent);
    }
  }
}

export function toolMissingError(tool: "ffmpeg" | "ffprobe", error: unknown): Error {
  if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
    return error instanceof Error ? error : new Error(String(error));
  }
  return new Error(
    `${tool} is not installed or not on PATH; DemoMotion needs ffmpeg and ffprobe to assemble the capture at session_stop. ` +
    `Install ffmpeg (macOS: brew install ffmpeg; Debian/Ubuntu: apt-get install ffmpeg; Windows: winget install ffmpeg) and restart the server.`,
    { cause: error }
  );
}

function encodeCfr(seqDir: string, out: string, fps: number): Promise<void> {
  const args = [
    "-y",
    "-framerate", String(fps),
    "-i", path.join(seqDir, "s%06d.jpg"),
    // libx264 needs even dimensions; a deviceScaleFactor can produce odd sizes.
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-vsync", "cfr",
    out
  ];
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (error) => reject(toolMissingError("ffmpeg", error)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-2000)}`));
    });
  });
}

function probeSize(video: string): Promise<{ width: number; height: number }> {
  const args = [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x",
    video
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", (error) => reject(toolMissingError("ffprobe", error)));
    child.on("close", () => {
      const m = out.trim().match(/^(\d+)x(\d+)/);
      if (!m) return reject(new Error(`ffprobe could not read size: ${out}`));
      resolve({ width: Number(m[1]), height: Number(m[2]) });
    });
  });
}
