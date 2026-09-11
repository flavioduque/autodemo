import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpStdioClient, step } from "./mcp-stdio-client.ts";

// ---------------------------------------------------------------------------
// The npx story, proved from the TARBALL and never from the repo.
//
// `npm pack` the package, install the tarball into a fresh directory outside
// the repository, then spawn its bin exactly as an MCP client would and speak
// JSON-RPC to it. This is the only test that can tell whether the bundle,
// the `files` whitelist, the bin shebang and the runtime `require.resolve`
// of hyperframes/gsap survive publication.
//
// It downloads the whole dependency tree from the registry (hyperframes pulls
// sharp, onnxruntime-node, puppeteer-core...), so it is gated:
//
//   DEMOMOTION_PACK_TESTS=1 pnpm --filter demomotion test:pack
// ---------------------------------------------------------------------------

const PACK = process.env.DEMOMOTION_PACK_TESTS === "1";
const skip = PACK ? false : "set DEMOMOTION_PACK_TESTS=1 to pack, install and drive the published package";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const run = promisify(execFile);

const EXPECTED_TOOLS = [
  "session_start", "browser_inspect", "browser_scroll", "browser_keypress",
  "browser_goto", "browser_click", "browser_fill", "browser_wait",
  "browser_screenshot", "session_status", "session_stop",
  "project_build", "project_update", "demo_finalize", "render_video", "demo_create"
];

