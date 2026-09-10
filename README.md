# DemoMotion MCP

**Agent-first product demo videos: operate → record → edit → render.**

DemoMotion exposes a browser-recording and programmable-video pipeline through Model Context Protocol (MCP). An AI coding agent can inspect a web application, interact with it, capture the workflow, generate zoom regions from real UI coordinates, edit a structured project, and render the final MP4 with HyperFrames.

## Why

Traditional workflow:

`human records → human edits → export`

DemoMotion workflow:

`agent understands objective → agent operates product → capture → structured timeline → HyperFrames → final video`

## Stack

- MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.0.0)
- Playwright 1.63.0
- HyperFrames 0.8.33 (compositor)
- Remotion 4.0.521 (legacy composition, kept until the replacement is retired)
- TypeScript
- Zod 4
- React 19

## MCP tools

| Tool | Purpose |
|---|---|
| `session_start` | Start recorded Chromium session |
| `browser_inspect` | Return compact interactive-element inventory |
| `browser_goto` | Navigate |
| `browser_click` | Click and record normalized target coordinates |
| `browser_fill` | Fill fields while redacting values from metadata |
| `browser_scroll` | Scroll and log timeline event |
| `browser_keypress` | Keyboard interaction |
| `browser_wait` | Intentional pacing/UI wait |
| `browser_screenshot` | Diagnostic UI checkpoint |
| `session_status` | Current recording state |
| `session_stop` | Persist raw video + capture manifest |
| `project_build` | Compile capture into an editable DemoMotion project |
| `project_update` | Modify style, zooms, edit list (cuts and speed ramps) and callouts |
| `render_video` | Render final H.264 MP4 |
| `demo_finalize` | Stop + compile + render in one call |

## Repository layout

```text
apps/
  mcp-server/       MCP control plane + Playwright capture + render driver
  studio/           legacy Remotion composition (superseded, not on the render path)
packages/
  compositor/       project.json -> HyperFrames HTML (pure, no I/O)
  core/             deterministic editing heuristics + the sourceMs/outputMs bridge
  schema/           shared project/action schemas
skills/
  demomotion/       agent workflow skill
scripts/            publication helper
docs/               architecture
```

## Install

Requires Node.js 22+ and pnpm 10.

```bash
pnpm install
pnpm --filter @demomotion/mcp-server exec playwright install chromium
pnpm typecheck
pnpm test
pnpm build
```

The Playwright install command must be scoped with `--filter`. Playwright is a
dependency of `apps/mcp-server`, not of the workspace root, so a bare
`pnpm exec playwright ...` at the root can silently fall through to an unrelated
Playwright found on `PATH` and provision the wrong browser cache.

If Playwright has no bundled Chromium build for your platform (for example
macOS 13, where Playwright 1.63.0 requires a Chromium revision with no macOS 13
binary), use a locally installed browser instead:

```bash
DEMOMOTION_BROWSER_CHANNEL=chrome pnpm dev:mcp
```

See [Browser selection](#browser-selection).

## Run

For interactive development:

```bash
pnpm dev:mcp
```

MCP clients must not use `pnpm dev:mcp`: pnpm prints its script banner on
**stdout**, and an MCP stdio transport requires stdout to carry JSON-RPC frames
only. Point the client at the `tsx` entry directly.

Example MCP client entry:

```json
{
  "mcpServers": {
    "demomotion": {
      "command": "/absolute/path/demomotion-mcp/apps/mcp-server/node_modules/.bin/tsx",
      "args": ["/absolute/path/demomotion-mcp/apps/mcp-server/src/index.ts"],
      "cwd": "/absolute/path/demomotion-mcp",
      "env": {
        "DEMOMOTION_ALLOWED_HOSTS": "localhost,127.0.0.1"
      }
    }
  }
}
```

`cwd` must be the repository root: recording sessions are written to
`data/sessions/` relative to the working directory.

## Browser selection

| Variable | Default | Effect |
|---|---|---|
| `DEMOMOTION_BROWSER_CHANNEL` | unset | Unset: use Playwright's bundled Chromium (deterministic, used in CI). Set to a Playwright channel such as `chrome` or `msedge`: drive that locally installed browser instead. |

```bash
DEMOMOTION_BROWSER_CHANNEL=chrome pnpm dev:mcp
```

Use this when the bundled Chromium cannot be provisioned on the host. If a
launch fails without the variable set, the error explains this option.

## Agent skill

Use `skills/demomotion/SKILL.md`. The skill specifies the complete workflow: objective analysis, scene planning, product interaction, capture, project compilation, creative editing, rendering and validation.

## Capture strategy

The v0.2 capture adapter uses Playwright's deterministic video recording so the complete control loop works without requiring a browser extension.

Remotion Canvas Capture is the planned high-resolution web adapter. It can capture web content at higher-than-native resolution; its cursor metadata model also fits DemoMotion's separation between raw capture facts and creative rendering.

## Rendering

`render_video` generates the composition HTML from `project.json` at render time
and hands it to the HyperFrames CLI. `project.json` stays the single source of
truth: nothing travels as a CLI variable, so nested data such as the zoom track
is never reduced to an unvalidated JSON string.

Zooms and callouts are anchored in `sourceMs` — when they happened in the
capture — and projected onto `outputMs` through the edit list. Cutting material
repositions everything after it automatically, and anything whose source instant
was cut simply does not appear.

### Render-level tests

Two checks render real video and take about a minute each, so they are opt-in:

```bash
DEMOMOTION_RENDER_TESTS=1 pnpm --filter @demomotion/mcp-server test
```

They assert the composition holds its final frame instead of going black, and
that the fixture's corner markers come out square. Each one also renders the
corresponding defective authoring and proves the check fires on it.

### Telemetry

HyperFrames sends anonymous render telemetry to HeyGen. DemoMotion renders on
its users' behalf, so it does not phone home for them: the render child process
is started with `HYPERFRAMES_NO_TELEMETRY=1`.

| Variable | Default | Effect |
|---|---|---|
| `HYPERFRAMES_NO_TELEMETRY` | set to `1` by DemoMotion | Opts the render out of HyperFrames telemetry. If you set this variable yourself — to any value, including `0` — DemoMotion keeps your choice and does not override it. |

## Security

Use dedicated demo accounts and seeded demo data. Values sent through `browser_fill` are redacted from `capture.json`, but a target application may still visually display them in the video.

Optional host restriction:

```bash
DEMOMOTION_ALLOWED_HOSTS=localhost,127.0.0.1 pnpm dev:mcp
```

See `.env.example` for all supported variables.

## License

DemoMotion source code: MIT.

HyperFrames, the compositor on the render path, is Apache-2.0.

Remotion is still a dependency of `apps/studio`, which is no longer on the render
path but has not been removed yet. It carries its own licensing terms: verify the
Remotion license applicable to your organization and automated-rendering volume
before commercial deployment, or remove `apps/studio`.
