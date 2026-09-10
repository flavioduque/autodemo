import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

export async function renderVideo(projectPath: string, outputPath?: string) {
  const absProject = path.resolve(projectPath);
  const raw = JSON.parse(await fs.readFile(absProject, "utf8"));
  if (!raw.sourceVideo) throw new Error("Project has no sourceVideo");

  const source = path.resolve(raw.sourceVideo);
  await fs.access(source);

  const studioDir = path.resolve("apps/studio");
  const assetDir = path.join(studioDir, "public", "__demomotion");
  await fs.mkdir(assetDir, {recursive: true});

  const token = crypto.randomUUID();
  const ext = path.extname(source) || ".webm";
  const assetName = `${token}${ext}`;
  const assetPath = path.join(assetDir, assetName);
  const propsPath = path.join(path.dirname(absProject), `.render-${token}.json`);
  const out = path.resolve(outputPath ?? path.join(path.dirname(absProject), "final.mp4"));

  await fs.copyFile(source, assetPath);
  await fs.writeFile(propsPath, JSON.stringify({...raw, sourceVideo: `__demomotion/${assetName}`}, null, 2));

  const args = [
    "--dir", studioDir,
    "exec", "remotion", "render",
    "src/index.ts",
    "DemoMotion",
    out,
    "--props", propsPath,
    "--codec", "h264"
  ];

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("pnpm", args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (d) => process.stderr.write(`[remotion] ${d}`));
      child.stderr.on("data", (d) => process.stderr.write(`[remotion] ${d}`));
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Remotion exited with code ${code}`)));
    });
    await fs.access(out);
    return out;
  } finally {
    await Promise.allSettled([fs.rm(assetPath, {force:true}), fs.rm(propsPath, {force:true})]);
  }
}
