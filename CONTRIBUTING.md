# Contributing

Requirements: Node.js 22+, pnpm 10.

```bash
pnpm install
pnpm exec playwright install chromium
pnpm typecheck
pnpm test
pnpm build
```

Keep capture backends isolated behind stable MCP tools. Raw capture metadata must remain independent from creative Remotion decisions.
