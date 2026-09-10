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

Keep capture backends isolated behind stable MCP tools. Raw capture metadata must remain independent from creative Remotion decisions.
