# Getting started

Zero to a finished `.mp4`, per MCP client.

Every command and every config snippet on this page carries a label saying how
far it was proven:

| Label | Meaning |
|---|---|
| **run** | executed on a real machine; the output below is the real output |
| **read** | taken from the client's own config file or application bundle on disk, quoted |
| **unverified** | from the client's published documentation only — nobody ran it for this page |

The verification host was macOS 13.7.8 (x64), Node 26.8.1, ffmpeg 7.1.1,
`demomotion@0.3.0` from npm via `npx`.

---

## 1. Prerequisites

Three things. Check each one before touching a client config — a missing
prerequisite shows up minutes later, mid-render, otherwise.

**run**

```bash
node --version      # v26.8.1        — needs >= 22
ffmpeg -version     # ffmpeg version 7.1.1 …
ffprobe -version    # ffprobe version 7.1.1 …
```

`ffmpeg` **and** `ffprobe` are both required, and they are needed at
`session_stop`, not at render: that is where the frame sequence is assembled
into the source video. Install with `brew install ffmpeg` (macOS),
`apt-get install ffmpeg` (Debian/Ubuntu), `winget install ffmpeg` (Windows).

**A Chromium for capture.** Two ways to satisfy it:

```bash
npx playwright@1.63.0 install chromium      # Playwright's bundled build
```

or point DemoMotion at a browser you already have:

```bash
export DEMOMOTION_BROWSER_CHANNEL=chrome    # or msedge
```

On **macOS 13** the first option does not exist. Playwright answers, verbatim
(**run**):

```
Failed to install browsers
Error: ERROR: Playwright does not support chromium on mac13
```

So on macOS 13 — and on any host where the bundled build is missing —
`DEMOMOTION_BROWSER_CHANNEL=chrome` is not optional. Every snippet below already
sets it.

**Check what the server itself thinks.** Running the server by hand prints one
line per problem on stderr and then waits for a client on stdin. Press Ctrl-C to
leave. **run**, on a host with neither the bundled Chromium nor ffmpeg on PATH:

```
DemoMotion MCP 0.3.0 running on stdio; sessions are written under /Users/you/.demomotion/sessions
demomotion: warning: no usable capture browser: Playwright's bundled Chromium is not installed (expected at …/chromium-1243/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing); run "npx playwright@1.63.0 install chromium" to install Playwright's Chromium, or set DEMOMOTION_BROWSER_CHANNEL=chrome to drive an installed Google Chrome
demomotion: warning: ffmpeg and ffprobe not found on PATH: session_stop will fail when it assembles the capture; install ffmpeg (macOS: brew install ffmpeg; Debian/Ubuntu: apt-get install ffmpeg; Windows: winget install ffmpeg) and restart the server
```

No warnings means both are satisfied.

### The two environment variables every client needs

| Variable | Why |
|---|---|
| `DEMOMOTION_BROWSER_CHANNEL=chrome` | drives an installed Google Chrome instead of Playwright's bundled Chromium. Required on macOS 13; harmless everywhere else. |
| `DEMOMOTION_ALLOWED_HOSTS=localhost,127.0.0.1` | where the recorded browser may send bytes. **The default is already closed** (`localhost,127.0.0.1,::1`) — set this only to widen it to a staging host. |

The allowlist is an allowlist, not a blocklist: the first navigation, every
redirect, link, `fetch`/XHR, iframe and WebSocket is decided against it. A host
that is not listed is refused with a message naming the host and the fix — see
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md#a-host-was-refused-by-the-allowlist).

### First run is slow and large

The first `npx -y demomotion` downloads the package and its renderer:
**roughly 400 MB**, dominated by HyperFrames' `onnxruntime-node`. That is a
one-time cost per npm cache. Afterwards `npx -y demomotion --version` answers in
about a second (**run**: `real 0m1.058s`).

---

## 2. Install, per client

> The config key is **not** the same everywhere. Claude Code, Claude Desktop,
> Cursor, Gemini CLI, Antigravity and Windsurf use `mcpServers`. VS Code uses
> `servers`. Codex uses a TOML table, `[mcp_servers.<name>]`. Do not copy one
> client's snippet into another's file.

### Claude Code — **run**

One command. No file editing.

