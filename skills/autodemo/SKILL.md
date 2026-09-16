---
name: autodemo
description: Autonomously create polished product demo videos by operating a web application through the AutoDemo MCP server — one demo_create call from a URL, an explicit step list and a pacing preset to a finished MP4; or step by step, recording a deterministic capture, compiling an editable project, cutting dead time, writing word-by-word narration, and rendering with the HyperFrames compositor.
---

# AutoDemo Agent Skill

You operate a product, then you edit the recording as data. Nothing is baked into
the pixels: every creative decision lives in `project.json` and can be changed and
re-rendered without recording again.

## The pipeline

**The primary path is one call.** Once you know the URL, the steps and the
pacing (sections 1–3), `demo_create` runs the whole pipeline and answers with
the MP4:

```
demo_create({ url, title, steps: [...], pacing, captions: "auto" })
  = session_start → goto(url) → each step → session_stop
  → project_build → project_update(preset) → render_video
  → { video, project, capture, durationMs, blockedRequests, sessionId, pacing }
```

It takes an **explicit step list** — `click`, `fill`, `scroll`, `keypress`,
`wait`, `goto` — and does no planning of its own. The pacing preset fills in
every number a step does not name (section 2). `captions: "auto"` keeps the
skeleton seeded from your step labels; when the prose needs work, rewrite it
with `project_update` on the returned `project` and re-render with
`render_video` — no second recording.

The granular tools are the same pipeline taken one call at a time:

```
session_start → browser_goto / click / fill / wait → session_stop
             → project_build → (project_update)* → render_video
```

Use them to find selectors (`browser_inspect` on a live session), to debug a
step that failed inside `demo_create` (its error names the step), to retry
from a checkpoint, and for the editing pass and partial re-renders. `demo_finalize`
collapses `session_stop → project_build → render_video` on a live granular
session; like `demo_create` it renders the automatic first pass.

When `demo_create` fails half-way — a selector that matches nothing, a
navigation the network policy refuses, a timeout, a render error — the session
is always stopped (no browser is left behind) and the error body names the
step: `stage`, `step {index, action, selector | url, label}`, `cause`, and the
`capture` recorded up to that point (plus `project` when the build had already
happened). See *Errors* below.

The compositor is **HyperFrames** (HTML + GSAP, rendered to H.264). You never
author it. You author `project.json`.

## Two time bases — learn these before editing

- `sourceMs` — time in the raw capture. Immutable. Everything you author is
  anchored here: zooms, callouts, captions, cursor keyframes, edit segments.
- `outputMs` — time in the final video. Derived from the `editList`.

You never write `outputMs`. Cut a stretch and every zoom, caption and callout
after it is reprojected automatically. Anything whose `sourceMs` fell inside a
cut simply does not appear. This is why cutting is safe.

---

## 1. Fix the objective

Decide before recording: audience, the one capability being shown, target
duration, the critical path through the UI, and which fields must never be on
screen. Do not wander into unrelated product areas.

Frame size is **two** decisions, not one: the frame you RECORD at, and the frame
you PUBLISH at. They no longer have to be the same — `project_update` takes an
`output` frame, and the camera crops a rectangle of that aspect ratio out of the
capture. Decide both here, because only the first one is expensive to change.

**Two ways to get a vertical cut. They are not interchangeable:**

| | Record vertical | Record 16:9, reframe to 9:16 |
|---|---|---|
| How | `session_start` with `width: 1080, height: 1920` | `session_start` at `1920x1080`, then `project_update` with `output: {"width": 1080, "height": 1920}` |
| What the viewer sees | the app's **mobile layout** — the real responsive breakpoint, nothing cropped | the **desktop UI**, cropped to 31.6% of its width |
| Right when | the product has a mobile layout and the demo is about using it on a phone | the product is desktop-first, or the same capture must also ship as a 16:9 video |
| Cost | a second recording if you also want a 16:9 cut | ~68% of the frame is off screen at all times |

Reframing keeps the crop centred on whatever is being clicked or filled and
drifts smoothly between interactions, so a focused flow survives it. What it
cannot do is show two things that are far apart at once: a dashboard whose point
is the whole layout, or a flow that jumps between a left sidebar and a right
panel, comes out as a camera swinging back and forth. Record vertical for those,
or keep them 16:9.

