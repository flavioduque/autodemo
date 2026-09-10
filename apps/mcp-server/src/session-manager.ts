import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { DemoAction } from "@demomotion/schema";

export interface Session {
  id: string;
  dir: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  startedAt: number;
  width: number;
  height: number;
  actions: DemoAction[];
}

const sessions = new Map<string, Session>();

function elapsed(session: Session) {
  return Date.now() - session.startedAt;
}

export async function startSession(opts: {
  width: number;
  height: number;
  headless: boolean;
}) {
  const id = crypto.randomUUID();
  const dir = path.resolve("data/sessions", id);
  await fs.mkdir(dir, { recursive: true });

  const browser = await chromium.launch({ headless: opts.headless });
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    recordVideo: {
      dir,
      size: { width: opts.width, height: opts.height }
    }
  });
  const page = await context.newPage();

  const session: Session = {
    id,
    dir,
    browser,
    context,
    page,
    startedAt: Date.now(),
    width: opts.width,
    height: opts.height,
    actions: []
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string) {
  const session = sessions.get(id);
  if (!session) throw new Error(`Unknown session: ${id}`);
  return session;
}

function assertAllowedUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  const configured = (process.env.DEMOMOTION_ALLOWED_HOSTS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (configured.length && !configured.includes(url.hostname)) {
    throw new Error(`Host not allowed by DEMOMOTION_ALLOWED_HOSTS: ${url.hostname}`);
  }
  return url.toString();
}

export async function goto(id: string, url: string) {
  const safeUrl = assertAllowedUrl(url);
  const s = getSession(id);
  const atMs = elapsed(s);
  await s.page.goto(safeUrl, { waitUntil: "networkidle" });
  s.actions.push({ id: crypto.randomUUID(), type: "goto", atMs, durationMs: elapsed(s) - atMs, url: safeUrl });
}

export async function click(id: string, selector: string, label?: string) {
  const s = getSession(id);
  const atMs = elapsed(s);
  const locator = s.page.locator(selector).first();
  const box = await locator.boundingBox();
  await locator.click();
  s.actions.push({
    id: crypto.randomUUID(),
    type: "click",
    atMs,
    durationMs: elapsed(s) - atMs,
    selector,
    label,
    x: box ? (box.x + box.width / 2) / s.width : undefined,
    y: box ? (box.y + box.height / 2) / s.height : undefined
  });
}

export async function fill(id: string, selector: string, value: string, label?: string) {
  const s = getSession(id);
  const atMs = elapsed(s);
  const locator = s.page.locator(selector).first();
  const box = await locator.boundingBox();
  await locator.fill(value);
  s.actions.push({
    id: crypto.randomUUID(),
    type: "fill",
    atMs,
    durationMs: elapsed(s) - atMs,
    selector,
    value: "[redacted]",
    label,
    x: box ? (box.x + box.width / 2) / s.width : undefined,
    y: box ? (box.y + box.height / 2) / s.height : undefined
  });
}

export async function wait(id: string, ms: number) {
  const s = getSession(id);
  const atMs = elapsed(s);
  await s.page.waitForTimeout(ms);
  s.actions.push({ id: crypto.randomUUID(), type: "wait", atMs, durationMs: ms });
}

export async function screenshot(id: string, name = "screen.png") {
  const s = getSession(id);
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const file = path.join(s.dir, safe);
  await s.page.screenshot({ path: file, fullPage: false });
  s.actions.push({ id: crypto.randomUUID(), type: "screenshot", atMs: elapsed(s), durationMs: 0, label: safe });
  return file;
}

export async function stopSession(id: string) {
  const s = getSession(id);
  const video = s.page.video();
  const durationMs = elapsed(s);

  await s.context.close();
  const videoPath = video ? await video.path() : null;
  await s.browser.close();

  const manifest = {
    id: s.id,
    width: s.width,
    height: s.height,
    durationMs,
    videoPath,
    actions: s.actions
  };
  const manifestPath = path.join(s.dir, "capture.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  sessions.delete(id);

  return { ...manifest, manifestPath };
}

export function status(id: string) {
  const s = getSession(id);
  return {
    id: s.id,
    elapsedMs: elapsed(s),
    url: s.page.url(),
    actions: s.actions.length,
    viewport: { width: s.width, height: s.height }
  };
}

export async function scroll(id: string, deltaY: number, deltaX = 0) {
  const s = getSession(id);
  const atMs = elapsed(s);
  await s.page.mouse.wheel(deltaX, deltaY);
  await s.page.waitForTimeout(150);
  s.actions.push({ id: crypto.randomUUID(), type: "scroll", atMs, durationMs: elapsed(s) - atMs, deltaX, deltaY });
}

export async function keypress(id: string, key: string) {
  const s = getSession(id);
  const atMs = elapsed(s);
  await s.page.keyboard.press(key);
  s.actions.push({ id: crypto.randomUUID(), type: "keypress", atMs, durationMs: elapsed(s) - atMs, key });
}

export async function inspectPage(id: string, limit = 80) {
  const s = getSession(id);
  const elements = await s.page.locator("a,button,input,textarea,select,[role],[data-testid]").evaluateAll((nodes) => {
    const cssEscape = (value: string) => {
      const css = (globalThis as any).CSS;
      return css?.escape ? css.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    };
    return nodes.map((node: Element) => {
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();
      const testId = el.getAttribute("data-testid");
      const id = el.id;
      const name = el.getAttribute("name");
      const role = el.getAttribute("role") || undefined;
      const aria = el.getAttribute("aria-label") || "";
      const text = (aria || el.innerText || (el as HTMLInputElement).placeholder || "").trim().replace(/\s+/g, " ").slice(0, 160);
      let selector = tag;
      if (testId) selector = `[data-testid="${testId.replace(/"/g, '\\"')}"]`;
      else if (id) selector = `#${cssEscape(id)}`;
      else if (name) selector = `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
      return {tag, text, role, selector};
    }).filter((x) => x.text || x.role || ["input","button","a","select","textarea"].includes(x.tag));
  });
  return {
    url: s.page.url(),
    title: await s.page.title(),
    elements: elements.slice(0, Math.max(1, Math.min(limit, 200)))
  };
}