```bash
claude mcp add demomotion \
  -e DEMOMOTION_BROWSER_CHANNEL=chrome \
  -e DEMOMOTION_ALLOWED_HOSTS=localhost,127.0.0.1 \
  -- npx -y demomotion
```

Real output:

```
Added stdio MCP server demomotion with command: npx -y demomotion to local config
File modified: /Users/you/.claude.json [project: /path/to/your/project]
```

`claude mcp add --help` says of the scope flag: `-s, --scope <scope>
Configuration scope (local, user, or project) (default: "local")`. `local` is
private to you in the current project; use `-s user` to have it in every
project.

**Confirm the server was picked up** — `claude mcp list` health-checks every
server:

```
demomotion: npx -y demomotion - ✔ Connected
```

and `claude mcp get demomotion` shows what it will launch:

```
demomotion:
  Scope: Local config (private to you in this project)
  Status: ✔ Connected
  Type: stdio
  Command: npx
  Args: -y demomotion
  Environment:
    DEMOMOTION_BROWSER_CHANNEL=chrome
    DEMOMOTION_ALLOWED_HOSTS=localhost,127.0.0.1

To remove this server, run: claude mcp remove demomotion -s local
```

Inside a session, `/mcp` lists the tools.

### Codex CLI — **run**

`codex mcp add --help`: `Usage: codex mcp add [OPTIONS] <NAME> (--url <URL> | --
<COMMAND>...)`, with `--env <KEY=VALUE>  Environment variables to set when
launching the server. Only valid with stdio servers`.

```bash
codex mcp add demomotion \
  --env DEMOMOTION_BROWSER_CHANNEL=chrome \
  --env DEMOMOTION_ALLOWED_HOSTS=localhost,127.0.0.1 \
  -- npx -y demomotion
```

Real output: `Added global MCP server 'demomotion'.`

**Confirm** with `codex mcp list`:

```
Name        Command  Args           Env                                                               Cwd  Status   Auth
demomotion  npx      -y demomotion  DEMOMOTION_ALLOWED_HOSTS=*****, DEMOMOTION_BROWSER_CHANNEL=*****  -    enabled  Unsupported
```

Note the limit of that proof: `enabled` is what the config says, not a
connection. Codex masks env values in both `list` and `get`; that is Codex being
careful with secrets, not a lost variable.

What it writes to `~/.codex/config.toml` — **read**, the real section, so you can
also write it by hand:

```toml
[mcp_servers.demomotion]
command = "npx"
args = ["-y", "demomotion"]

[mcp_servers.demomotion.env]
DEMOMOTION_ALLOWED_HOSTS = "localhost,127.0.0.1"
DEMOMOTION_BROWSER_CHANNEL = "chrome"
```

Remove with `codex mcp remove demomotion`.

### Gemini CLI — **run**

`gemini mcp add --help`: `Usage: gemini mcp add [options] <name> <commandOrUrl>
[args...]`, `-s, --scope  Configuration scope (user or project) … [default:
"project"]`, `-e, --env  Set environment variables (e.g. -e KEY=value)`.

```bash
gemini mcp add -s user demomotion \
  -e DEMOMOTION_BROWSER_CHANNEL=chrome \
  -e DEMOMOTION_ALLOWED_HOSTS=localhost,127.0.0.1 \
  npx -y demomotion
```

Real output: `MCP server "demomotion" added to user settings. (stdio)`

Note there is **no `--` separator** here, unlike Claude Code and Codex: the
command is a positional argument followed by its args.

It writes this into `~/.gemini/settings.json` — **read**, verbatim:

```json
{
  "mcpServers": {
    "demomotion": {
      "command": "npx",
      "args": ["-y", "demomotion"],
      "env": {
        "DEMOMOTION_BROWSER_CHANNEL": "chrome",
        "DEMOMOTION_ALLOWED_HOSTS": "localhost,127.0.0.1"
      }
    }
  }
}
```

`gemini mcp list` shows it, and `gemini mcp remove -s user demomotion` takes it
away (the `-s` matters: `remove` defaults to `project` scope and will report
`not found in project settings` if you added it with `-s user`).

