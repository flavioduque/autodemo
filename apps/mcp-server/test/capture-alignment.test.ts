import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  startSession, goto, wait, stopSession, getSession, captureTimeMs
} from "../src/session-manager.ts";

// ---------------------------------------------------------------------------
// Slow, end-to-end proof of the capture time-base fix. It drives the REAL
// product (session-manager) against a locally served page, and proves — with an
// independent visual oracle, not a hand-written capture.json — that:
//
//   POSITIVE (screencast adapter): the manifest's event time maps to the frame
//     that actually shows the event, within a couple of frames.
//   NEGATIVE (legacy record-video): the SAME index-based lookup drifts by many
//     frames — the video's real fps (25) does not match the manifest's declared
//     fps (30), so `round(sourceMs/1000*fps)` lands on the wrong frame, and the
//     error GROWS with time (the ~2.1s-at-10s defect).
//
// Gated behind DEMOMOTION_SLOW=1 (launches Chrome + ffmpeg). On this macOS 13
// host the bundled Chromium cannot install, so it defaults the channel to
// Google Chrome. Run:
//   DEMOMOTION_SLOW=1 DEMOMOTION_BROWSER_CHANNEL=chrome \
//     node --import <tsx-loader> --test apps/mcp-server/test/capture-alignment.test.ts
// ---------------------------------------------------------------------------

const SLOW = process.env.DEMOMOTION_SLOW === "1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, "../../../fixtures/target-app");

if (process.platform === "darwin" && !process.env.DEMOMOTION_BROWSER_CHANNEL) {
  process.env.DEMOMOTION_BROWSER_CHANNEL = "chrome";
}

