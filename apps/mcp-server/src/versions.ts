import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * This package's own version, read from package.json at runtime. The file sits
 * one level above BOTH `src/` (tsx, development) and `dist/` (the published
 * bundle), so the same relative path is right in either layout.
 */
export const VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;

/**
 * The Playwright that is actually installed next to this package. Every
 * "install the browser" hint carries it: a bare `npx playwright install` would
 * fetch whatever Playwright is newest and provision a Chromium build the pinned
 * one does not look for.
 */
export const PLAYWRIGHT_VERSION: string = require("playwright/package.json").version;
