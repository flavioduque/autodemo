---
name: demomotion
description: Autonomously create polished product demo videos by operating a web application through DemoMotion MCP, recording the workflow, generating a cinematic interaction timeline, and rendering the final video with Remotion.
---

# DemoMotion Agent Skill

## Objective

Turn a product URL plus a communication objective into a finished polished demo video with minimal or no human editing.

The agent owns the whole workflow:
research → demo plan → capture → interaction → timeline → visual treatment → render → validation.

## Mandatory workflow

### 1. Understand the demo objective

Determine:
- target audience
- product capability to demonstrate
- target duration
- output aspect ratio
- critical user journey
- sensitive fields that must not appear in the recording

Do not wander through unrelated product areas.

### 2. Plan the interaction before recording

Create a concise sequence of scenes.

Each scene must have:
- purpose
- action
- expected visible state
- estimated duration

Prefer 3–7 scenes for short product demos.

### 3. Start recording

Call `session_start`.

Default:
- 1920x1080
- visible browser (`headless: false`) during local production

### 4. Operate the product

Use:
- `browser_goto`
- `browser_click`
- `browser_fill`
- `browser_wait`

Rules:
- prefer stable selectors
- never expose passwords, tokens or secrets
- keep pauses short
- avoid meaningless mouse movement
- wait only for real UI transitions
- make the recorded workflow deterministic

### 5. Inspect if uncertain

Use `browser_screenshot` to validate UI state.

Do not continue blindly after navigation errors, unexpected dialogs, failed authentication, or missing elements.

### 6. Finish capture

Call `session_stop`.

Preserve the returned `capture.json` path.

### 7. Build editing project

Call `project_build`.

The project builder generates initial zooms around meaningful clicks and form interactions.

Treat this generated timeline as an editable first pass, not immutable output.

### 8. Render with Remotion

Call `render_video`.

The renderer should:
- frame the product cleanly
- use smooth motion
- focus attention on the active UI region
- avoid excessive zoom
- maintain readable UI scale
- use product-brand presets when available

### 9. Validate

Check:
- final file exists
- duration is reasonable
- no credentials are visible
- important actions are legible
- zooms do not cut off the target
- no unnecessary dead time exists

If validation fails, modify the project and rerender.

## Editing heuristics

### Zoom

Good default:
- scale: 1.20–1.45
- enter: 180–300ms
- hold around action
- exit: 220–350ms

Avoid repeated aggressive punch zooms.

### Pacing

For SaaS demos:
- navigation: fast
- important result state: slower
- typing: keep concise
- loading: cut or accelerate when possible

### Cursor

A future cursor metadata adapter may provide a fully independent cursor layer.
Until then, focus camera motion around known interaction coordinates captured from Playwright.

## Capture backend strategy

Preferred order:

1. Remotion Canvas Capture adapter for web pages when high-resolution browser capture is available.
2. Playwright video backend for deterministic browser automation and MVP compatibility.
3. Native desktop capture adapter for desktop applications.

The MCP tool surface should remain stable regardless of backend.

## Remotion responsibility

Remotion is the final compositor and source of truth for:
- framing
- zoom
- pan
- backgrounds
- overlays
- captions
- title cards
- transitions
- sound design
- voiceover
- export

Do not bake visual effects into the raw capture when they can remain editable in Remotion.

## Future high-level tool

The target interface is eventually:

`demo_create({ url, objective, duration, aspectRatio, brandPreset })`

Internally, the agent still follows the workflow above so each phase remains observable and debuggable.