## 2. Ask the user for the pacing — do not guess it

Pacing is the single thing viewers notice first, and it is not inferable from the
objective. A 15-second social clip and a 40-second tutorial of the same flow are
different recordings, not different edits — typing speed and wait lengths are
baked into the capture and cannot be added later.

**Ask before recording.** Offer these three, in the user's language, and say
which you recommend for their stated objective:

| Preset | Length | For |
|---|---|---|
| **Product demo** | ~25 s | Launch video, README hero, sales. Brisk but followable. The default recommendation. |
| **Tutorial** | ~40 s | Onboarding, support, docs — the viewer will REPRODUCE the steps. |
| **Social / ad** | ~15 s | Autoplay without sound, in a **vertical** feed. Only the climax survives. |

Then apply the preset's numbers. These are the knobs, not decoration. The table
is the **shared source**: it is rendered from `PACING_PRESETS` in
`apps/mcp-server/src/pacing.ts`, and a test fails whenever the two differ. Pass
the preset's name as `pacing` to `demo_create` and it applies the rows marked
with a tool name itself — `typeDelayMs` on every fill (social: the first field
only), the wait after a navigation (the opening one, every `goto`, and a click
that changes the URL), the wait between fields, the hold on the final result,
the caption hold, `cutTransitionMs`, and the `output` frame. The reading pause
on a new screen is a `wait` step you place; speed ramps are an `editList` you
send afterwards with `project_update`.

| Knob | Product demo | Tutorial | Social |
|---|---|---|---|
| `output` frame on `project_update` | omit (the capture's own frame) | omit (the capture's own frame) | `{"width": 1080, "height": 1920}` — a 16:9 file fits no feed |
| `typeDelayMs` on `browser_fill` | 40 | 55 | 30, and only on the first field |
| `browser_wait` after a navigation | 1200 ms | 2000 ms | 700 ms |
| `browser_wait` between fields | 900 ms | 1500 ms | 300 ms |
| Hold on the final result | 2500 ms | 3500 ms | 1500 ms |
| Reading pause on a new screen | 2000 ms | 3000 ms | 900 ms |
| Caption on screen | 2200 ms | 3000 ms | 1600 ms |
| `cutTransitionMs` | 180 | 220 | 120 |
| Speed ramps on filler | none | none | `speed: 2`–`2.5` on typing and loads |

If the user does not answer, use **Product demo** and say so — do not stall.

**Slowing down happens in the capture, never in the edit.** You could set
`speed: 0.6` on an `editList` segment, and it will render — but slow-motion on a
user interface reads as a rendering bug, not as rhythm. The cursor floats, text
crawls. Record at the pace you want to watch.

## 3. Plan 3–7 scenes

Each scene: purpose · action · expected visible state · rough duration.
A demo with more than seven scenes is two demos.

## 4. Record

With `demo_create`, recording is the `steps` array — the same actions as the
tools below, one object each, in order:

```json
{"url": "http://localhost:3000/signup", "title": "Saltmarsh signup", "pacing": "product-demo",
 "steps": [
   {"action": "fill",  "selector": "[data-testid=\"signup-name-input\"]", "value": "Inês Corvelo", "label": "Your name opens the workspace"},
   {"action": "fill",  "selector": "[data-testid=\"signup-email-input\"]", "value": "ines@studio.com", "label": "One e-mail, no verification step"},
   {"action": "click", "selector": "[data-testid=\"signup-terms-checkbox\"]", "label": "Agree to the terms"},
   {"action": "wait",  "ms": 600},
   {"action": "click", "selector": "[data-testid=\"signup-submit\"]", "label": "The workspace is ready"},
   {"action": "wait",  "ms": 1200}
 ]}
```

Every rule below applies to those steps exactly as it applies to the tools.
Two things only the step list needs: put a `wait` between two labelled actions
that would otherwise land on the same frame (a label whose successor arrives at
the same instant gets no caption line), and let the preset supply the waits you
would otherwise send by hand — a `wait` you place next to a `fill` or a `goto`
replaces the preset's, it does not add to it.

