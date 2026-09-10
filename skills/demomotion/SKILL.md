---
name: demomotion
description: Autonomously create polished product demo videos by operating a web application through the DemoMotion MCP server — recording a deterministic capture, compiling an editable project, cutting dead time, writing word-by-word narration, and rendering the final MP4 with the HyperFrames compositor.
---

# DemoMotion Agent Skill

You operate a product, then you edit the recording as data. Nothing is baked into
the pixels: every creative decision lives in `project.json` and can be changed and
re-rendered without recording again.

## The pipeline

```
session_start → browser_goto / click / fill / wait → session_stop
             → project_build → (project_update)* → render_video
```

`demo_finalize` collapses `session_stop → project_build → render_video` into one
call on a live session. Use it only for a throwaway or a smoke check: it renders
the automatic first pass, so no cuts and no rewritten narration. Any demo meant
for a human goes through `project_update` at least once.

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

Frame size is decided here too and cannot be changed later: the video is rendered
at the session's `width` x `height`. There is no reframing pass, so a vertical cut
means recording a vertical session.

## 2. Plan 3–7 scenes

Each scene: purpose · action · expected visible state · rough duration.
A demo with more than seven scenes is two demos.

## 3. Record

`session_start` — defaults `1920x1080`, `headless: false` for local production.
Returns `sessionId`; every browser tool needs it.

- `browser_goto` — `http`/`https` only, subject to `DEMOMOTION_ALLOWED_HOSTS`.
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
- Keep pauses short. Dead time is cheaper to cut than to sit through, but it is
  cheapest not to record.

`session_stop` → writes `capture.json` (constant fps, frame ⇔ time exact) and
returns its path plus `durationMs`. Keep both.

## 4. `project_build`

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

## 5. `project_update` — the editing pass

A patch against `project.json`. Omitted fields keep their value. `style` is
**merged** field by field; `zooms`, `editList`, `callouts` and `captions` are
**replaced wholesale** — send the complete array you want, not a delta.

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

The screencast does not draw the pointer, so DemoMotion composites a synthetic
one. There is no cursor field and nothing to send. Know how it behaves:

- Its keyframes are your actions, so a click lands exactly on the control clicked.
- It holds on the previous target and starts moving 500 ms before the next one.
- **A click pulses; a fill does not.** If you want a beat of emphasis somewhere,
  it has to be a real click.
- It is drawn at constant pixel size outside the camera, so zoom never bloats it.
- A click whose instant was cut is never sampled — no orphan pulse.

## 6. `render_video`

`{projectPath, outputPath?}` → H.264 MP4 (defaults to `final.mp4` beside the
project). Re-render as many times as you like; the capture is untouched.

## 7. Validate before you hand it over

- The file exists and its duration matches the `editList` arithmetic.
- No credential, token or real customer datum is on screen.
- Every caption is fully readable at its length, and none is cut mid-sentence.
- Zooms frame the target instead of clipping it.
- No dead time survived.

If any of these fail, `project_update` and re-render. Do not re-record unless the
capture itself is wrong.

## Errors

Every tool answers with a JSON body. A failure comes back as a normal result with
`isError: true` and a text message — read it, do not just retry.

- `Input validation error: …` — your arguments broke the tool's schema. The
  message names the field and the bound (e.g. `zooms.0.scale: Too big: expected
  number to be <=3`). Fix the argument; nothing was written.
- `Unknown session: <id>` — the session was already stopped (`session_stop` and
  `demo_finalize` both end it) or never existed.
- `Cannot render: the project's edit list keeps no material` — your `editList`
  cut everything.
- `Host not allowed by DEMOMOTION_ALLOWED_HOSTS` — the operator restricted
  navigation; ask, do not work around it.
