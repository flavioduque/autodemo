import fs from "node:fs/promises";
import path from "node:path";
import { DemoProjectSchema, durationMs, type DemoProject, type DemoProjectInput } from "@autodemo/schema";
import { buildAutoZooms, buildCaptionSkeleton } from "@autodemo/core";

export type BuildProjectOptions = {
  /**
   * How long a skeleton caption stays up when nothing follows it. A pacing
   * preset names its own (SKILL.md section 2); `project_build` leaves it at the
   * core default. A plain number: it is a knob handed in by a caller, and it is
   * branded here, at the boundary, before core sees it.
   */
  captionHoldMs?: number;
};

export async function buildProject(captureManifestPath: string, title: string, options: BuildProjectOptions = {}): Promise<{project: DemoProject; projectPath: string}> {
  const raw = JSON.parse(await fs.readFile(captureManifestPath, "utf8"));
  if (!raw.videoPath) throw new Error("Capture manifest has no videoPath");
  if (!Array.isArray(raw.actions)) throw new Error("Capture manifest has no actions array");
  if (!Number.isFinite(raw.durationMs) || raw.durationMs <= 0) throw new Error("Invalid capture duration");

  // The manifest's numbers become time HERE, through the schema — not by being
  // handed to core as untyped JSON. So the base project is parsed first, and the
  // tracks core derives are computed from its branded actions and duration.
  const base = DemoProjectSchema.parse({
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
    zooms: [],
    // Identity edit: one segment over the whole capture at normal speed. The
    // render is unchanged until someone actually edits the timeline.
    editList: [{ sourceFromMs: 0, sourceToMs: raw.durationMs, speed: 1 }],
    callouts: [],
    captions: []
  });

  // INGRESS: the caption hold is a knob, branded once on its way into core.
  const holdMs = options.captionHoldMs === undefined ? undefined : durationMs(options.captionHoldMs);

  // Parsed again so the derived tracks are validated exactly as any other
  // project's would be (a caption with toMs <= fromMs is refused, not written).
  const project = DemoProjectSchema.parse({
    ...base,
    zooms: buildAutoZooms(base.actions, base.durationMs),
    // A caption SKELETON, not finished narration: every labelled action becomes
    // a line already timed and split per word, so the agent only has to rewrite
    // the prose (project_update) instead of timing it. A capture with no labels
    // produces no captions.
    captions: buildCaptionSkeleton(base.actions, base.durationMs, holdMs)
  });

  const projectPath = path.join(path.dirname(captureManifestPath), "project.json");
  await fs.writeFile(projectPath, JSON.stringify(project, null, 2));
  return { project, projectPath };
}

/**
 * A patch is the UN-BRANDED side of the boundary: it is what `project_update`
 * receives as JSON and what `DemoProjectSchema.parse` accepts. The brands are
 * put on by the parse inside `updateProject`, never by the caller.
 */
export type ProjectPatch = {
  title?: DemoProjectInput["title"];
  /** The rendered frame. Absent from the patch = leave it as it is. */
  output?: DemoProjectInput["output"];
  style?: Partial<DemoProjectInput["style"]>;
  zooms?: DemoProjectInput["zooms"];
  editList?: DemoProjectInput["editList"];
  callouts?: DemoProjectInput["callouts"];
  captions?: DemoProjectInput["captions"];
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