`session_start` — defaults `1920x1080`, `headless: false` for local production.
Returns `sessionId`; every browser tool needs it.

- `browser_goto` — `http`/`https` only, subject to `AUTODEMO_ALLOWED_HOSTS`
  (default: `localhost, 127.0.0.1, ::1`, every port).
- `browser_click` / `browser_fill` — record normalized target coordinates. These
  drive both the auto-zoom and the synthetic cursor.
- `browser_wait` — 50–30000 ms. Only for a real transition or deliberate pacing.
- `browser_scroll`, `browser_keypress` — same recording rules.
- `browser_inspect` — inventory of interactive elements with stable selector
  candidates. Use it instead of guessing a selector.
- `browser_screenshot`, `session_status` — checkpoints. Do not push on blindly
  after a navigation error, an unexpected dialog or a missing element.

Rules:
- Prefer `[data-testid=...]`, then a role/accessible name. Never an nth-child chain.
- **Always pass `label`.** `project_build` turns every labelled action into a
  caption line already timed. An action with no label produces no caption line.
  Write the label as a line of narration, not as the button's text: `label:
  "One form adds the client"` beats `label: "Save"`.
- Never type a password, token or key. `browser_fill` redacts the value from
  `capture.json`, but the target app still *renders* it. Use seeded demo data.
- **`browser_fill` types the value character by character** (`typeDelayMs`,
  default 40 ms/char). A field that goes from empty to complete in one frame
  reads as a machine; typing reads as a person, and form demos live on that.
  Leave the default for anything the viewer is meant to watch being filled — a
  name, an e-mail, a short search query. Pass `typeDelayMs: 0` for values nobody
  wants to sit through: a UUID, a long token, an opaque id; fill those instantly
  and spend the screen time on the result instead.
- Typing costs capture time: roughly `value.length * typeDelayMs`, so a 30-char
  field is ~1.2 s on its own. Count it in the scene's duration and shorten the
  `browser_wait` after a fill accordingly — the typing already *is* the pause.
- Keep pauses short. Dead time is cheaper to cut than to sit through, but it is
  cheapest not to record.

`session_stop` → writes `capture.json` (constant fps, frame ⇔ time exact) and
returns its path plus `durationMs`. Keep both.

## 5. `project_build`

Compiles `capture.json` into `project.json` and returns the whole project. What
it seeds:

- `editList` — one identity segment `{sourceFromMs: 0, sourceToMs: durationMs,
  speed: 1}`. Nothing is cut yet.
- `zooms` — one window per click/fill that has coordinates. A click gets
  `[atMs-220, atMs+1200]` at scale `1.36`; a fill gets `[atMs-220, atMs+1450]` at
  scale `1.22`. Two windows merge when they start within 120 ms of each other and
  their centres are less than 0.16 apart in normalized coordinates.
- `captions` — a **skeleton**: one line per labelled action, opening at the
  action's instant, holding up to 2200 ms, hard-capped by the next labelled
  action. Words are already split proportionally to token length, floor 90 ms.
- `callouts` — empty.

Treat all of it as a first pass.

## 6. `project_update` — the editing pass

A patch against `project.json`. Omitted fields keep their value. `style` is
**merged** field by field; `output`, `zooms`, `editList`, `callouts` and
`captions` are **replaced wholesale** — send the complete value you want, not a
delta.

### `output` — the frame the video is published at

```json
{"width": 1080, "height": 1920}
```

Send it and the camera reframes: it takes the largest rectangle of **that** aspect
ratio that fits inside the capture and walks it across your interactions. Like
every other field, omitting it in a patch LEAVES IT AS IT IS — to go back to the
capture's own frame, send the capture's own `width`/`height`.

- `width`/`height` in `project.json` stay the **recording's** frame. They are
  what every normalized `x`/`y` in the project is measured against, so nothing
  you authored needs to move when you reframe.
- Reframing is an edit, not a re-record. Render the same capture at `1920x1080`
  and at `1080x1920` and you have both cuts from one session.
- The crop is centred on the action being interacted with, clamped to the edges
  of the capture (an element against the right margin frames flush right, never
  against empty space), and it eases between actions instead of snapping.
- The zoom still applies, **inside** the crop. Keep `scale` low on a reframed
  cut: the crop is already a 3.2x magnification of the width.
- 9:16 is `1080x1920`. 4:5 (feed post) is `1080x1350`. 1:1 is `1080x1080`.

### `editList` — cuts and speed ramps, one model

```json
[{"sourceFromMs": 0,     "sourceToMs": 4200,  "speed": 1},
 {"sourceFromMs": 7800,  "sourceToMs": 15000, "speed": 2}]