**A caveat, measured.** On the verification host `gemini mcp list` reported
`✗ demomotion: npx -y demomotion (stdio) - Disconnected`. Adding
`@playwright/mcp` as a control produced the same `Disconnected` — so that status
is about the Gemini CLI's health probe on this host, **not** about DemoMotion. A
direct JSON-RPC handshake to `npx -y demomotion` succeeds and returns the full
tool list. Confirm inside a Gemini session (the tools appear) rather than
trusting `mcp list`'s status column.

### Cursor — **read**

No `cursor mcp` CLI subcommand exists (checked `cursor --help` on Cursor
3.12.30), so this one is edited by hand or through Settings → MCP.

- Global: `~/.cursor/mcp.json`
- Per project: `.cursor/mcp.json` in the repo root

The real shape, matching the file on the verification host:

```json
{
  "mcpServers": {
    "demomotion": {
      "command": "npx",
      "args": ["-y", "demomotion"],
      "env": {
        "DEMOMOTION_BROWSER_CHANNEL": "chrome",
        "DEMOMOTION_ALLOWED_HOSTS": "localhost,127.0.0.1"
      }
    }
  }
}
```

**Confirm:** Cursor Settings → MCP lists the server with a green dot and its
tools underneath. Restart Cursor after editing the file.

### Claude Desktop — **read**

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

The file on the verification host had no `mcpServers` block at all — only a
`preferences` object. That is the normal state before the first server is added:
add `mcpServers` as a **new top-level key, a sibling of whatever is already
there**, and leave the rest untouched.

```json
{
  "mcpServers": {
    "demomotion": {
      "command": "npx",
      "args": ["-y", "demomotion"],
      "env": {
        "DEMOMOTION_BROWSER_CHANNEL": "chrome",
        "DEMOMOTION_ALLOWED_HOSTS": "localhost,127.0.0.1"
      }
    }
  }
}
```

**Confirm:** quit Claude Desktop completely and reopen it, then open the
tools/connectors control in the composer — `demomotion` appears with its tool
list. If you also use Claude Code, `claude mcp add-from-claude-desktop` imports
servers the other way (Mac and WSL only).

### Antigravity — **read**

Antigravity keeps MCP servers in its own `mcp_config.json`, not in the VS
Code-style `settings.json`. On the verification host the real files were:

- `~/.gemini/antigravity/mcp_config.json` (Antigravity)
- `~/.gemini/antigravity-ide/mcp_config.json` (Antigravity IDE 1.107.0)

The key is `mcpServers`, and the entries have the same `command` / `args` /
`env` shape as everywhere else:

```json
{
  "mcpServers": {
    "demomotion": {
      "command": "npx",
      "args": ["-y", "demomotion"],
      "env": {
        "DEMOMOTION_BROWSER_CHANNEL": "chrome",
        "DEMOMOTION_ALLOWED_HOSTS": "localhost,127.0.0.1"
      }
    }
  }
}
```

Limit of this proof: the paths and the key were read from the existing
`mcp_config.json` files and corroborated against the string
`mcpConfigFilePathSegments:["mcp_config.json"]` in the installed application
bundle. Antigravity has no CLI to list servers with, so **this was not confirmed
by execution** — confirm in the app's MCP settings panel after editing.

### VS Code / GitHub Copilot agent mode — **read**

VS Code is the one client whose top-level key is **`servers`**, not
`mcpServers`, and whose entries carry an explicit `"type"`. Read out of the
installed VS Code 1.131.0 bundle: the MCP JSON schema declares
`servers:{examples:[…],additionalProperties:{…}}`, the code defaults its key with
`n.serversKey ?? "servers"`, and the workspace file it watches is
`.vscode/mcp.json`.

- Per workspace: `.vscode/mcp.json`
- Per user: `~/Library/Application Support/Code/User/mcp.json` (macOS),
  `%APPDATA%\Code\User\mcp.json` (Windows),
  `~/.config/Code/User/mcp.json` (Linux) — or run the
  **MCP: Open User Configuration** command, which opens the right file for you.

```json
{
  "servers": {
    "demomotion": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "demomotion"],
      "env": {
        "DEMOMOTION_BROWSER_CHANNEL": "chrome",
        "DEMOMOTION_ALLOWED_HOSTS": "localhost,127.0.0.1"
      }
    }
  }
}
```

