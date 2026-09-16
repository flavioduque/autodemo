import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { PLAYWRIGHT_VERSION } from "./versions.js";

/**
 * Startup diagnostics for `autodemo mcp`.
 *
 * An `npx` user has no repo, no README open and no terminal for the server:
 * the MCP client launches it and shows its stderr in a log. So each problem is
 * ONE line on stderr, naming the fix, printed once at startup — instead of an
 * error that only surfaces minutes later, at `session_start` or mid-encode at
 * `session_stop`. Nothing here is fatal: a host that only renders (no capture)
 * needs neither a capture browser nor ffmpeg.
 */

export interface PreflightOptions {
  env?: NodeJS.ProcessEnv;
  /** Playwright's bundled Chromium binary. Injected by tests; the real one otherwise. */
  bundledExecutable?: string;
  /** Where a named channel's binary may live on this platform. Injected by tests. */
  channelCandidates?: (channel: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => string[];
}

export interface PreflightReport {
  warnings: string[];
  /** What `session_start` will launch, as far as can be told without launching it. */
  browser: "bundled" | "channel" | "executable" | "unverified" | "missing";
  ffmpeg: boolean;
  ffprobe: boolean;
}

export const BROWSER_FIXES =
  `run "npx playwright@${PLAYWRIGHT_VERSION} install chromium" to install Playwright's Chromium, ` +
  `or set AUTODEMO_BROWSER_CHANNEL=chrome to drive an installed Google Chrome`;

/**
 * Mirrors the locations Playwright's own registry looks in for a channel. Kept
 * small on purpose: the goal is a good warning, not a second registry. A channel
 * no platform's table knows is reported as unverified, never as missing. A
 * channel the table knows on ANOTHER platform only — Edge Canary and Chrome
 * Canary have no Linux build — is missing here: Playwright cannot launch it.
 */
export function defaultChannelCandidates(channel: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const onPath = (...names: string[]) =>
    names.flatMap((name) => (env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name)));
  if (platform === "darwin") {
    const app = (name: string, bin: string) => `/Applications/${name}.app/Contents/MacOS/${bin}`;
    return {
      chrome: [app("Google Chrome", "Google Chrome")],
      "chrome-beta": [app("Google Chrome Beta", "Google Chrome Beta")],
      "chrome-dev": [app("Google Chrome Dev", "Google Chrome Dev")],
      "chrome-canary": [app("Google Chrome Canary", "Google Chrome Canary")],
      chromium: [app("Chromium", "Chromium")],
      msedge: [app("Microsoft Edge", "Microsoft Edge")],
      "msedge-beta": [app("Microsoft Edge Beta", "Microsoft Edge Beta")],
      "msedge-dev": [app("Microsoft Edge Dev", "Microsoft Edge Dev")],
      "msedge-canary": [app("Microsoft Edge Canary", "Microsoft Edge Canary")]
    }[channel] ?? [];
  }
  if (platform === "linux") {
    return {
      chrome: ["/opt/google/chrome/chrome", ...onPath("google-chrome", "google-chrome-stable")],
      "chrome-beta": ["/opt/google/chrome-beta/chrome", ...onPath("google-chrome-beta")],
      "chrome-dev": ["/opt/google/chrome-unstable/chrome", ...onPath("google-chrome-unstable")],
      chromium: [...onPath("chromium", "chromium-browser")],
      msedge: ["/opt/microsoft/msedge/msedge", ...onPath("microsoft-edge", "microsoft-edge-stable")],
      "msedge-beta": ["/opt/microsoft/msedge-beta/msedge", ...onPath("microsoft-edge-beta")],
      "msedge-dev": ["/opt/microsoft/msedge-dev/msedge", ...onPath("microsoft-edge-dev")]
    }[channel] ?? [];
  }
  if (platform === "win32") {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]].filter((r): r is string => !!r);
    const under = (sub: string) => roots.map((root) => path.join(root, sub));
    return {
      chrome: under("Google\\Chrome\\Application\\chrome.exe"),
      "chrome-beta": under("Google\\Chrome Beta\\Application\\chrome.exe"),
      "chrome-dev": under("Google\\Chrome Dev\\Application\\chrome.exe"),
      "chrome-canary": under("Google\\Chrome SxS\\Application\\chrome.exe"),
      msedge: under("Microsoft\\Edge\\Application\\msedge.exe"),
      "msedge-beta": under("Microsoft\\Edge Beta\\Application\\msedge.exe"),
      "msedge-dev": under("Microsoft\\Edge Dev\\Application\\msedge.exe"),
      "msedge-canary": under("Microsoft\\Edge SxS\\Application\\msedge.exe")
    }[channel] ?? [];
  }
  return [];
}

