import fs from "node:fs/promises";
import path from "node:path";
import { DemoProjectSchema, type DemoProject } from "@demomotion/schema";
import { buildAutoZooms } from "@demomotion/core";

export async function buildProject(captureManifestPath: string, title: string): Promise<{project: DemoProject; projectPath: string}> {
  const raw = JSON.parse(await fs.readFile(captureManifestPath, "utf8"));
  if (!raw.videoPath) throw new Error("Capture manifest has no videoPath");
  if (!Array.isArray(raw.actions)) throw new Error("Capture manifest has no actions array");
  if (!Number.isFinite(raw.durationMs) || raw.durationMs <= 0) throw new Error("Invalid capture duration");

  const project = DemoProjectSchema.parse({
    version: 1,
    title,
    sourceVideo: path.resolve(raw.videoPath),
    width: raw.width,
    height: raw.height,
    // The capture adapter guarantees a constant fps; carry it so the compositor's
    // sourceMs -> frame index math matches the CFR grid the video was built on.
    fps: Number.isFinite(raw.fps) && raw.fps > 0 ? raw.fps : 30,
    durationMs: raw.durationMs,
    style: { background: "#0b1020", padding: 56, radius: 24, shadow: true },
    actions: raw.actions,
    zooms: buildAutoZooms(raw.actions, raw.durationMs),
    // Identity edit: one segment over the whole capture at normal speed. The
    // render is unchanged until someone actually edits the timeline.
    editList: [{ sourceFromMs: 0, sourceToMs: raw.durationMs, speed: 1 }],
    callouts: []
  });

  const projectPath = path.join(path.dirname(captureManifestPath), "project.json");
  await fs.writeFile(projectPath, JSON.stringify(project, null, 2));
  return { project, projectPath };
}

export type ProjectPatch = {
  title?: DemoProject["title"];
  style?: Partial<DemoProject["style"]>;
  zooms?: DemoProject["zooms"];
  editList?: DemoProject["editList"];
  callouts?: DemoProject["callouts"];
};

export async function updateProject(projectPath: string, patch: ProjectPatch) {
  const current = DemoProjectSchema.parse(JSON.parse(await fs.readFile(projectPath, "utf8")));
  const next = DemoProjectSchema.parse({
    ...current,
    ...patch,
    style: patch.style ? {...current.style, ...patch.style} : current.style
  });
  await fs.writeFile(projectPath, JSON.stringify(next, null, 2));
  return next;
}