**Confirm:** VS Code shows a "Start"/"Running" code lens above each entry in
`mcp.json`; in Chat, switch to **Agent** mode and open the tools picker — the
`demomotion` tools are listed there. The **MCP: List Servers** command shows the
same thing. Not confirmed by execution for this page: no `mcp.json` existed on
the verification host and the check needs the GUI.

### Windsurf — **read**

Windsurf 1.105.0's own strings name its file: `Windsurf configurations
(~/.codeium/windsurf/mcp_config.json)`, and its bundle carries
`mcpConfigFilePathSegments:["mcp_config.json"]`. The key is `mcpServers`.

```json
{
  "mcpServers": {
    "demomotion": {
      "command": "npx",
      "args": ["-y", "demomotion"],
      "env": {
        "DEMOMOTION_BROWSER_CHANNEL": "chrome",
        "DEMOMOTION_ALLOWED_HOSTS": "localhost,127.0.0.1"
      }
    }
  }
}
```

**Confirm:** Cascade panel → the plugins/MCP icon → **Refresh**, and
`demomotion` appears with its tools. Not confirmed by execution: the file did
not exist on the verification host (Windsurf was installed but had never been
given an MCP server) and Windsurf has no CLI to list with.

### Gemini Code Assist in an IDE — **read, partially**

Gemini Code Assist agent mode reads the same `mcpServers` block as the Gemini
CLI, from `.gemini/settings.json` in the workspace or `~/.gemini/settings.json`
for the user. The `mcpServers` key and the entry shape in that file were
verified by execution through `gemini mcp add` (above); the **IDE extension
reading it** was not — no Gemini Code Assist extension was installed on the
verification host. Use the Gemini CLI snippet, then confirm in the IDE's agent
tool list.

### Cline — **unverified**

Cline stores servers in `cline_mcp_settings.json` inside its VS Code extension's
global storage, under an `mcpServers` key with the usual `command`/`args`/`env`
entries. Nobody ran this: Cline was not installed on the verification host.
Reach the file from Cline's own UI — **MCP Servers → Configure MCP Servers** —
rather than typing the path, since the storage path contains the extension id
and changes between versions.

```json
{
  "mcpServers": {
    "demomotion": {
      "command": "npx",
      "args": ["-y", "demomotion"],
      "env": {
        "DEMOMOTION_BROWSER_CHANNEL": "chrome",
        "DEMOMOTION_ALLOWED_HOSTS": "localhost,127.0.0.1"
      }
    }
  }
}
```

### Zed — **not documented here**

Zed supports MCP ("context servers"), but the key and entry shape in
`settings.json` have changed across Zed releases and Zed was not installed on
the verification host. Rather than print a snippet that might be a version
behind: open Zed's **Agent Panel → Settings → Add Custom Server**, which writes
the correct shape for your build, and give it `npx` with the args `-y
demomotion` and the two environment variables from the top of this page.

### Any other MCP client — **run** (this is the generic stdio contract)

DemoMotion is a plain stdio MCP server. Whatever the client's file looks like,
what it has to launch is:

```
command: npx
args:    ["-y", "demomotion"]
env:     DEMOMOTION_BROWSER_CHANNEL=chrome
         DEMOMOTION_ALLOWED_HOSTS=localhost,127.0.0.1
```

You can prove the server works on your machine without any client at all, by
speaking JSON-RPC to it — stdout is the protocol, so send one JSON object per
line:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  | npx -y demomotion
```

Real answer (**run**):

```json
{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"demomotion","version":"0.3.0","description":"Agent-first browser capture, automated timeline generation and HyperFrames rendering."}},"jsonrpc":"2.0","id":1}
```

If that line comes back, the server is fine and any "not connected" is the
client's side. `2024-11-05` is accepted too, for older clients.

---

## 3. Your first video, with nothing to set up

The repo ships the app to record. It is **Saltmarsh**, a fictional invoicing
product: zero external requests, zero dependencies, `data-testid` on everything.

**Step 1 — serve it.** From the repo root:

```bash
pnpm showcase
```

```
fixture showcase-app on http://127.0.0.1:4322
```

Port 4322 is fixed (override with `SHOWCASE_PORT`), chosen so it never collides
with the 4321 of `fixtures/target-app`. Routes: `/` is the landing page,
`/signup` is the account flow.

**Step 2 — ask your agent for the video.** One tool call. Paste this to the
agent, or let it write the steps itself:

