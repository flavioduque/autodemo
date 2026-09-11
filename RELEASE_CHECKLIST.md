# Release checklist — v0.2.0

- [x] Independent implementation; no Recordly source copied.
- [x] MCP SDK v2 API checked against the 2026-07-28 stable SDK line.
- [x] HyperFrames (Apache-2.0) is the only compositor; the superseded Remotion composition (`apps/studio`) and its dependencies were removed from the workspace.
- [x] Playwright pinned to 1.63.0.
- [x] Source-video staging isolates local files from the composition: the render driver stages the capture next to the generated HTML in a per-render temp directory.
- [x] Interaction values are redacted from capture metadata.
- [x] URL protocol validation and optional hostname allowlist.
- [x] Auto-zoom core has deterministic tests.
- [x] `pnpm typecheck`, `pnpm test` and `pnpm build` pass locally with real dependencies installed (the offline transpile-only validation scripts were removed).
- [x] GitHub Actions workflow performs dependency install, Chromium install (scoped to `@demomotion/mcp-server`), typecheck, tests and build.
- [x] `@demomotion/compositor` output is pinned against a golden HyperFrames composition (`packages/compositor/test/golden-native.test.ts`); the same HTML is what the render tests feed to `hyperframes render`.
- [x] Real H.264 MP4 renders pass through the HyperFrames path: `DEMOMOTION_RENDER_TESTS=1 pnpm --filter @demomotion/mcp-server test` renders and measures the output (tail hold, aspect, captions, crossfade, background bookends, vertical publish). Verified by execution on macOS 13 with Chrome; also run by the `render` job in CI on push to `main`.

Note on browser provisioning: Playwright 1.63.0 has no bundled Chromium build for
macOS 13, so capture on such hosts requires `DEMOMOTION_BROWSER_CHANNEL=chrome`
(verified by execution: Google Chrome 152 launches and records). CI on
`ubuntu-latest` still uses the bundled Chromium.