/** npm on Windows is npm.cmd; spawning it needs a shell. */
const npm = (args: string[], cwd: string) =>
  run(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd, maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" });

test("the packed tarball installs in a fresh directory and speaks MCP over stdio",
  { skip, timeout: 20 * 60_000 }, async (t) => {
  const manifest = JSON.parse(await fs.readFile(path.join(PKG, "package.json"), "utf8"));
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "demomotion-pack-")));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));

  // --- npm pack -----------------------------------------------------------
  step("npm pack");
  const packed = await npm(["pack", "--pack-destination", scratch, "--json"], PKG);
  const [info] = JSON.parse(String(packed.stdout).slice(String(packed.stdout).indexOf("[")));
  const tarball = path.join(scratch, info.filename);
  await fs.access(tarball);
  const entries = (await run("tar", ["-tzf", tarball])).stdout.split("\n").map((l) => l.trim()).filter(Boolean).sort();
  process.stderr.write(`[pack] ${info.filename}: ${info.size} bytes packed, ${info.unpackedSize} unpacked, ${entries.length} files\n`);
  process.stderr.write(entries.map((e) => `[pack]   ${e}`).join("\n") + "\n");

  await t.test("ships dist, the manifest, the README and the licence — nothing else", () => {
    const allowedLoose = new Set(["package/package.json", "package/README.md", "package/LICENSE"]);
    for (const entry of entries) {
      assert.ok(allowedLoose.has(entry) || entry.startsWith("package/dist/"), `unexpected file in tarball: ${entry}`);
      assert.doesNotMatch(entry, /\/(src|test|tests|fixtures|scripts|data)\//, `${entry} should not ship`);
      if (entry.endsWith(".ts")) assert.ok(entry.endsWith(".d.ts"), `TypeScript source shipped: ${entry}`);
    }
    assert.ok(entries.includes("package/dist/cli.js"), "the bin is missing from the tarball");
    assert.ok(entries.includes("package/LICENSE"), "LICENSE is missing from the tarball");
    assert.ok(entries.includes("package/README.md"), "README.md is missing from the tarball");
    // The workspace packages are bundled in, not declared: nothing `workspace:` may
    // reach a consumer's `npm install`.
    for (const [name, range] of Object.entries(info.bundled ?? {})) assert.fail(`bundledDependencies present: ${name}@${range}`);
    assert.equal(JSON.stringify(manifest.dependencies).includes("workspace:"), false, "a workspace: range is in dependencies");
    for (const name of Object.keys(manifest.dependencies)) assert.doesNotMatch(name, /^@demomotion\//, `${name} must be bundled, not depended on`);
  });

  // --- npm install in a fresh directory outside the repo --------------------
  const install = path.join(scratch, "npx-test");
  await fs.mkdir(install);
  await fs.writeFile(path.join(install, "package.json"), JSON.stringify({ name: "npx-test", private: true }, null, 2));
  step(`npm install ${info.filename} into ${install}`);
  await npm(["install", "--no-audit", "--no-fund", "--loglevel=error", tarball], install);
  const bin = path.join(install, "node_modules", ".bin", "demomotion");
  const cliJs = path.join(install, "node_modules", "demomotion", "dist", "cli.js");
  await fs.access(cliJs);
  // Not the repo: the installed copy must resolve its dependencies from its own node_modules.
  assert.equal(cliJs.startsWith(PKG), false);
  for (const dep of ["hyperframes", "gsap", "playwright", "@modelcontextprotocol/server"]) {
    await fs.access(path.join(install, "node_modules", dep, "package.json"));
  }
  const runBin = (...args: string[]) =>
    process.platform === "win32"
      ? run(process.execPath, [cliJs, ...args], { cwd: install })
      : run(bin, args, { cwd: install }); // through the shim: exercises the shebang and the exec bit

  await t.test("--version and --help answer from the installed bin", async () => {
    const version = await runBin("--version");
    assert.equal(version.stdout.trim(), manifest.version);
    const help = await runBin("--help");
    assert.match(help.stdout, /demomotion render <project\.json>/);
    assert.match(help.stdout, /"npx", "args": \["-y", "demomotion"\]/);
    // The negative half: a bad verb fails, by name, with a non-zero exit.
    await assert.rejects(runBin("frobnicate"), (error: any) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /unknown command: frobnicate/);
      return true;
    });
  });

  await t.test("initialize and tools/list over stdio, with stdout carrying only JSON-RPC", async () => {
    const client = await McpStdioClient.start({
      command: process.platform === "win32" ? process.execPath : bin,
      args: process.platform === "win32" ? [cliJs] : [],
      cwd: install,
      env: { ...process.env, DEMOMOTION_HOME: install },
      clientName: "demomotion-pack"
    });
    try {
      assert.equal(client.firstStdoutChunk?.[0], "{", `stdout did not start with JSON-RPC: ${JSON.stringify(client.firstStdoutChunk?.slice(0, 80))}`);
      assert.equal(client.initResult.serverInfo.version, manifest.version);
      const listed = await client.request("tools/list", {});
      const names = (listed.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
      assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
      assert.equal(names.length, 16);
      // The startup line names where sessions go — the absolute directory the
      // MCP results will point into — on stderr, never stdout.
      await new Promise((r) => setTimeout(r, 300));
      assert.match(client.stderr, /DemoMotion MCP .* running on stdio; sessions are written under /);
      assert.ok(client.stderr.includes(path.join(install, "sessions")), `startup line does not name DEMOMOTION_HOME/sessions: ${client.stderr}`);
    } finally {
      client.close();
    }
  });

  await t.test("a missing capture browser and a missing ffmpeg are each ONE actionable stderr line", async () => {
    const client = await McpStdioClient.start({
      command: process.execPath,
      args: [cliJs, "mcp"],
      cwd: install,
      // PATH without ffmpeg, and a channel that cannot exist: both warnings must fire.
      env: { ...process.env, DEMOMOTION_HOME: install, PATH: path.dirname(process.execPath), DEMOMOTION_BROWSER_CHANNEL: "msedge-canary" },
      clientName: "demomotion-pack"
    });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const warnings = client.stderr.split("\n").filter((line) => line.startsWith("demomotion: warning: "));
      const browser = warnings.find((w) => /no usable capture browser/.test(w));
      const ffmpeg = warnings.find((w) => /ffmpeg/.test(w));
      assert.ok(browser, `no browser warning in:\n${client.stderr}`);
      assert.ok(ffmpeg, `no ffmpeg warning in:\n${client.stderr}`);
      assert.match(browser, /npx playwright@1\.63\.0 install chromium/);
      assert.match(browser, /DEMOMOTION_BROWSER_CHANNEL=chrome/);
      assert.match(ffmpeg, /session_stop/);
      // ...and the wire is still clean: the server answered initialize with JSON first.
      assert.equal(client.firstStdoutChunk?.[0], "{");
    } finally {
      client.close();
    }
  });
});