function serveFixture(): Promise<{ port: number; close: () => Promise<void> }> {
  const types: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
  const server = http.createServer(async (req, res) => {
    try {
      const rel = (req.url === "/" || !req.url) ? "index.html" : req.url.slice(1);
      const file = path.join(FIXTURE_DIR, rel);
      if (!file.startsWith(FIXTURE_DIR)) { res.writeHead(403).end(); return; }
      const body = await fs.readFile(file);
      res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" }).end(body);
    } catch { res.writeHead(404).end("nf"); }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port as number;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/**
 * Decode a video to small RGB frames and return, per frame, the fraction of
 * near-magenta pixels. Frames come out in coded order, so for a CFR mp4 the
 * index equals the grid slot; for the VFR webm it is the coded-frame index a
 * frame-indexed compositor would address.
 */
function magentaFractions(video: string): number[] {
  const W = 160, H = 90, FRAME = W * H * 3;
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", video, "-vf", `scale=${W}:${H},format=rgb24`, "-f", "rawvideo", "-"],
    { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg decode failed: ${r.stderr}`);
  const buf = r.stdout;
  const n = Math.floor(buf.length / FRAME);
  const out: number[] = [];
  for (let f = 0; f < n; f++) {
    const base = f * FRAME;
    let mag = 0;
    for (let p = 0; p < FRAME; p += 3) {
      const i = base + p;
      if (buf[i] > 200 && buf[i + 1] < 80 && buf[i + 2] > 200) mag++;
    }
    out.push(mag / (W * H));
  }
  return out;
}

function ffprobeRates(video: string): { r: string; avg: string; nbFrames: number } {
  const p = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=r_frame_rate,avg_frame_rate,nb_read_frames", "-count_frames",
    "-of", "default=nw=1:nk=0", video], { encoding: "utf8" });
  const get = (k: string) => (p.stdout.match(new RegExp(`${k}=(.*)`)) ?? [])[1]?.trim() ?? "";
  return { r: get("r_frame_rate"), avg: get("avg_frame_rate"), nbFrames: Number(get("nb_read_frames")) || 0 };
}

/** Drive one capture; flip the whole viewport magenta at a recorded source time. */
async function runFlipCapture(mode: "screencast" | "record-video", port: number) {
  if (mode === "record-video") process.env.DEMOMOTION_CAPTURE = "record-video";
  else delete process.env.DEMOMOTION_CAPTURE;

  const s = await startSession({ width: 1000, height: 600, headless: true });
  let flipAtMs = 0;
  try {
    await goto(s.id, `http://127.0.0.1:${port}/`);
    // Settle past the screencast startup transient, then push the flip well into
    // the timeline so the legacy fps drift has room to show (it grows with time).
    await wait(s.id, Number(process.env.DEMOMOTION_TEST_SETTLE_MS ?? 3600));
    flipAtMs = captureTimeMs(s.id);
    await getSession(s.id).page.evaluate(() => {
      const d = document.createElement("div");
      d.id = "__flip";
      d.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgb(255,0,255)";
      document.body.appendChild(d);
    });
    await wait(s.id, 900);
  } finally {
    // ensure teardown even on failure
  }
  const cap = await stopSession(s.id);
  return { dir: s.dir, cap, flipAtMs };
}

test("screencast capture keeps events and frames on one time base; record-video drifts", { skip: !SLOW }, async (t) => {
  const fixture = await serveFixture();
  const dirs: string[] = [];
  t.after(async () => {
    await fixture.close();
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  });

  // --- POSITIVE half: the screencast adapter ---
  const neu = await runFlipCapture("screencast", fixture.port);
  dirs.push(neu.dir);
  assert.ok(neu.cap.videoPath, "screencast produced a video");

  // The CFR substrate the frame<->sourceMs invariant rests on: the artifact's
  // real fps equals the manifest's declared fps, and is constant.
  const nr = ffprobeRates(neu.cap.videoPath!);
  assert.equal(nr.r, `${neu.cap.fps}/1`, "screencast video r_frame_rate == declared fps");
  assert.equal(nr.avg, `${neu.cap.fps}/1`, "screencast video avg_frame_rate == declared fps (constant)");
  assert.equal(nr.nbFrames, neu.cap.frameCount, "manifest frameCount matches the encoded frames");

  const nf = magentaFractions(neu.cap.videoPath!);
  const nStep = nf.findIndex((x) => x > 0.5);
  // Non-vacuous: a magenta frame exists AND the clip did not start magenta.
  assert.ok(nStep >= 0, "the magenta flip appears in the screencast video");
  assert.ok(nf[0] < 0.5, "the clip does not start already magenta (real transition)");

  const nAsked = Math.round((neu.flipAtMs / 1000) * neu.cap.fps);
  const nErr = Math.abs(nStep - nAsked);
  console.log(`[screencast] flipAtMs=${neu.flipAtMs} asked frame=${nAsked} actual step=${nStep} err=${nErr} frames`);
  // The frame the manifest points to shows the flip within a couple of frames.
  assert.ok(nErr <= 8, `screencast: |actual - asked| = ${nErr} frames, expected <= 8`);

  // --- NEGATIVE half: the legacy record-video path, SAME index-based lookup ---
  const old = await runFlipCapture("record-video", fixture.port);
  dirs.push(old.dir);
  assert.ok(old.cap.videoPath, "record-video produced a video");

  const orates = ffprobeRates(old.cap.videoPath!);
  // The defect at the substrate: the webm's real fps is NOT the declared 30.
  assert.notEqual(orates.r, `${old.cap.fps}/1`,
    `record-video real fps (${orates.r}) must differ from declared ${old.cap.fps} — the source of the drift`);
  assert.ok(orates.nbFrames > 0, "record-video actually recorded frames (not an empty control)");

  const of = magentaFractions(old.cap.videoPath!);
  const oStep = of.findIndex((x) => x > 0.5);
  assert.ok(oStep >= 0, "the magenta flip appears in the record-video webm");
  assert.ok(of[0] < 0.5, "the webm does not start already magenta");

  const oAsked = Math.round((old.flipAtMs / 1000) * old.cap.fps);
  const oErr = Math.abs(oStep - oAsked);
  console.log(`[record-video] flipAtMs=${old.flipAtMs} asked frame=${oAsked} actual step=${oStep} err=${oErr} frames`);
  // The same lookup misses by many frames: the misalignment the fix removes.
  assert.ok(oErr >= 10, `record-video: |actual - asked| = ${oErr} frames, expected the drift to be >= 10`);
  // And it is strictly, substantially worse than the screencast path.
  assert.ok(oErr > nErr + 6, `record-video drift (${oErr}) must dwarf screencast error (${nErr})`);
});

// A tiny, self-contained non-Chrome guard so the file is not empty when SLOW is
// off: it documents WHY the drift exists, using only the numbers (no browser).
test("index lookup at the wrong fps drifts ~ sourceMs * (declared/real - 1)", () => {
  const declared = 30, real = 25; // record-video webm on this host
  const frameForOldPipeline = (sourceMs: number) => Math.round((sourceMs / 1000) * declared);
  // Where that index actually lands, in ms, on a `real`-fps video:
  const landsAtMs = (idx: number) => (idx / real) * 1000;
  for (const sourceMs of [3000, 6000, 10500]) {
    const drift = landsAtMs(frameForOldPipeline(sourceMs)) - sourceMs;
    // Hand check: drift ≈ sourceMs*(30/25 - 1) = sourceMs*0.2.
    assert.ok(Math.abs(drift - sourceMs * 0.2) < 25, `drift at ${sourceMs}ms ≈ ${Math.round(drift)}ms`);
  }
  // The 10.5s point crosses ~2.1s — the reported n=1 defect, explained by arithmetic.
  assert.ok(landsAtMs(frameForOldPipeline(10500)) - 10500 > 2000);
});