```

Segments are kept slices of the capture, in order. **A cut is the gap between two
segments** — there is no separate `trims` field, so a cut that does not change the
render is impossible to express. `speed` is a constant ramp: `2` = double speed,
`0.5` = slow motion. Never `0`.

Output length of a segment is `(sourceToMs - sourceFromMs) / speed`; the video is
the sum of them.

Cutting dead time is a real editing move — **use it**. Typical targets: the wait
after `browser_goto`, the gap while a form is open and nothing is happening, a
slow network round trip (ramp it at `2`–`3` instead of cutting, so the user still
sees the loading state).

Rules:
- **Place cuts BETWEEN captions.** Everything anchored in `sourceMs` follows one
  rule: if its **start instant** is cut, it disappears entirely; if the cut lands
  **inside** it, it is clipped at the cut. For a caption that means the line ends
  mid-sentence and every word after the cut is dropped. Read the caption windows
  first, then pick a cut boundary that lies in a gap between two of them.
- The same rule governs zooms, callouts and the cursor. A zoom whose start was
  cut simply never happens — usually what you want; make sure it is.
- An empty `editList` keeps no material and `render_video` refuses outright.

### `captions` — word-by-word narration

```json
[{"fromMs": 900, "toMs": 3100, "text": "Adding a client is one form."}]
```

`words` is optional: send only `text` and the compiler keeps it as one line
without a highlight; send `words` (`{text, fromMs, toMs}`) and each word is
highlighted as it is spoken. **The skeleton's timings are already correct — your
job is the prose, not the clock.** Rewrite `text` and leave `fromMs`/`toMs` where
`project_build` put them unless you have a reason.

Overlapping lines are truncated automatically (the earlier one ends where the next
begins), so two captions are never on screen at once.

Writing the narration:
- One idea per line. 3–8 words. If a line needs a comma, it is two lines.
- Present tense, active voice. "The client is saved", not "We have now saved…".
- Say the **outcome**, not the mechanic. Never "click the Save button" — the
  cursor and the pulse already show that.
- Do not narrate what is obviously on screen. Narrate what it *means*.
- Roughly two words per second of line. Faster than that and nobody reads it.
- No product-marketing adjectives. This is a demo, not a landing page.

### `zooms`

`{fromMs, toMs, x, y, scale}`, `x`/`y` normalized `0–1`, `scale` `1–3`.

The camera ramps in over `min(250 ms, 30% of the window)` and out over
`min(300 ms, 30%)`. A window under ~800 ms is therefore almost entirely ramp and
reads as a twitch — either widen it or drop it.

- Keep `scale` in `1.15–1.45`. Above ~1.6 the UI stops being legible.
- Do not punch-zoom every click. Zoom for the action that carries the point.
- Leave the result state wide enough to be read.

### `callouts`

`{fromMs, toMs, text, x, y}`, position normalized (default `0.5`, `0.85`). Use
sparingly, and never to repeat what a caption already says.

### `style`

| field | default | range | note |
|---|---|---|---|
| `background` | `#0b1020` | any CSS colour | also the colour the fades resolve to |
| `padding` | `56` | 0–300 | frame inset around the capture |
| `radius` | `24` | 0–100 | |
| `shadow` | `true` | | |
| `captionColor` | `#c8d2e6` | | idle word |
| `captionActiveColor` | `#ffffff` | | word being spoken |
| `captionAccent` | `#38bdf8` | | underline under the active word |
| `captionEmphasis` | `0.06` | 0–0.4 | extra scale on the active word; `0` = colour only |
| `captionScale` | `1` | 0.5–2.5 | multiplies the width-derived type size |
| `cutTransitionMs` | `180` | 0–2000 | crossfade at every `editList` cut |
| `openingFadeMs` | `320` | 0–5000 | fade up from `background` |
| `endingFadeMs` | `420` | 0–5000 | fade down to `background` |

