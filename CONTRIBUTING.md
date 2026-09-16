# Contributing

Requirements: Node.js 22+, pnpm 10.

```bash
pnpm install
pnpm --filter autodemo exec playwright install chromium
pnpm typecheck
pnpm test
pnpm build
```

On hosts without a bundled Chromium build for your platform, set
`AUTODEMO_BROWSER_CHANNEL=chrome` to drive a locally installed Google Chrome.

To run the suite against a specific Chromium binary — the `chrome-headless-shell`
CI uses, say, when it is not installed as a channel on your host — set
`AUTODEMO_BROWSER_EXECUTABLE=/path/to/binary`. It wins over the channel and
over the bundled build.

## Slow tests

`pnpm test` runs every fast test plus the browser-driven ones that pin visible
defects (`frames.test.ts`, `typing.test.ts`). Those are deliberately not gated:
a suite that stayed green while the product's eyes were shut is how one of them
shipped. They need a browser; they do not need ffmpeg.

Everything heavier is behind its own gate:

```bash
# render-level tests (compositor pixels). Needs a browser AND ffmpeg.
AUTODEMO_RENDER_TESTS=1 pnpm --filter autodemo test

# capture time-base alignment
AUTODEMO_SLOW=1 pnpm --filter autodemo test

# the MCP protocol end-to-end test: spawns the server and speaks JSON-RPC over
# stdio, driving capture -> build -> edit -> render, twice (~4 min)
AUTODEMO_E2E_TESTS=1 pnpm --filter autodemo test
```

Add `AUTODEMO_BROWSER_CHANNEL=chrome` on a host without bundled Chromium, and
`AUTODEMO_E2E_DEBUG=1` to see the spawned server's stderr.

### The render tests' source clip

The render tests composite a 9.08 s clip that reproduces the fixture target
app's visual contract — the same four corner markers, in the same colours and
sizes, plus its on-screen elapsed-time clock. It is **drawn on first use** by
`apps/mcp-server/test/fixture-media.ts` and cached, with a digest, under the
gitignored `data/test-media/`. Nothing is committed and nothing depends on an
artefact that exists on one machine.

* A cache that is stale, truncated, or of the wrong codec, size, frame rate or
  duration is detected and rebuilt, never reused.
* If ffmpeg (or ffprobe) is missing, the run **fails** naming what to install.
  It does not skip: a suite that quietly opts out on a fresh clone looks green
  while proving nothing.
* Delete `data/test-media/` to force a rebuild.

`fixture-media.test.ts` runs in the default suite and needs neither ffmpeg nor a
browser: it fails if the drawn scene drifts away from `fixtures/target-app`, or
loses a property the render tests measure.

Keep capture backends isolated behind stable MCP tools. Raw capture metadata must remain independent from creative compositor decisions.
