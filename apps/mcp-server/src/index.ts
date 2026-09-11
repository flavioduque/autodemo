import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import {
  startSession, goto, click, fill, wait, screenshot, stopSession, status, scroll, keypress, inspectPage
} from "./session-manager.js";
import { buildProject, updateProject } from "./project.js";
import { renderVideo } from "./render.js";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const result = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }]
});

/**
 * One kept slice of the capture, played at its own speed (spec section 3).
 * Cuts are implicit: source material inside no segment was cut. This mirrors
 * EditSegmentSchema in @demomotion/schema, restated here because the MCP surface
 * is built with its own zod instance.
 */
const editSegmentInput = z.object({
  sourceFromMs: z.number().nonnegative(),
  sourceToMs: z.number().positive(),
  speed: z.number().positive().default(1)
}).refine((v) => v.sourceToMs > v.sourceFromMs, "sourceToMs must be greater than sourceFromMs");

/** One word of narration, in the capture's time base. */
const captionWordInput = z.object({
  text: z.string().min(1),
  fromMs: z.number().nonnegative(),
  toMs: z.number().positive()
}).refine((v) => v.toMs > v.fromMs, "toMs must be greater than fromMs");

const captionInput = z.object({
  fromMs: z.number().nonnegative(),
  toMs: z.number().positive(),
  text: z.string().min(1),
  words: z.array(captionWordInput).default([])
}).refine((v) => v.toMs > v.fromMs, "toMs must be greater than fromMs");

/**
 * Milliseconds between keystrokes when nothing is asked for.
 *
 * WHY TYPING IS THE DEFAULT. An agent sends the parameters it is told to send;
 * an optional knob for "look less rushed" would be left unset on almost every
 * demo, and the tool would keep producing the exact artifact the feedback was
 * about. The rushed look is the defect, so the fix is the default and instant is
 * the opt-out — one explicit `typeDelayMs: 0` away.
 *
 * WHY 40. Capture runs at 30 fps, so a frame is 33.3 ms: at 40 ms per character
 * every keystroke lands on a frame of its own and the value is seen GROWING.
 * Below ~33 ms characters start sharing a frame and the fill collapses back
 * towards the single-frame jump this exists to remove; much above ~60 ms the
 * demo starts to drag. 40 ms is also about 300 characters a minute — brisk,
 * confident typing rather than hunt-and-peck.
 */
const DEFAULT_TYPE_DELAY_MS = 40;

/** Exported so the accepted surface can be exercised without booting a server. */
export const browserFillInput = z.object({
  sessionId: z.string(),
  selector: z.string().min(1),
  value: z.string(),
  label: z.string().optional(),
  /**
   * Per-character delay. 25–60 ms is the useful band for a demo; 0 restores the
   * instant fill. Capped at 200 ms — past that a field takes longer to fill than
   * anyone will watch.
   */
  typeDelayMs: z.number().int().min(0).max(200).default(DEFAULT_TYPE_DELAY_MS)
});

/** Exported so the accepted surface can be exercised without booting a server. */
export const projectUpdateInput = z.object({
  projectPath: z.string(),
  title: z.string().optional(),
  style: z.object({
    background: z.string().optional(), padding: z.number().min(0).max(300).optional(),
    radius: z.number().min(0).max(100).optional(), shadow: z.boolean().optional(),
    // Caption look. Restrained by default; these are the knobs that dial it up.
    captionColor: z.string().optional(), captionActiveColor: z.string().optional(),
    captionAccent: z.string().optional(), captionEmphasis: z.number().min(0).max(0.4).optional(),
    captionScale: z.number().min(0.5).max(2.5).optional(),
    // Transitions. 0 turns each of them off.
    cutTransitionMs: z.number().min(0).max(2000).optional(),
    openingFadeMs: z.number().min(0).max(5000).optional(),
    endingFadeMs: z.number().min(0).max(5000).optional()
  }).optional(),
  zooms: z.array(z.object({fromMs:z.number().nonnegative(),toMs:z.number().positive(),x:z.number().min(0).max(1),y:z.number().min(0).max(1),scale:z.number().min(1).max(3)})).optional(),
  editList: z.array(editSegmentInput).optional(),
  callouts: z.array(z.object({fromMs:z.number().nonnegative(),toMs:z.number().positive(),text:z.string().min(1),x:z.number().min(0).max(1).default(.5),y:z.number().min(0).max(1).default(.85)})).optional(),
  /**
   * Narration, anchored in sourceMs. `words` carries per-word timestamps: today
   * they come from the deterministic synthetic split `project_build` seeds, and
   * when voiceover lands they will come from real audio alignment — the shape
   * does not change. Sending a caption without `words` is legal; it just gets
   * no word-by-word highlight.
   */
  captions: z.array(captionInput).optional()
});

