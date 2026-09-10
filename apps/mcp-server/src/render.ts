import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { DemoProjectSchema, type DemoProject } from "@demomotion/schema";
import { generateComposition } from "@demomotion/compositor";

const require = createRequire(import.meta.url);

/** Resolves a dependency's file inside this package's own module graph. */
function resolveDependencyFile(specifier: string): string {
  return require.resolve(specifier);
}

/**
 * HyperFrames sends anonymous render telemetry to HeyGen. DemoMotion renders on
 * its users' behalf, so it opts out by default. An operator who deliberately
 * sets the variable — including to "0" — keeps whatever they chose.
 */
export function telemetryEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (Object.prototype.hasOwnProperty.call(env, "HYPERFRAMES_NO_TELEMETRY")) return { ...env };
  return { ...env, HYPERFRAMES_NO_TELEMETRY: "1" };
}

/**
 * Renders one already-generated composition. Split out from `renderVideo` so a
 * test can render a DELIBERATELY WRONG composition and prove that the check
 * which passes on the correct one actually fires.
 */
export async function renderCompositionHtml(html: string, sourceVideo: string, outputPath: string, videoSrc: string) {
  const out = path.resolve(outputPath);
  await fs.mkdir(path.dirname(out), { recursive: true });

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "demomotion-render-"));
  try {
    await fs.copyFile(sourceVideo, path.join(workDir, videoSrc));
    await fs.copyFile(resolveDependencyFile("gsap/dist/gsap.min.js"), path.join(workDir, "gsap.min.js"));
    await fs.writeFile(path.join(workDir, "index.html"), html, "utf8");

    const cli = path.join(path.dirname(resolveDependencyFile("hyperframes/package.json")), "bin", "hyperframes.mjs");
    const args = [
      cli, "render", workDir,
      "--output", out,
      // The source is a UI screen capture: PNG frame extraction keeps text crisp.
      "--video-frame-format", "png"
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: telemetryEnv(process.env) });
      child.stdout.on("data", (d) => process.stderr.write(`[hyperframes] ${d}`));
      child.stderr.on("data", (d) => process.stderr.write(`[hyperframes] ${d}`));
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`HyperFrames exited with code ${code}`))));
    });

    await fs.access(out);
    return out;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/** Resolves the capture referenced by a project, relative to the project file. */
export function sourceVideoPath(projectPath: string, project: DemoProject): string {
  return path.isAbsolute(project.sourceVideo)
    ? project.sourceVideo
    : path.resolve(path.dirname(path.resolve(projectPath)), project.sourceVideo);
}

/** The name the source clip takes inside the render working directory. */
export function videoSrcName(source: string): string {
  return `source${path.extname(source) || ".webm"}`;
}

export async function renderVideo(projectPath: string, outputPath?: string) {
  const absProject = path.resolve(projectPath);
  const project = DemoProjectSchema.parse(JSON.parse(await fs.readFile(absProject, "utf8")));

  // Project paths are resolved against the project file, never against the
  // process cwd: an MCP server is launched by its client, from any directory.
  const source = sourceVideoPath(absProject, project);
  await fs.access(source);

  const out = path.resolve(outputPath ?? path.join(path.dirname(absProject), "final.mp4"));

  // The composition is GENERATED from project.json, which stays the single
  // source of truth. Nothing travels as a CLI variable, so nested data such as
  // the zoom track is never reduced to an unvalidated JSON string.
  const videoSrc = videoSrcName(source);
  return renderCompositionHtml(generateComposition(project, { videoSrc }), source, out, videoSrc);
}