```json
{ "tool": "demo_create", "arguments": {
  "url": "http://127.0.0.1:4322/signup",
  "title": "Saltmarsh signup",
  "pacing": "product-demo",
  "steps": [
    { "action": "fill",  "selector": "[data-testid=\"signup-name-input\"]",     "value": "Inês Corvelo",   "label": "Your name opens the workspace" },
    { "action": "fill",  "selector": "[data-testid=\"signup-email-input\"]",    "value": "ines@studio.com", "label": "One e-mail, no verification step" },
    { "action": "fill",  "selector": "[data-testid=\"signup-password-input\"]", "value": "Marsh!2026reed",  "label": "The strength meter answers as you type" },
    { "action": "click", "selector": "[data-testid=\"signup-terms-checkbox\"]", "label": "Agree to the terms" },
    { "action": "wait",  "ms": 600 },
    { "action": "click", "selector": "[data-testid=\"signup-submit\"]",         "label": "The workspace is ready" },
    { "action": "wait",  "ms": 1500 }
  ] } }
```

The real result (**run**, `demomotion@0.3.0` from npm, `headless: true`,
`DEMOMOTION_BROWSER_CHANNEL=chrome`):

```json
{
  "video": "/Users/you/.demomotion/sessions/3e11f91c-ca89-4c91-9b60-cdbd2586a8d4/final.mp4",
  "project": "/Users/you/.demomotion/sessions/3e11f91c-ca89-4c91-9b60-cdbd2586a8d4/project.json",
  "capture": "/Users/you/.demomotion/sessions/3e11f91c-ca89-4c91-9b60-cdbd2586a8d4/capture.json",
  "durationMs": 11159,
  "blockedRequests": [],
  "sessionId": "3e11f91c-ca89-4c91-9b60-cdbd2586a8d4",
  "pacing": "product-demo"
}
```

Wall clock for the whole call, warm npm cache: **59.5 s** — of which the render
was 37.3 s for 335 frames.

**Step 3 — check the file.** `ffprobe` on the `video` path returned:

```
  Duration: 00:00:11.17, start: 0.000000, bitrate: 1452 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 1450 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
```

2,026,824 bytes. H.264 High, `yuv420p`, 1920×1080, a constant 30 fps, 335
frames — that combination plays in a browser, in Slack, and in QuickTime with no
transcode.

A note on the two `wait` steps: a label whose next labelled action lands on the
same frame gets no caption line, so put a `wait` between two labelled actions
that would otherwise coincide. Everything else — the wait after the opening
navigation, the waits between fields, the hold on the final result — the pacing
preset supplies.

---

## 4. The three pacing presets

Pacing is the first thing a viewer notices, and it is baked into the **capture**:
typing speed and wait lengths cannot be added in the edit. Pick before recording.

| Preset | Length | For |
|---|---|---|
| **Product demo** | ~25 s | Launch video, README hero, sales. Brisk but followable. The default recommendation. |
| **Tutorial** | ~40 s | Onboarding, support, docs — the viewer will REPRODUCE the steps. |
| **Social / ad** | ~15 s | Autoplay without sound, in a **vertical** feed. Only the climax survives. |

The numbers, rendered from `PACING_PRESETS` in
`apps/mcp-server/src/pacing.ts` (a test fails if this table and that file ever
disagree):

| Knob | Product demo | Tutorial | Social |
|---|---|---|---|
| `output` frame on `project_update` | omit (the capture's own frame) | omit (the capture's own frame) | `{"width": 1080, "height": 1920}` — a 16:9 file fits no feed |
| `typeDelayMs` on `browser_fill` | 40 | 55 | 30, and only on the first field |
| `browser_wait` after a navigation | 1200 ms | 2000 ms | 700 ms |
| `browser_wait` between fields | 900 ms | 1500 ms | 300 ms |
| Hold on the final result | 2500 ms | 3500 ms | 1500 ms |
| Reading pause on a new screen | 2000 ms | 3000 ms | 900 ms |
| Caption on screen | 2200 ms | 3000 ms | 1600 ms |
| `cutTransitionMs` | 180 | 220 | 120 |
| Speed ramps on filler | none | none | `speed: 2`–`2.5` on typing and loads |

