# Troubleshooting

Every entry below is a failure this project actually produces, with the message
as it is really printed. Where a message is quoted it was captured by running
the thing on macOS 13.7.8 with `autodemo@0.3.0` from npm; where it was not, the
entry says so.

Start here: **the server prints one line per problem on stderr at startup**, and
MCP clients put that in a log. Read it before anything else. On Claude Code:
`claude mcp get autodemo` shows status; on VS Code, **MCP: List Servers →
Show Output**; on Claude Desktop, `~/Library/Logs/Claude/` — `mcp.log` for the
client side plus one `mcp-server-<name>.log` per server (that layout was
confirmed on the verification host, which held `mcp.log` and
`mcp-server-Figma.log`).

---

## A host was refused by the allowlist

**This is the most likely first failure**, because the default allowlist is
closed: `localhost, 127.0.0.1, ::1`, every port. Nothing else — not your staging
box, not a CDN the page pulls a font from.

**Symptom** — `demo_create` answers `isError`, with a body like this (real
output, recorded against `http://example.com/` under the default allowlist):

```json
{
  "error": "demo_create failed at the opening navigation (goto http://example.com/): AutoDemo refused http://example.com/: \"example.com:80\" is not in AUTODEMO_ALLOWED_HOSTS (currently localhost, 127.0.0.1, ::1 — the default). To allow it, set AUTODEMO_ALLOWED_HOSTS to include \"example.com:80\" and start a new session.",
  "stage": "open",
  "step": { "action": "goto", "url": "http://example.com/" },
  "cause": "AutoDemo refused http://example.com/: \"example.com:80\" is not in AUTODEMO_ALLOWED_HOSTS (currently localhost, 127.0.0.1, ::1 — the default). To allow it, set AUTODEMO_ALLOWED_HOSTS to include \"example.com:80\" and start a new session.",
  "sessionId": "74f3976d-…",
  "blockedRequests": [
    { "seq": 1, "url": "http://example.com/", "host": "example.com", "port": 80,
      "kind": "navigation", "reason": "not-listed",
      "message": "AutoDemo refused http://example.com/: …", "atMs": 0 }
  ],
  "cleanup": "session_stop failed (Screencast produced no frames; capture cannot be assembled.); the browser was destroyed and no capture was written"
}
```

A subtler shape: the navigation succeeds, the video renders, and **parts of the
page are missing** — a font, a logo, an analytics widget. Check
`blockedRequests` in `session_status` or in the `demo_create` result. A
non-empty list means the page reached for something off the allowlist. That
list is the feature working, not a bug.

**Cause.** `AUTODEMO_ALLOWED_HOSTS` is a strict allowlist consulted for the
first navigation, every redirect, link, `fetch`/XHR, iframe and WebSocket. Unset
or empty means the default. It is deliberately a *list*, not a pattern.

**Fix.** Add the host to the variable in your client's config — and **restart
the client**, because the policy resolves and pins every listed name once, when
the session starts.

```
AUTODEMO_ALLOWED_HOSTS=localhost,127.0.0.1,::1,staging.example.com,203.0.113.7
```

Rules that trip people up, all enforced by the policy. The wildcard and scheme
rules below are quoted from real runs; the address-pinning and port rules were
read out of `apps/mcp-server/src/network-policy.ts` and not separately
exercised for this page:

- **A hostname entry also needs the addresses it resolves to.** The decision is
  made over addresses, so `staging.example.com` alone is refused with
  `resolves-outside-allowlist` — you must also list `203.0.113.7`. That is what
  makes a name entry safe against DNS rebinding.
- **No wildcards.** A wildcard names an open set that cannot be resolved and
  pinned when the session starts, so it is refused. The whole allowlist is
  parsed at `session_start`, not at server startup, so a bad entry surfaces
  there — real output for `AUTODEMO_ALLOWED_HOSTS=.example.com`:

  ```
  AUTODEMO_ALLOWED_HOSTS entry ".example.com" is not valid: wildcards are not supported; list each hostname. Entries are "host" or "host:port" (IPv6 with a port as "[::1]:port"), separated by commas.
  ```

