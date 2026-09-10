# Contributing

Requirements: Node.js 22+, pnpm 10.

```bash
pnpm install
pnpm --filter @demomotion/mcp-server exec playwright install chromium
pnpm typecheck
pnpm test
pnpm build
```

On hosts without a bundled Chromium build for your platform, set
`DEMOMOTION_BROWSER_CHANNEL=chrome` to drive a locally installed Google Chrome.

## Slow tests

`pnpm test` skips everything that launches a browser or ffmpeg. Each slow layer
has its own gate:

```bash
# render-level tests (compositor pixels)
DEMOMOTION_RENDER_TESTS=1 pnpm --filter @demomotion/mcp-server test

# capture time-base alignment
DEMOMOTION_SLOW=1 pnpm --filter @demomotion/mcp-server test

# the MCP protocol end-to-end test: spawns the server and speaks JSON-RPC over
# stdio, driving capture -> build -> edit -> render, twice (~4 min)
DEMOMOTION_E2E_TESTS=1 pnpm --filter @demomotion/mcp-server test
```

Add `DEMOMOTION_BROWSER_CHANNEL=chrome` on a host without bundled Chromium, and
`DEMOMOTION_E2E_DEBUG=1` to see the spawned server's stderr.

Keep capture backends isolated behind stable MCP tools. Raw capture metadata must remain independent from creative compositor decisions.