/** The platforms the table above knows. */
const PLATFORMS: NodeJS.Platform[] = ["darwin", "linux", "win32"];

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

/** First directory on `env.PATH` holding an executable of that name, or null. */
export async function findOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
    : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

export async function preflight(options: PreflightOptions = {}): Promise<PreflightReport> {
  const env = options.env ?? process.env;
  const warnings: string[] = [];

  // --- capture browser ----------------------------------------------------
  let browser: PreflightReport["browser"];
  const channel = env.AUTODEMO_BROWSER_CHANNEL?.trim();
  const executable = env.AUTODEMO_BROWSER_EXECUTABLE?.trim();
  if (executable) {
    // A specific binary wins over a channel and over the bundled build (the
    // launch gives it the same precedence), so it is the only thing to check.
    if (await exists(executable)) {
      browser = "executable";
    } else {
      browser = "missing";
      warnings.push(
        `no usable capture browser: AUTODEMO_BROWSER_EXECUTABLE is set but ${executable} does not exist; fix the path or unset it, ${BROWSER_FIXES}`
      );
    }
  } else if (channel) {
    const candidatesFor = options.channelCandidates ?? defaultChannelCandidates;
    const candidates = candidatesFor(channel, process.platform, env);
    if (candidates.length > 0) {
      if ((await Promise.all(candidates.map(exists))).some(Boolean)) {
        browser = "channel";
      } else {
        browser = "missing";
        warnings.push(
          `no usable capture browser: AUTODEMO_BROWSER_CHANNEL is set but browser channel "${channel}" was not found ` +
          `(looked in ${candidates.join(", ")}); install that browser, ${BROWSER_FIXES}`
        );
      }
    } else if (PLATFORMS.some((platform) => platform !== process.platform && candidatesFor(channel, platform, env).length > 0)) {
      // Known elsewhere, absent here by construction: there is nothing to look for.
      browser = "missing";
      warnings.push(
        `no usable capture browser: AUTODEMO_BROWSER_CHANNEL is set but browser channel "${channel}" is not available on ` +
        `${process.platform} (Playwright has no such build for this platform); unset it or pick a channel this platform has, ${BROWSER_FIXES}`
      );
    } else {
      browser = "unverified";
    }
  } else {
    const bundled = options.bundledExecutable ?? chromium.executablePath();
    if (await exists(bundled)) {
      browser = "bundled";
    } else {
      browser = "missing";
      warnings.push(
        `no usable capture browser: Playwright's bundled Chromium is not installed (expected at ${bundled}); ${BROWSER_FIXES}`
      );
    }
  }

  // --- encoder -------------------------------------------------------------
  const ffmpeg = (await findOnPath("ffmpeg", env)) !== null;
  const ffprobe = (await findOnPath("ffprobe", env)) !== null;
  if (!ffmpeg || !ffprobe) {
    const missing = [!ffmpeg && "ffmpeg", !ffprobe && "ffprobe"].filter(Boolean).join(" and ");
    warnings.push(
      `${missing} not found on PATH: session_stop will fail when it assembles the capture; ` +
      `install ffmpeg (macOS: brew install ffmpeg; Debian/Ubuntu: apt-get install ffmpeg; Windows: winget install ffmpeg) and restart the server`
    );
  }

  return { warnings, browser, ffmpeg, ffprobe };
}
