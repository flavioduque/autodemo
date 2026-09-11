import { z } from "zod";

export const ActionSchema = z.object({
  id: z.string(),
  type: z.enum(["goto", "click", "fill", "wait", "screenshot", "scroll", "keypress"]),
  atMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative().default(0),
  label: z.string().optional(),
  selector: z.string().optional(),
  value: z.string().optional(),
  url: z.string().optional(),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  deltaX: z.number().optional(),
  deltaY: z.number().optional(),
  key: z.string().optional()
});

export const ZoomSchema = z.object({
  fromMs: z.number().nonnegative(),
  toMs: z.number().positive(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  scale: z.number().min(1).max(3).default(1.35)
});

/**
 * One kept slice of the capture, played at its own speed (spec section 3).
 *
 * Output duration of a segment is `(sourceToMs - sourceFromMs) / speed`, and the
 * cumulative sum of those durations places each segment in the output timeline.
 * Cuts are implicit: source material inside no segment was cut. There is
 * deliberately no separate `trims` field — trims and speed ramps are the same
 * structure, so a cut that has no effect on the render is impossible to express.
 */
export const EditSegmentSchema = z.object({
  sourceFromMs: z.number().nonnegative(),
  sourceToMs: z.number().positive(),
  /** 1 = normal, 2.5 = fast, 0.5 = slow motion. Never 0 or negative. */
  speed: z.number().positive().default(1)
}).refine((v) => v.sourceToMs > v.sourceFromMs, "sourceToMs must be greater than sourceFromMs");

export const CalloutSchema = z.object({
  fromMs: z.number().nonnegative(),
  toMs: z.number().positive(),
  text: z.string().min(1),
  x: z.number().min(0).max(1).default(0.5),
  y: z.number().min(0).max(1).default(0.85)
});

/**
 * One word of a caption, in the capture's time base.
 *
 * WHY PER-WORD TIMESTAMPS NOW, WITH NO AUDIO: today they are filled by a
 * deterministic synthetic distribution across the caption window (see
 * `distributeWords` in @demomotion/core). When voiceover/TTS lands, the SAME
 * field is filled from real audio alignment and the compositor does not change
 * a line — it already reads word windows, not a paragraph. The structure is
 * modelled once, correctly, instead of being migrated later.
 */
export const CaptionWordSchema = z.object({
  text: z.string().min(1),
  fromMs: z.number().nonnegative(),
  toMs: z.number().positive()
}).refine((v) => v.toMs > v.fromMs, "toMs must be greater than fromMs");

/** A line of narration anchored in sourceMs, like zooms and callouts. */
export const CaptionSchema = z.object({
  fromMs: z.number().nonnegative(),
  toMs: z.number().positive(),
  text: z.string().min(1),
  words: z.array(CaptionWordSchema).default([])
}).refine((v) => v.toMs > v.fromMs, "toMs must be greater than fromMs");

/**
 * The frame the video is RENDERED at, when it differs from the frame it was
 * recorded at.
 *
 * WHY A SEPARATE, OPTIONAL PAIR AND NOT A RENAME. `width`/`height` are the
 * capture's own dimensions, and every normalized coordinate in the project —
 * action `x`/`y`, zoom anchors, the cursor track — is expressed against THAT
 * frame. Renaming them, or redefining them as "the output", would silently
 * reinterpret every project.json already on disk. So the recorded frame keeps
 * its name, and the new frame is the one that did not exist before.
 *
 * ABSENT MEANS "the same as the source", which is exactly what one pair meant:
 * an old project renders byte-for-byte as it did. And the pair is one object
 * rather than two loose fields, so a half-specified canvas (a width with no
 * height) cannot be expressed at all.
 */
export const OutputFrameSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive()
});

export const DemoProjectSchema = z.object({
  version: z.literal(1),
  title: z.string(),
  sourceVideo: z.string(),
  /** The RECORDED frame. Normalized coordinates live in this frame. */
  width: z.number().positive().default(1920),
  height: z.number().positive().default(1080),
  /** The RENDERED frame. Absent = the recorded frame. */
  output: OutputFrameSchema.optional(),
  fps: z.number().positive().default(30),
  durationMs: z.number().positive(),
  style: z.object({
    background: z.string().default("#0b1020"),
    padding: z.number().min(0).max(300).default(56),
    radius: z.number().min(0).max(100).default(24),
    shadow: z.boolean().default(true),
    /* --- Caption look. Restrained by default: this sits over software UI, where
       theatrical captions read as cheap. Every knob can be dialled up. --- */
    /** Idle word colour inside the caption band. */
    captionColor: z.string().default("#c8d2e6"),
    /** The word being spoken right now. Sober weight/colour emphasis. */
    captionActiveColor: z.string().default("#ffffff"),
    /** Thin underline under the active word. Same cyan as the click ring. */
    captionAccent: z.string().default("#38bdf8"),
    /** Extra scale on the active word. 0 = colour and weight only. */
    captionEmphasis: z.number().min(0).max(0.4).default(0.06),
    /** Multiplies the width-derived caption type size. */
    captionScale: z.number().min(0.5).max(2.5).default(1),
    /* --- Transitions. 0 means off for every one of them. --- */
    /**
     * Crossfade at each EditList cut. The junction the edit list already
     * declares is exactly where a transition belongs, so no scene detection is
     * needed. A dissolve has to BORROW material from the other side of the cut,
     * so it is clamped by whatever handle exists.
     */
    cutTransitionMs: z.number().min(0).max(2000).default(180),
    /** Fade up from the background at the start of the video. */
    openingFadeMs: z.number().min(0).max(5000).default(320),
    /** Fade down to the background at the end of the video. */
    endingFadeMs: z.number().min(0).max(5000).default(420)
  }),
  actions: z.array(ActionSchema),
  zooms: z.array(ZoomSchema).default([]),
  /** The only time-editing structure. An empty list means nothing survives. */
  editList: z.array(EditSegmentSchema),
  callouts: z.array(CalloutSchema).default([]),
  /**
   * Narration lines, anchored in sourceMs. Unlike `editList`, an ABSENT caption
   * list is a legitimate "no captions", so it defaults to empty instead of
   * making an old project invalid.
   */
  captions: z.array(CaptionSchema).default([])
});

export type DemoProject = z.infer<typeof DemoProjectSchema>;
export type DemoAction = z.infer<typeof ActionSchema>;
export type DemoZoom = z.infer<typeof ZoomSchema>;
export type DemoEditSegment = z.infer<typeof EditSegmentSchema>;
export type DemoCaption = z.infer<typeof CaptionSchema>;
export type DemoCaptionWord = z.infer<typeof CaptionWordSchema>;

export type DemoOutputFrame = z.infer<typeof OutputFrameSchema>;

/** The frame the capture was recorded at: where every normalized coordinate lives. */
export function sourceSize(project: Pick<DemoProject, "width" | "height">): { width: number; height: number } {
  return { width: project.width, height: project.height };
}

/** The frame the video is rendered at. Absent output = the source frame. */
export function outputSize(project: Pick<DemoProject, "width" | "height" | "output">): { width: number; height: number } {
  return project.output ? { width: project.output.width, height: project.output.height } : sourceSize(project);
}
