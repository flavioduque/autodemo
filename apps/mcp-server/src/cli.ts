import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";
import { renderVideo } from "./render.js";
import { sessionsRoot } from "./session-manager.js";
import { preflight } from "./preflight.js";
import { PLAYWRIGHT_VERSION, VERSION } from "./versions.js";

/**
 * The `demomotion` bin.
 *
 *   demomotion            the MCP server over stdio (what an MCP client runs)
 *   demomotion mcp        the same, spelled out
 *   demomotion render <project.json> [--out file.mp4]
 *   demomotion --version | --help
 *
 * Hand-rolled on purpose: four verbs do not justify a CLI framework, and every
 * dependency here is paid for by every `npx demomotion` user on first run.
 */

export type CliCommand =
  | { command: "mcp" }
  | { command: "render"; project: string; out: string | undefined }
  | { command: "version" }
  | { command: "help" };

export const HELP = `demomotion ${VERSION} — agent-first product demo videos over MCP

Usage:
  demomotion                      Run the MCP server over stdio (default)
  demomotion mcp                  Same as above
  demomotion render <project.json> [--out <file.mp4>]
                                  Render a project to MP4 (default: final.mp4 next to the project)
  demomotion --version            Print the version
  demomotion --help               Print this help

MCP client configuration:
  { "mcpServers": { "demomotion": { "command": "npx", "args": ["-y", "demomotion"] } } }

Environment:
  DEMOMOTION_HOME              Where sessions are written (<home>/sessions). Default: ~/.demomotion
  DEMOMOTION_ALLOWED_HOSTS     Hosts the recorded browser may reach. Default: localhost, 127.0.0.1, ::1
  DEMOMOTION_BROWSER_CHANNEL   Drive an installed browser (chrome, msedge) instead of the bundled Chromium
  HYPERFRAMES_BROWSER_PATH     Chrome for the renderer; without it HyperFrames downloads its own

Needs ffmpeg and ffprobe on PATH, and a Chromium: either
  npx playwright@${PLAYWRIGHT_VERSION} install chromium   or   DEMOMOTION_BROWSER_CHANNEL=chrome
`;

/** Pure: argv in, a command out, or an Error naming exactly what was refused. */
export function parseArgs(argv: string[]): CliCommand {
  const [first, ...rest] = argv;
  if (first === undefined || first === "mcp") {
    if (rest.length > 0) throw new Error(`unexpected argument: ${rest[0]}`);
    return { command: "mcp" };
  }
  if (first === "--version" || first === "-v") return { command: "version" };
  if (first === "--help" || first === "-h" || first === "help") return { command: "help" };
  if (first === "render") {
    let project: string | undefined;
    let out: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--out") {
        const value = rest[++i];
        if (value === undefined || value.startsWith("--")) throw new Error("--out needs a file path");
        out = value;
      } else if (arg.startsWith("--out=")) {
        out = arg.slice("--out=".length);
        if (!out) throw new Error("--out needs a file path");
      } else if (arg.startsWith("-")) {
        throw new Error(`unknown option: ${arg}`);
      } else if (project === undefined) {
        project = arg;
      } else {
        throw new Error(`unexpected argument: ${arg}`);
      }
    }
    if (project === undefined) throw new Error("render needs a project.json path");
    return { command: "render", project, out };
  }
  throw new Error(`unknown command: ${first}`);
}

/**
 * Runs one command. Returns the exit code instead of calling `process.exit`, so
 * a test can drive it in-process and the stdio server keeps the loop alive.
 *
 * In `mcp` mode stdout belongs to JSON-RPC: everything human-readable goes to
 * stderr, including the preflight warnings.
 */
export async function main(argv: string[]): Promise<number> {
  let parsed: CliCommand;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`demomotion: ${(error as Error).message}\n\n${HELP}`);
    return 2;
  }

  switch (parsed.command) {
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case "help":
      process.stdout.write(HELP);
      return 0;
    case "render": {
      try {
        const out = await renderVideo(parsed.project, parsed.out);
        process.stdout.write(`${out}\n`);
        return 0;
      } catch (error) {
        process.stderr.write(`demomotion: render failed: ${(error as Error).message}\n`);
        return 1;
      }
    }
    case "mcp": {
      void serveStdio(createServer);
      process.stderr.write(`DemoMotion MCP ${VERSION} running on stdio; sessions are written under ${sessionsRoot()}\n`);
      // Diagnostics AFTER the transport is up: a client that connects first and
      // reads the warnings second is better served than one kept waiting.
      const report = await preflight();
      for (const warning of report.warnings) process.stderr.write(`demomotion: warning: ${warning}\n`);
      return 0;
    }
  }
}

// Only act when this file is the process entrypoint. `argv[1]` is the path the
// process was started with — through `node_modules/.bin/demomotion` that is the
// symlink — while `import.meta.url` is always the real file, so compare real
// paths. Importing this module (a test of `parseArgs`) must never start anything.
function isEntrypoint(): boolean {
  const started = process.argv[1];
  if (!started) return false;
  try {
    return realpathSync(started) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  // `exitCode` is only honoured once the loop drains: a finished command exits
  // with it, while the stdio server keeps running on its open pipes.
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`demomotion: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