- **`host:port` pins one port; a bare `host` allows every port.** IPv6 with a
  port needs brackets (`[::1]:5173`); bare `::1` does not.
- **`http:` and `https:` only.** Anything else is refused before a browser is
  launched. Real output of `browser_goto` with a `file:` URL:

  ```
  AutoDemo refused file:///etc/hosts: only http: and https: URLs can be opened (got file:).
  ```
- **`not-pinned`** means the name resolves inside the allowlist *now* but did
  not when the browser was launched. Start a new session.

`session_status` reports the active allowlist, so you can see what the running
server actually has rather than what you think you set.

---

## `ERROR: Playwright does not support chromium on mac13`

**Symptom** — real output of `npx playwright@1.63.0 install chromium` on macOS
13:

```
Failed to install browsers
Error: ERROR: Playwright does not support chromium on mac13
```

and, at server startup, this warning (real):

```
autodemo: warning: no usable capture browser: Playwright's bundled Chromium is not installed (expected at /Users/you/Library/Caches/ms-playwright/chromium-1243/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing); run "npx playwright@1.63.0 install chromium" to install Playwright's Chromium, or set AUTODEMO_BROWSER_CHANNEL=chrome to drive an installed Google Chrome
```

**Cause.** Playwright ships no bundled Chromium build for macOS 13. The install
command cannot succeed there; it is not a network problem and retrying will not
help.

**Fix.** Drive a browser you already have:

```json
"env": { "AUTODEMO_BROWSER_CHANNEL": "chrome" }
```

`chrome` and `msedge` are the two channels AutoDemo looks for on macOS, at
`/Applications/Google Chrome.app/…` and `/Applications/Microsoft Edge.app/…`.
`AUTODEMO_BROWSER_EXECUTABLE=/path/to/binary` points at one specific build and
wins over both the channel and the bundled build.

The warning tells you when the channel itself is missing, and where it looked:

```
no usable capture browser: AUTODEMO_BROWSER_CHANNEL is set but browser channel "chrome" was not found (looked in /Applications/Google Chrome.app/Contents/MacOS/Google Chrome); install that browser, run "npx playwright@1.63.0 install chromium" …
```

---

## `ffmpeg is not installed or not on PATH`

**Symptom** — at startup (real output, with `ffmpeg` removed from `PATH`):

```
autodemo: warning: ffmpeg and ffprobe not found on PATH: session_stop will fail when it assembles the capture; install ffmpeg (macOS: brew install ffmpeg; Debian/Ubuntu: apt-get install ffmpeg; Windows: winget install ffmpeg) and restart the server
```

and if you push on past the warning, at `session_stop`:

```
ffmpeg is not installed or not on PATH; AutoDemo needs ffmpeg and ffprobe to assemble the capture at session_stop. Install ffmpeg (macOS: brew install ffmpeg; Debian/Ubuntu: apt-get install ffmpeg; Windows: winget install ffmpeg) and restart the server.
```

**Cause.** `ffmpeg` is not the renderer — it is what turns the captured frame
sequence into the constant-fps source video, and that happens at
**`session_stop`**, not at `render_video`. So the failure lands after the
recording is already done. Both `ffmpeg` and `ffprobe` are required; some
minimal packages ship only one.

**Fix.** Install it, then **restart the MCP client**, not just the server: the
client spawns the server, so the server inherits the client's `PATH` from when
the client itself was launched. This is the usual reason "I installed ffmpeg and
it still says it's missing" — a GUI client (Claude Desktop, Cursor, VS Code)
launched from Finder or Spotlight has a much shorter `PATH` than your shell. If
restarting does not fix it, put the absolute directory into the server's `env`,
or launch the client from a terminal.

---

## The client shows no tools, or logs a JSON parse error

**Symptom.** The client lists the server but no tools, or the log contains
"Unexpected token", "Invalid JSON", "failed to parse message", or the server
shows as failed immediately after starting.

