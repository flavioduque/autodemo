import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import {
  startSession, goto, click, fill, wait, screenshot, stopSession, status, scroll, keypress, inspectPage
} from "./session-manager.js";
import { buildProject, updateProject } from "./project.js";
import { renderVideo } from "./render.js";
import fs from "node:fs/promises";

const result = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }]
});

function createServer() {
  const server = new McpServer({
    name: "demomotion",
    version: "0.2.0",
    description: "Agent-first browser capture, automated timeline generation and Remotion rendering."
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
    description: "Inspect the current page and return a compact list of interactive elements with stable selector candidates.",
    inputSchema: z.object({ sessionId: z.string(), limit: z.number().int().min(1).max(200).default(80) })
  }, async ({sessionId, limit}) => result(await inspectPage(sessionId, limit)));

  server.registerTool("browser_scroll", {
    description: "Scroll the recorded page and persist the action in the timeline.",
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
    description: "Click a visible element while recording. Prefer stable data-testid or accessible selectors.",
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
    description: "Fill an input while recording. The typed value is redacted from the timeline manifest.",
    inputSchema: z.object({
      sessionId: z.string(),
      selector: z.string().min(1),
      value: z.string(),
      label: z.string().optional()
    })
  }, async ({sessionId, selector, value, label}) => {
    await fill(sessionId, selector, value, label);
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
    description: "Update editable Remotion project styling, zooms, trims, callouts, or title without modifying the raw recording.",
    inputSchema: z.object({
      projectPath: z.string(),
      title: z.string().optional(),
      style: z.object({
        background: z.string().optional(), padding: z.number().min(0).max(300).optional(),
        radius: z.number().min(0).max(100).optional(), shadow: z.boolean().optional()
      }).optional(),
      zooms: z.array(z.object({fromMs:z.number().nonnegative(),toMs:z.number().positive(),x:z.number().min(0).max(1),y:z.number().min(0).max(1),scale:z.number().min(1).max(3)})).optional(),
      trims: z.array(z.object({fromMs:z.number().nonnegative(),toMs:z.number().positive()})).optional(),
      callouts: z.array(z.object({fromMs:z.number().nonnegative(),toMs:z.number().positive(),text:z.string().min(1),x:z.number().min(0).max(1).default(.5),y:z.number().min(0).max(1).default(.85)})).optional()
    })
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
    description: "Render a DemoMotion project to MP4 using Remotion.",
    inputSchema: z.object({
      projectPath: z.string(),
      outputPath: z.string().optional()
    })
  }, async ({projectPath, outputPath}) => result({ outputPath: await renderVideo(projectPath, outputPath) }));

  return server;
}

void serveStdio(createServer);
console.error("DemoMotion MCP running on stdio");
