# Release checklist — v0.2.0

- [x] Independent implementation; no Recordly source copied.
- [x] MCP SDK v2 API checked against the 2026-07-28 stable SDK line.
- [x] Remotion pinned to 4.0.521.
- [x] Playwright pinned to 1.63.0.
- [x] Source-video staging isolates local files from Remotion public assets.
- [x] Interaction values are redacted from capture metadata.
- [x] URL protocol validation and optional hostname allowlist.
- [x] Auto-zoom core has deterministic tests.
- [x] `pnpm typecheck`, `pnpm test` and `pnpm build` pass locally with real dependencies installed (the offline transpile-only validation scripts were removed).
- [x] GitHub Actions workflow performs dependency install, Chromium install (scoped to `@demomotion/mcp-server`), typecheck, tests and build.
- [x] Remotion bundling of `apps/studio` succeeds (`remotion bundle src/index.ts`).
- [ ] An actual Remotion MP4 render must pass before tagging 1.0.0 — not yet executed.

Note on browser provisioning: Playwright 1.63.0 has no bundled Chromium build for
macOS 13, so capture on such hosts requires `DEMOMOTION_BROWSER_CHANNEL=chrome`
(verified by execution: Google Chrome 152 launches and records). CI on
`ubuntu-latest` still uses the bundled Chromium.
