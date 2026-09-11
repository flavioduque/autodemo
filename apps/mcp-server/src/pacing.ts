/**
 * The three pacing presets of SKILL.md section 2, as data.
 *
 * WHY THIS FILE EXISTS. Pacing is the thing a viewer notices first, and it is
 * baked into the CAPTURE — typing speed and wait lengths cannot be added in the
 * edit. The skill has always told the agent the numbers; `demo_create` is where
 * the numbers become code, so they live here, once, and the skill's table is
 * RENDERED from this file by `renderPacingTable()`. `test/pacing.test.ts`
 * asserts that SKILL.md contains that rendering verbatim: change a number here
 * without pasting the new table into the skill (or the other way round) and the
 * suite fails, naming the cell.
 *
 * Which knobs `demo_create` applies mechanically: `typeDelayMs` (and, for
 * social, only on the first field), the wait after a navigation, the wait
 * between fields, the hold on the final result, the caption hold and
 * `cutTransitionMs`, plus `output` for social. The reading pause on a new
 * screen and the speed ramps on filler are decisions about WHERE, which the
 * agent still makes (an explicit `wait` step; `project_update` with an
 * `editList`). They are carried here so the table stays one table.
 */

export const PACING_NAMES = ["product-demo", "tutorial", "social"] as const;
export type PacingName = (typeof PACING_NAMES)[number];

export interface PacingPreset {
  name: PacingName;
  /** The column header the skill uses. */
  label: string;
  /** The frame the video is published at. Absent = the capture's own frame. */
  output?: { width: number; height: number };
  /** `browser_fill` per-character delay. */
  typeDelayMs: number;
  /** When true, only the first fill is typed; the rest are instant. */
  typeOnlyFirstField: boolean;
  /** `browser_wait` inserted after a navigation. */
  waitAfterNavigationMs: number;
  /** `browser_wait` inserted between fields. */
  waitBetweenFieldsMs: number;
  /** How long the final result stays on screen before the capture stops. */
  finalHoldMs: number;
  /** A reading pause the agent inserts on a new screen (an explicit `wait` step). */
  readingPauseMs: number;
  /** How long a skeleton caption stays up when nothing follows it. */
  captionHoldMs: number;
  /** Crossfade at every `editList` cut. */
  cutTransitionMs: number;
  /** Speed ramps the agent applies on filler, when the preset wants them. */
  fillerSpeed?: { min: number; max: number };
}

export const PACING_PRESETS: Readonly<Record<PacingName, PacingPreset>> = {
  "product-demo": {
    name: "product-demo",
    label: "Product demo",
    typeDelayMs: 40,
    typeOnlyFirstField: false,
    waitAfterNavigationMs: 1200,
    waitBetweenFieldsMs: 900,
    finalHoldMs: 2500,
    readingPauseMs: 2000,
    captionHoldMs: 2200,
    cutTransitionMs: 180
  },
  tutorial: {
    name: "tutorial",
    label: "Tutorial",
    typeDelayMs: 55,
    typeOnlyFirstField: false,
    waitAfterNavigationMs: 2000,
    waitBetweenFieldsMs: 1500,
    finalHoldMs: 3500,
    readingPauseMs: 3000,
    captionHoldMs: 3000,
    cutTransitionMs: 220
  },
  social: {
    name: "social",
    label: "Social",
    // The original defect (#1): a "social" cut that came out 16:9. Vertical is
    // the default of the preset, not a parameter the caller has to remember.
    output: { width: 1080, height: 1920 },
    typeDelayMs: 30,
    typeOnlyFirstField: true,
    waitAfterNavigationMs: 700,
    waitBetweenFieldsMs: 300,
    finalHoldMs: 1500,
    readingPauseMs: 900,
    captionHoldMs: 1600,
    cutTransitionMs: 120,
    fillerSpeed: { min: 2, max: 2.5 }
  }
};

/** Per-fill delay for the n-th fill of a demo (0-based), under a preset. */
export function typeDelayForFill(preset: PacingPreset, fillIndex: number): number {
  return preset.typeOnlyFirstField && fillIndex > 0 ? 0 : preset.typeDelayMs;
}

const ms = (n: number) => `${n} ms`;

type Row = { knob: string; cell: (p: PacingPreset) => string };

/** The rows of the skill's table, in the skill's order, one renderer each. */
const ROWS: Row[] = [
  {
    knob: "`output` frame on `project_update`",
    cell: (p) => p.output
      ? `\`{"width": ${p.output.width}, "height": ${p.output.height}}\` — a 16:9 file fits no feed`
      : "omit (the capture's own frame)"
  },
  {
    knob: "`typeDelayMs` on `browser_fill`",
    cell: (p) => p.typeOnlyFirstField ? `${p.typeDelayMs}, and only on the first field` : String(p.typeDelayMs)
  },
  { knob: "`browser_wait` after a navigation", cell: (p) => ms(p.waitAfterNavigationMs) },
  { knob: "`browser_wait` between fields", cell: (p) => ms(p.waitBetweenFieldsMs) },
  { knob: "Hold on the final result", cell: (p) => ms(p.finalHoldMs) },
  { knob: "Reading pause on a new screen", cell: (p) => ms(p.readingPauseMs) },
  { knob: "Caption on screen", cell: (p) => ms(p.captionHoldMs) },
  { knob: "`cutTransitionMs`", cell: (p) => String(p.cutTransitionMs) },
  {
    knob: "Speed ramps on filler",
    cell: (p) => p.fillerSpeed ? `\`speed: ${p.fillerSpeed.min}\`–\`${p.fillerSpeed.max}\` on typing and loads` : "none"
  }
];

/**
 * The knob table of SKILL.md section 2, rendered from the presets. The skill
 * must contain this string verbatim (see test/pacing.test.ts).
 */
export function renderPacingTable(): string {
  const presets = PACING_NAMES.map((name) => PACING_PRESETS[name]);
  const lines = [
    `| Knob | ${presets.map((p) => p.label).join(" | ")} |`,
    `|---|${presets.map(() => "---").join("|")}|`,
    ...ROWS.map((row) => `| ${row.knob} | ${presets.map(row.cell).join(" | ")} |`)
  ];
  return lines.join("\n");
}
