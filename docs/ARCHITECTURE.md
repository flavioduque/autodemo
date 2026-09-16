# AutoDemo architecture

## Goal

An AI agent owns the full product-demo workflow: inspect a web app, plan a concise journey, operate it, record it, convert interactions into an editable timeline, apply creative treatment, render with HyperFrames, and validate the output.

## Control flow

AI client → MCP v2 → capture adapter → immutable raw assets + event stream → project compiler → editable `project.json` → `@autodemo/compositor` (HyperFrames HTML) → `hyperframes render` → MP4.

## Stable MCP surface

Capture backends must be replaceable without changing the agent-facing contract.

Current backend: Playwright video capture.
Future backend: native desktop capture for macOS/Windows/Linux.

## Source-of-truth rule

Capture facts once; make creative decisions later.

Raw recording and action metadata are source assets. Zoom, framing, callouts, captions, titles, transitions, audio treatment and voiceover belong to the composition layer: `packages/compositor` turns `project.json` into a HyperFrames HTML composition, and `apps/mcp-server` drives the `hyperframes` CLI to render it.

## Security

`browser_fill` redacts values from timeline metadata. This does not hide values visibly rendered by the target application; demo accounts and non-sensitive data remain mandatory.

`AUTODEMO_ALLOWED_HOSTS` can restrict navigation hosts. Only HTTP and HTTPS URLs are accepted.

## Recordly relationship

Recordly is a product/UX reference only. AutoDemo is an independent implementation and does not include Recordly source code.