`0` turns any of the three transitions off. A crossfade borrows ~180 ms of
material from the other side of the cut — that is what an NLE handle is. If a cut
must be exact (a redaction, a state that must not be glimpsed), set
`cutTransitionMs: 0`.

## Cursor — automatic, not authored

The screencast does not draw the pointer, so AutoDemo composites a synthetic
one. There is no cursor field and nothing to send. Know how it behaves:

- Its keyframes are your actions, so a click lands exactly on the control clicked.
- It holds on the previous target and starts moving 500 ms before the next one.
- **A click pulses; a fill does not.** If you want a beat of emphasis somewhere,
  it has to be a real click.
- It is drawn at constant pixel size outside the camera, so zoom never bloats it.
- A click whose instant was cut is never sampled — no orphan pulse.

## 7. `render_video`

`{projectPath, outputPath?}` → H.264 MP4 (defaults to `final.mp4` beside the
project). Re-render as many times as you like; the capture is untouched.

## 8. Validate before you hand it over

- The file exists, its duration matches the `editList` arithmetic, and its frame
  is the one you meant to publish (a "social" cut that came out 16:9 is wrong
  before anyone watches it).
- On a reframed cut: at every action the control being used is inside the frame,
  and the camera drifts rather than swings. If it swings, the flow is too spread
  out for a crop — record vertical instead.
- No credential, token or real customer datum is on screen.
- Every caption is fully readable at its length, and none is cut mid-sentence.
- Zooms frame the target instead of clipping it.
- No dead time survived.

If any of these fail, `project_update` and re-render. Do not re-record unless the
capture itself is wrong.

## Errors

Every tool answers with a JSON body. A failure comes back as a normal result with
`isError: true` and a text message — read it, do not just retry.

- `demo_create` fails with a JSON body, never a bare string:

  ```json
  {"error": "demo_create failed at step 3 (click \"[data-testid=\\\"signup-terms\\\"]\"): locator.boundingBox: Timeout 30000ms exceeded. …",
   "stage": "step", "step": {"index": 3, "action": "click", "selector": "[data-testid=\"signup-terms\"]", "label": "Agree to the terms"},
   "cause": "locator.boundingBox: Timeout 30000ms exceeded. …",
   "sessionId": "…", "blockedRequests": [],
   "capture": "…/sessions/…/capture.json"}
  ```

  `stage` is `open` (the first navigation), `step` (one of yours — `index` is
  its position in `steps`, a fill's `value` is never echoed), `stop`, `build`,
  `update` or `render`. `cause` is the underlying message — the network policy's
  own when that is why. `capture` is present whenever the recording up to the
  failure could be assembled; `project` too when the failure came after the
  build, so a render failure loses nothing. The session is already gone: fix the
  step and call `demo_create` again, or reproduce the flow with the granular
  tools to inspect the page at the failing step.

- `Input validation error: …` — your arguments broke the tool's schema. The
  message names the field and the bound (e.g. `zooms.0.scale: Too big: expected
  number to be <=3`). Fix the argument; nothing was written.
- `Unknown session: <id>` — the session was already stopped (`session_stop`,
  `demo_finalize` and a finished or failed `demo_create` all end it) or never
  existed.
- `Cannot render: the project's edit list keeps no material` — your `editList`
  cut everything.
- `AutoDemo refused <url>: "<host:port>" is not in AUTODEMO_ALLOWED_HOSTS
  (currently …)` — navigation off the allowlist fails **by design**, at the
  network layer: the first navigation, a redirect the page answers with, a link
  you click, a `fetch` the page makes, a WebSocket. A refused navigation fails
  the call and the page stays put; a refused sub-resource is silently aborted
  for the page. `session_status` exposes every denial as `blockedRequests`
  (`kind`, `url`, `host`, `reason`) — read it after a step that behaved
  strangely. Do not look for another spelling of the host; ask the operator to
  extend `AUTODEMO_ALLOWED_HOSTS` and start a new session.