`demo_create` applies the rows that name a tool by itself. Two rows stay yours,
because they are decisions about *where*: the **reading pause on a new screen**
is a `wait` step you place, and the **speed ramps** are an `editList` you send
afterwards with `project_update`.

---

## 5. Vertical / social output

Two knobs, same result:

```json
{ "tool": "demo_create", "arguments": { "url": "…", "pacing": "social", "steps": [ … ] } }
```

`social` publishes **1080×1920 by default** — vertical is a property of the
preset, not something the caller has to remember. To get a vertical cut under a
different pacing, name the frame explicitly:

```json
{ "output": { "width": 1080, "height": 1920 } }
```

A 16:9 capture rendered at 9:16 is a **reframe**, not a crop-and-hope: the camera
crops a 9:16 rectangle out of the capture, keeps it centred on whatever is being
clicked or filled, and drifts smoothly between interactions. What it cannot do is
show two things far apart at once — a dashboard whose point is the whole layout,
or a flow that jumps between a left sidebar and a right panel, comes out as a
camera swinging back and forth. Record vertical for those (`session_start` with
`width: 1080, height: 1920`, which gives you the app's real mobile layout), or
keep them 16:9.

---

## 6. Editing without recording again

`project.json` is the source of truth for every creative decision. Change it,
re-render, done — no second capture. Taking the exact project from section 3:

```json
{ "tool": "project_update", "arguments": {
  "projectPath": "/Users/you/.demomotion/sessions/3e11f91c-…/project.json",
  "title": "Saltmarsh — vertical cut",
  "output": { "width": 1080, "height": 1920 },
  "style": { "cutTransitionMs": 120, "captionScale": 1.2 }
} }
```

then

```json
{ "tool": "render_video", "arguments": {
  "projectPath": "/Users/you/.demomotion/sessions/3e11f91c-…/project.json",
  "outputPath": "/Users/you/.demomotion/sessions/3e11f91c-…/vertical.mp4"
} }
```

**run** — the same capture, re-rendered vertical, `ffprobe` on the result:

```
  Duration: 00:00:11.17, start: 0.000000, bitrate: 1314 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1080x1920 [SAR 1:1 DAR 9:16], 1312 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
```

Same duration, same clock, a different frame. No browser was launched.

What else `project_update` takes: `captions` (word-by-word, in source time),
`zooms`, `callouts`, `editList` (cuts and speed ramps as
`{sourceFromMs, sourceToMs, speed}`), and `style` — background, padding, radius,
shadow, the caption colours and scale, and the three transition lengths
(`cutTransitionMs`, `openingFadeMs`, `endingFadeMs`; `0` turns each off).

Cuts are safe by construction: everything you author is anchored in `sourceMs`
and projected onto output time through the `editList`, so cutting a boring
stretch repositions every zoom, caption and callout after it, and anything whose
instant fell inside the cut simply does not appear.

**From the shell**, without an agent (**run**):

```bash
npx -y demomotion render ~/.demomotion/sessions/3e11f91c-…/project.json --out vertical.mp4
```

It prints the output path and exits 0. On the verification host: `real 0m39.726s`
for the 11.2 s clip.

---

## 7. Where the files land

Everything is written under `~/.demomotion/sessions/<sessionId>/`. Override the
root with `DEMOMOTION_HOME` (sessions go to `<DEMOMOTION_HOME>/sessions`). The
server prints the root on startup, and every tool result returns absolute paths.

One session directory after the walkthrough above (**run**):

```
capture.json      3.0 KB   the action timeline + manifest; fill values are redacted
page.mp4        324.7 KB   the raw constant-fps capture
project.json      6.9 KB   the edit, as data — this is what you change
final.mp4         1.9 MB   the rendered video
vertical.mp4      1.8 MB   the re-render from section 6
```

A failed run leaves a session directory too, with whatever capture was assembled
before the failure — that is deliberate, so a step 7 failure does not cost you
steps 1–6.

---

## Next

- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — the failures this project actually produces, with the verbatim message
- [ARCHITECTURE.md](./ARCHITECTURE.md) — the design
- [`skills/demomotion/SKILL.md`](../skills/demomotion/SKILL.md) — the agent workflow: objective, scenes, capture, editing heuristics, validation
- [`.env.example`](../.env.example) — every supported environment variable
- [`SECURITY.md`](../SECURITY.md) — the network policy in full