function createServer() {
  const server = new McpServer({
    name: "demomotion",
    version: "0.2.0",
    description: "Agent-first browser capture, automated timeline generation and HyperFrames rendering."
  });

  server.registerTool("session_start", {
    description: "Start a browser recording session. Call this before navigating the product demo.",
    inputSchema: z.object({
      width: z.number().int().min(640).max(3840).default(1920),
      height: z.number().int().min(480).max(2160).default(1080),
      headless: z.boolean().default(false)
    })
  }, async (input) => result({ sessionId: (await startSession(input)).id }));


  server.registerTool("browser_inspect", {
    description: "Inspect the current page and return a compact list of interactive elements with stable selector candidates. Covers EVERY frame, not just the top document: each element carries the `frameUrl` it came from, and a frame that could not be read is reported in `skippedFrames` instead of failing the call.",
    inputSchema: z.object({ sessionId: z.string(), limit: z.number().int().min(1).max(200).default(80) })
  }, async ({sessionId, limit}) => result(await inspectPage(sessionId, limit)));

  server.registerTool("browser_scroll", {
    description: "Scroll the recorded page and persist the action in the timeline. When the top document has nothing left to scroll, the wheel is aimed at the largest frame that does.",
    inputSchema: z.object({ sessionId: z.string(), deltaY: z.number().int().min(-10000).max(10000), deltaX: z.number().int().min(-10000).max(10000).default(0) })
  }, async ({sessionId, deltaY, deltaX}) => { await scroll(sessionId, deltaY, deltaX); return result({ok:true}); });

  server.registerTool("browser_keypress", {
    description: "Press a keyboard key or Playwright key chord while recording.",
    inputSchema: z.object({ sessionId: z.string(), key: z.string().min(1).max(80) })
  }, async ({sessionId, key}) => { await keypress(sessionId, key); return result({ok:true}); });

  server.registerTool("browser_goto", {
    description: "Navigate the recorded browser to a URL.",
    inputSchema: z.object({ sessionId: z.string(), url: z.url() })
  }, async ({sessionId, url}) => {
    await goto(sessionId, url);
    return result({ ok: true, url });
  });

  server.registerTool("browser_click", {
    description: "Click a visible element while recording. Prefer stable data-testid or accessible selectors. The selector is resolved across frames — main frame first, then the other frames in attachment order, first match wins — so a control inside an <iframe> is reachable with the same plain selector.",
    inputSchema: z.object({
      sessionId: z.string(),
      selector: z.string().min(1),
      label: z.string().optional()
    })
  }, async ({sessionId, selector, label}) => {
    await click(sessionId, selector, label);
    return result({ ok: true });
  });

  server.registerTool("browser_fill", {
    description:
      "Fill an input while recording. BY DEFAULT the value is TYPED character by character, because a field that jumps from empty to complete in a single frame is the most rushed-looking thing in a form demo — a viewer reads typing as a person, and an instant fill as a machine. " +
      "Set typeDelayMs: 0 to go back to an instant fill for values nobody wants to watch being typed: a UUID, an API token, a long opaque id. Typing lengthens the capture (roughly value.length * typeDelayMs), so budget for it when planning the demo's duration. " +
      "The value is redacted from the timeline manifest either way. The selector is resolved across frames on the same rule as browser_click.",
    inputSchema: browserFillInput
  }, async ({sessionId, selector, value, label, typeDelayMs}) => {
    await fill(sessionId, selector, value, label, typeDelayMs);
    return result({ ok: true });
  });

  server.registerTool("browser_wait", {
    description: "Wait during a recording only when needed for an animation, network operation or intentional pacing.",
    inputSchema: z.object({
      sessionId: z.string(),
      ms: z.number().int().min(50).max(30000)
    })
  }, async ({sessionId, ms}) => {
    await wait(sessionId, ms);
    return result({ ok: true });
  });

  server.registerTool("browser_screenshot", {
    description: "Capture a diagnostic screenshot during the session.",
    inputSchema: z.object({
      sessionId: z.string(),
      name: z.string().optional()
    })
  }, async ({sessionId, name}) => result({ path: await screenshot(sessionId, name) }));

  server.registerTool("session_status", {
    description: "Inspect current session duration, URL and action count.",
    inputSchema: z.object({ sessionId: z.string() })
  }, async ({sessionId}) => result(status(sessionId)));

  server.registerTool("session_stop", {
    description: "Stop recording and persist capture.json with source video and action timeline.",
    inputSchema: z.object({ sessionId: z.string() })
  }, async ({sessionId}) => result(await stopSession(sessionId)));

  server.registerTool("project_build", {
    description: "Convert a capture manifest into a DemoMotion project and generate automatic zoom regions from interactions.",
    inputSchema: z.object({
      captureManifestPath: z.string(),
      title: z.string().min(1).default("Product Demo")
    })
  }, async ({captureManifestPath, title}) => result(await buildProject(captureManifestPath, title)));


  server.registerTool("project_update", {
    description: "Update editable project styling, zooms, edit list (cuts and speed ramps), callouts, captions (word-by-word narration) or title without modifying the raw recording.",
    inputSchema: projectUpdateInput
  }, async ({projectPath, ...patch}) => result(await updateProject(projectPath, patch)));


  server.registerTool("demo_finalize", {
    description: "Stop an active session, build the editable project and render the final MP4 in one deterministic finalization step.",
    inputSchema: z.object({
      sessionId: z.string(),
      title: z.string().min(1).default("Product Demo"),
      outputPath: z.string().optional()
    })
  }, async ({sessionId, title, outputPath}) => {
    const capture = await stopSession(sessionId);
    const built = await buildProject(capture.manifestPath, title);
    const rendered = await renderVideo(built.projectPath, outputPath);
    const stat = await fs.stat(rendered);
    return result({captureManifestPath:capture.manifestPath, projectPath:built.projectPath, outputPath:rendered, bytes:stat.size});
  });

  server.registerTool("render_video", {
    description: "Render a DemoMotion project to MP4 using the HyperFrames compositor.",
    inputSchema: z.object({
      projectPath: z.string(),
      outputPath: z.string().optional()
    })
  }, async ({projectPath, outputPath}) => result({ outputPath: await renderVideo(projectPath, outputPath) }));

  return server;
}

// Only speak stdio when this file is the process entrypoint. Importing it
// (a test inspecting the tool surface, for instance) must not start a server.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  void serveStdio(createServer);
  console.error("DemoMotion MCP running on stdio");
}