**Cause: something other than JSON-RPC was written to stdout.** For a stdio MCP
server, stdout *is* the protocol. AutoDemo keeps it clean — every
human-readable line, including the preflight warnings, goes to stderr — but a
wrapper in front of it does not.

**Never wrap the server in a package-manager script.** Proof (**run**), with
stderr discarded so only stdout is left:

```
$ pnpm run fixture 2>/dev/null | head -3

> autodemo-mcp@0.3.0 fixture /Users/you/autodemo
> node fixtures/target-app/server.mjs
```

Those three lines are on **stdout**. Put `pnpm run …`, `npm run …` or `yarn …`
in a `command` and the client's first read is a blank line and a `>` — not JSON.

**Fix.** Give the client the executable directly:

```json
{ "command": "npx", "args": ["-y", "autodemo"] }
```

Other stdout polluters, same effect: a `console.log` in a Node wrapper script, a
shell profile that prints a banner or a version-manager notice when a
non-interactive shell starts, a `command` that is a shell one-liner with `echo`
in it.

**To tell server from client**, speak to the server yourself:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  | npx -y autodemo
```

A healthy server answers on one line (**run**):

```json
{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"autodemo","version":"0.3.0",…}},"jsonrpc":"2.0","id":1}
```

If that works, the fault is in the client's config, not in AutoDemo. Also
worth knowing: a client's "Disconnected"/"not connected" indicator can be wrong.
On the verification host, `gemini mcp list` reported `Disconnected` for
AutoDemo **and** for `@playwright/mcp` used as a control, while both answered
the handshake above. Trust the handshake over the status column.

---

## The video looks rushed, or too slow

**Typing is on by default, at 40 ms per character.** A field that goes from
empty to complete in one frame reads as a machine; typing reads as a person, and
form demos live on that. Leave the default for anything the viewer is meant to
watch being filled — a name, an e-mail, a short query. Pass `typeDelayMs: 0` for
values nobody wants to sit through: a UUID, a long token, an opaque id.

Typing costs capture time: roughly `value.length × typeDelayMs`, so a 30-char
field is ~1.2 s on its own. Count it in the scene, and shorten the wait after the
fill — the typing already *is* the pause.

**Rushed usually means the wrong preset.** Product demo (~25 s), Tutorial
(~40 s), Social (~15 s) are three different *recordings*, not three edits of one.
The knob table is in [GETTING-STARTED §4](./GETTING-STARTED.md#4-the-three-pacing-presets).

**Slowing down happens in the CAPTURE, never in the edit.** You *can* set
`speed: 0.6` on an `editList` segment and it will render — but slow motion on a
user interface reads as a rendering bug, not as rhythm: the cursor floats, text
crawls. Record at the pace you want to watch. Speed ramps *above* 1 are fine and
are what the social preset uses (`speed: 2`–`2.5` on typing and loads).

**If it is only slightly off**, you do not need a new recording for anything the
edit owns — cuts, zooms, captions, callouts, the output frame, the transition
lengths. Change `project.json` with `project_update` and re-render. Only typing
speed and wait lengths are baked in.

---

## A `demo_create` step failed half-way

**Symptom** — `isError` with a body naming the step. Real output for a selector
that matches nothing:

```json
{
  "error": "demo_create failed at step 1 (click \"[data-testid=\\\"does-not-exist\\\"]\"): locator.boundingBox: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator('[data-testid=\"does-not-exist\"]').first()\n",
  "stage": "step",
  "step": { "index": 1, "action": "click", "selector": "[data-testid=\"does-not-exist\"]", "label": "Nope" },
  "cause": "locator.boundingBox: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator('[data-testid=\"does-not-exist\"]').first()\n",
  "sessionId": "e6a8e442-…",
  "blockedRequests": [],
  "capture": "/Users/you/.autodemo/sessions/e6a8e442-…/capture.json"
}
```

Read it as: `stage` (`open` | `step` | `stop` | `build` | `update` | `render`),
`step` with its **zero-based index**, `cause` with the underlying message, and
`capture` — the capture of everything recorded *before* the failure. A `fill`'s
value is never echoed back.

**Two guarantees worth knowing**, both visible above: the session is always
stopped, so a failed run leaves **no browser and no live session behind**; and
the partial capture is kept, so step 7 failing does not cost you steps 1–6.

**Fix, in order:**

1. **Find the real selector** instead of guessing. Open a granular session
   (`session_start` → `browser_goto`) and call `browser_inspect` — it returns an
   inventory of interactive elements with stable selector candidates. Prefer
   `[data-testid=…]`, then a role plus accessible name. Never an nth-child chain.
2. **If the element exists but is not there yet**, the 30 s timeout means it
   never became visible. Put a `wait` step before it, or wait on the thing that
   actually gates it. Beware elements that start with the `hidden` attribute:
   wait for *visibility*, not for presence in the DOM.
3. **If the cause is a refused navigation**, it is the allowlist — see the first
   entry on this page. `cause` carries the policy's own message in that case.
4. **Resume instead of restarting.** The granular tools are the same pipeline one
   call at a time: `project_build` on the returned `capture`, then
   `project_update` and `render_video`, gets a video out of what was recorded.

---

## Caption words disappear after a cut

**Symptom.** A caption starts, and the words after a certain point never
highlight or never appear.

**Cause.** A cut placed *inside* a caption drops the words after the cut. This is
the time model being consistent, not a bug: every caption word is anchored to
the `sourceMs` at which it was spoken, and anything whose source instant fell
inside a cut does not appear in the output. The same rule is what makes cutting
safe for zooms and callouts.

**Fix.** Place cuts **between** captions. Read the caption boundaries out of
`project.json` — each entry has `fromMs`/`toMs` and a `words` array with a
`fromMs`/`toMs` per word — and set each `editList` segment's `sourceFromMs` and
`sourceToMs` on a gap between two captions, not inside one.

Related: a crossfade shows about 180 ms of adjacent cut material under a partly
transparent clip. That is what an NLE handle is, and it is the default
(`cutTransitionMs: 180` under the product-demo preset). If a cut must be exact —
because the frame either side is meaningfully different — set
`"style": { "cutTransitionMs": 0 }` for hard cuts.

---

## The first run is slow, and downloads about 400 MB

**Not a fault.** The first `npx -y autodemo` pulls the package and its
renderer. The bulk is HyperFrames' `onnxruntime-node`, which is a native ML
runtime and is large by nature. It is a one-time cost per npm cache.

After that, startup is about a second (**run**: `npx -y autodemo --version` →
`real 0m1.058s`).

Some clients time out on the *first* connection for this reason and show the
server as failed. Warm the cache from a terminal before wiring the client up:

```bash
npx -y autodemo --version
```

If you would rather not re-resolve through `npx` at all, install it once
(`npm i -g autodemo`) and give the client `"command": "autodemo"` with
`"args": []`.

Rendering itself is not instant either: on the verification host, an 11.2 s clip
at 1920×1080 took **37.3 s to render** (335 frames), and the whole
`demo_create` call — capture included — took 59.5 s.

---

## Nothing above matches

- `session_status` reports the live session's duration, URL, action count, the
  **active host allowlist** and `blockedRequests`. Check what the running server
  actually has before changing config.
- `browser_screenshot` during a granular session shows what the browser is
  really looking at. Do not push on blindly past a navigation error, an
  unexpected dialog or a missing element.
- Everything is on disk under `~/.autodemo/sessions/<sessionId>/`
  (`AUTODEMO_HOME` moves the root): `capture.json`, `page.mp4`,
  `project.json`, `final.mp4`. A failed run leaves its directory behind on
  purpose.
- The same `project.json` renders a byte-identical MP4. If two renders differ,
  the project differs.
- Still stuck: <https://github.com/flavioduque/autodemo/issues>. Include the
  server's stderr lines, the `isError` body, and `project.json` if there is one.
