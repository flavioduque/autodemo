# DemoMotion MCP

**Agent-first product demo videos: operate → record → edit → render.**

DemoMotion exposes a browser-recording and programmable-video pipeline through Model Context Protocol (MCP). An AI coding agent can inspect a web application, interact with it, capture the workflow, generate zoom regions from real UI coordinates, edit a structured project, and render the final MP4 with Remotion.

## Why

Traditional workflow:

`human records → human edits → export`

DemoMotion workflow:

`agent understands objective → agent operates product → capture → structured timeline → Remotion → final video`

## Stack

- MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.0.0)
- Playwright 1.63.0
- Remotion 4.0.521
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
| `project_build` | Compile capture into editable Remotion project |
| `project_update` | Modify style, zooms, trims and callouts |
| `render_video` | Render final H.264 MP4 |
| `demo_finalize` | Stop + compile + render in one call |

## Repository layout

```text
apps/
  mcp-server/       MCP control plane + Playwright capture
  studio/           Remotion composition/rendering
packages/
  core/             deterministic editing heuristics
  schema/           shared project/action schemas
skills/
  demomotion/       agent workflow skill
scripts/            validation/publication helpers
docs/               architecture
```

## Install

Requires Node.js 22+ and pnpm 10.

```bash
pnpm install
pnpm exec playwright install chromium
pnpm typecheck
pnpm test
pnpm build
```

## Run

```bash
pnpm dev:mcp
```

Example MCP client entry:

```json
{
  "mcpServers": {
    "demomotion": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/demomotion-mcp", "dev:mcp"]
    }
  }
}
```

## Agent skill

Use `skills/demomotion/SKILL.md`. The skill specifies the complete workflow: objective analysis, scene planning, product interaction, capture, project compilation, creative editing, rendering and validation.

## Capture strategy

The v0.2 capture adapter uses Playwright's deterministic video recording so the complete control loop works without requiring a browser extension.

Remotion Canvas Capture is the planned high-resolution web adapter. It can capture web content at higher-than-native resolution; its cursor metadata model also fits DemoMotion's separation between raw capture facts and creative rendering.

## Security

Use dedicated demo accounts and seeded demo data. Values sent through `browser_fill` are redacted from `capture.json`, but a target application may still visually display them in the video.

Optional host restriction:

```bash
DEMOMOTION_ALLOWED_HOSTS=localhost,127.0.0.1 pnpm dev:mcp
```

## License

DemoMotion source code: MIT.

Remotion is a dependency with its own licensing terms. Verify the Remotion license applicable to your organization and automated-rendering volume before commercial deployment.
