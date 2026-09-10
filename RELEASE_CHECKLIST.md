# Release checklist — v0.2.0

- [x] Independent implementation; no Recordly source copied.
- [x] MCP SDK v2 API checked against the 2026-07-28 stable SDK line.
- [x] Remotion pinned to 4.0.521.
- [x] Playwright pinned to 1.63.0.
- [x] Source-video staging isolates local files from Remotion public assets.
- [x] Interaction values are redacted from capture metadata.
- [x] URL protocol validation and optional hostname allowlist.
- [x] Auto-zoom core has deterministic tests.
- [x] TypeScript/TSX syntax/transpile validation passes locally.
- [x] GitHub Actions workflow performs dependency install, Chromium install, typecheck, tests and build.
- [ ] Full dependency installation and MP4 render must pass in an internet-enabled environment/CI before tagging 1.0.0.

The local execution environment used during development could not resolve registry.npmjs.org, so dependency installation and an actual Remotion MP4 render were not falsely marked as completed.
