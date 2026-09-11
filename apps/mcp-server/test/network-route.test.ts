import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { startSession, goto, click, status, stopSession, type Session } from "../src/session-manager.ts";

// ---------------------------------------------------------------------------
// The network allowlist, enforced at the network layer, against a REAL browser
// and two local servers — one allowlisted, one not. Every request the browser
// makes has to go through the policy: the first navigation, an HTTP redirect
// it answers with, a click on a link, an in-page fetch(), a WebSocket. The
// forbidden server LOGS every hit, so "blocked" is asserted as zero arrivals at
// the socket, never as an error message alone.
//
// No external network: both servers listen on 127.0.0.1, and the one hostname
// used (`pinned.demomotion.invalid`) is resolved by an injected resolver —
// `.invalid` is reserved by RFC 6761 precisely so that it can never resolve.
//
// Not gated behind an env var, like frames.test.ts: a suite that stays green
// while the browser can reach anything is the gap that shipped the defect. Needs
// a browser, no ffmpeg. On macOS the locally installed Chrome is driven.
// ---------------------------------------------------------------------------

if (process.platform === "darwin" && !process.env.DEMOMOTION_BROWSER_CHANNEL) {
  process.env.DEMOMOTION_BROWSER_CHANNEL = "chrome";
}

interface Hit { url: string; host: string; upgrade?: boolean }

interface LocalServer {
  port: number;
  origin: string;
  hits: Hit[];
  close: () => Promise<void>;
}

/**
 * A local server that logs every arrival — plain requests AND WebSocket upgrade
 * attempts — and serves the small pages the scenarios need.
 */
function serve(routes: Record<string, (res: http.ServerResponse) => void> = {}): Promise<LocalServer> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url ?? "", host: req.headers.host ?? "" });
    const handler = routes[req.url ?? "/"];
    if (handler) return handler(res);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h1>ok</h1>");
  });
  server.on("upgrade", (req, socket) => {
    hits.push({ url: req.url ?? "", host: req.headers.host ?? "", upgrade: true });
    socket.destroy();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        hits,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

const html = (body: string) => (res: http.ServerResponse) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>t</title>${body}`);
};

/** Server A's pages, every one of them pointing at server B. */
function pagesPointingAt(b: LocalServer) {
  return {
    "/redirect": (res: http.ServerResponse) => { res.writeHead(302, { location: `${b.origin}/from-redirect` }); res.end(); },
    "/link": html(`<h1 id="stay">A</h1><a id="link" href="${b.origin}/from-click">go</a>`),
    "/fetch": html(`<h1>A</h1><script>fetch("${b.origin}/from-fetch").catch(function(){})</script>`),
    "/ws": html(`<h1>A</h1><script>try{new WebSocket("${b.origin.replace("http", "ws")}/from-ws")}catch(e){}</script>`),
    "/plain": html(`<h1>A</h1>`)
  };
}

async function open(t: any, network: Parameters<typeof startSession>[0]["network"]): Promise<Session> {
  const session = await startSession({ width: 800, height: 500, headless: true, network });
  t.after(async () => {
    await session.context.close().catch(() => {});
    await session.browser.close().catch(() => {});
    await fs.rm(session.dir, { recursive: true, force: true }).catch(() => {});
  });
  return session;
}

/** Blocks are recorded asynchronously (the browser aborts the request); wait for one. */
async function waitForBlock(id: string, predicate: (b: { url: string }) => boolean, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = status(id).blockedRequests.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`no blocked request matched within ${timeoutMs}ms; blocked so far: ${JSON.stringify(status(id).blockedRequests)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

test("positive: the allowlisted server navigates and records, with zero blocked requests", { timeout: 60_000 }, async (t) => {
  const b = await serve();
  const a = await serve(pagesPointingAt(b));
  t.after(async () => { await a.close(); await b.close(); });

  const session = await open(t, { allowedHosts: `127.0.0.1:${a.port}` });
  await goto(session.id, `${a.origin}/plain`);
  assert.equal(a.hits.filter((h) => h.url === "/plain").length, 1, "the allowlisted server was really reached");
  assert.equal(session.actions.length, 1);
  assert.equal(session.actions[0].type, "goto");
  const s = status(session.id);
  assert.deepEqual(s.blockedRequests, []);
  assert.equal(s.allowedHosts, `127.0.0.1:${a.port}`);
});

test("session_stop reports zero blocked requests for a clean session", { timeout: 60_000 }, async (t) => {
  // record-video mode: stopSession writes the manifest without ffmpeg (CI has none).
  const previous = process.env.DEMOMOTION_CAPTURE;
  process.env.DEMOMOTION_CAPTURE = "record-video";
  t.after(() => { if (previous === undefined) delete process.env.DEMOMOTION_CAPTURE; else process.env.DEMOMOTION_CAPTURE = previous; });

  const a = await serve();
  t.after(() => a.close());
  const session = await startSession({ width: 640, height: 400, headless: true, network: { allowedHosts: `127.0.0.1:${a.port}` } });
  t.after(() => fs.rm(session.dir, { recursive: true, force: true }).catch(() => {}));
  await goto(session.id, `${a.origin}/`);
  const capture = await stopSession(session.id);
  assert.deepEqual(capture.blockedRequests, []);
  const manifest = JSON.parse(await fs.readFile(capture.manifestPath, "utf8"));
  assert.deepEqual(manifest.blockedRequests, []);
});

test("seed: the second server IS reachable when it is allowlisted (the negative below is not vacuous)", { timeout: 60_000 }, async (t) => {
  const b = await serve();
  const a = await serve(pagesPointingAt(b));
  t.after(async () => { await a.close(); await b.close(); });

  const session = await open(t, { allowedHosts: `127.0.0.1:${a.port},127.0.0.1:${b.port}` });
  await goto(session.id, `${b.origin}/seed`);
  assert.equal(b.hits.filter((h) => h.url === "/seed").length, 1, "server B logged the arrival");
  assert.deepEqual(status(session.id).blockedRequests, []);
});

test("negative: the same server, not allowlisted — goto fails with OUR message and the server logs nothing", { timeout: 60_000 }, async (t) => {
  const b = await serve();
  const a = await serve(pagesPointingAt(b));
  t.after(async () => { await a.close(); await b.close(); });

  const session = await open(t, { allowedHosts: `127.0.0.1:${a.port}` });
  await goto(session.id, `${a.origin}/plain`);
  const before = session.page.url();

  await assert.rejects(
    () => goto(session.id, `${b.origin}/forbidden`),
    (error: Error) => {
      assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${b.port}`), "names the host and port");
      assert.match(error.message, /DEMOMOTION_ALLOWED_HOSTS/, "names the variable to set");
      assert.doesNotMatch(error.message, /net::ERR_/, "not Playwright's generic error");
      return true;
    }
  );
  await settle();
  assert.equal(b.hits.length, 0, "not a single byte reached the forbidden server");
  assert.equal(session.page.url(), before, "the page did not move");
  const blocked = status(session.id).blockedRequests;
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].kind, "navigation");
  assert.equal(blocked[0].url, `${b.origin}/forbidden`);
  assert.equal(session.actions.length, 1, "a refused goto records no action");
});

test("the env var is what configures the policy when nothing is injected", { timeout: 60_000 }, async (t) => {
  const b = await serve();
  const a = await serve(pagesPointingAt(b));
  t.after(async () => { await a.close(); await b.close(); });

  const previous = process.env.DEMOMOTION_ALLOWED_HOSTS;
  process.env.DEMOMOTION_ALLOWED_HOSTS = `127.0.0.1:${a.port}`;
  t.after(() => { if (previous === undefined) delete process.env.DEMOMOTION_ALLOWED_HOSTS; else process.env.DEMOMOTION_ALLOWED_HOSTS = previous; });

  const session = await open(t, undefined);
  await goto(session.id, `${a.origin}/plain`);
  await assert.rejects(() => goto(session.id, `${b.origin}/x`), /DEMOMOTION_ALLOWED_HOSTS/);
  assert.equal(b.hits.length, 0);
});

test("default: variable unset — 127.0.0.1 works and a metadata address is refused before any socket", { timeout: 60_000 }, async (t) => {
  const a = await serve();
  t.after(() => a.close());
  const previous = process.env.DEMOMOTION_ALLOWED_HOSTS;
  delete process.env.DEMOMOTION_ALLOWED_HOSTS;
  t.after(() => { if (previous !== undefined) process.env.DEMOMOTION_ALLOWED_HOSTS = previous; });

  const session = await open(t, undefined);
  assert.equal(status(session.id).allowedHosts, "localhost, 127.0.0.1, ::1");
  await goto(session.id, `${a.origin}/`);
  assert.equal(a.hits.length, 1);

  // Refused on the literal, by the pre-check in goto: nothing is navigated, so
  // no request exists for the route layer to see — the only record is ours.
  await assert.rejects(
    () => goto(session.id, "http://169.254.169.254/latest/meta-data/"),
    (error: Error) => { assert.match(error.message, /169\.254\.169\.254/); assert.match(error.message, /DEMOMOTION_ALLOWED_HOSTS/); return true; }
  );
  const blocked = status(session.id).blockedRequests;
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].kind, "navigation");
  assert.equal(session.page.url(), `${a.origin}/`);
});

test("redirect: an allowlisted page answering 302 to the forbidden server — zero hits, the block is recorded, goto fails with OUR message", { timeout: 60_000 }, async (t) => {
  const b = await serve();
  const a = await serve(pagesPointingAt(b));
  t.after(async () => { await a.close(); await b.close(); });

  const session = await open(t, { allowedHosts: `127.0.0.1:${a.port}` });
  await goto(session.id, `${a.origin}/plain`);
  await assert.rejects(
    () => goto(session.id, `${a.origin}/redirect`),
    (error: Error) => {
      assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${b.port}`), "names the redirect TARGET");
      assert.match(error.message, /DEMOMOTION_ALLOWED_HOSTS/);
      assert.doesNotMatch(error.message, /net::ERR_/);
      return true;
    }
  );
  await settle();
  assert.equal(a.hits.filter((h) => h.url === "/redirect").length, 1, "the redirecting page itself was fetched");
  assert.equal(b.hits.length, 0, "the redirect target never received the request");
  const blocked = await waitForBlock(session.id, (r) => r.url === `${b.origin}/from-redirect`);
  assert.equal(blocked.kind, "redirect");
});

test("click: a link to the forbidden server — the click does not reach it, the page stays, the block is recorded", { timeout: 60_000 }, async (t) => {
  const b = await serve();
  const a = await serve(pagesPointingAt(b));
  t.after(async () => { await a.close(); await b.close(); });

  const session = await open(t, { allowedHosts: `127.0.0.1:${a.port}` });
  await goto(session.id, `${a.origin}/link`);
  await click(session.id, "#link", "go");
  const blocked = await waitForBlock(session.id, (r) => r.url === `${b.origin}/from-click`);
  assert.equal(blocked.kind, "navigation");
  await settle();
  assert.equal(b.hits.length, 0);
  assert.equal(session.page.url(), `${a.origin}/link`, "the page did not move to an error page either");
  assert.equal(await session.page.locator("#stay").count(), 1, "the original document is still there");
  assert.equal(session.actions.at(-1)?.type, "click");
});

test("in-page fetch(): the page loads, the forbidden fetch never arrives, the block is recorded as a sub-resource", { timeout: 60_000 }, async (t) => {
  const b = await serve();
  const a = await serve(pagesPointingAt(b));
  t.after(async () => { await a.close(); await b.close(); });

  const session = await open(t, { allowedHosts: `127.0.0.1:${a.port}` });
  await goto(session.id, `${a.origin}/fetch`);
  const blocked = await waitForBlock(session.id, (r) => r.url === `${b.origin}/from-fetch`);
  assert.equal(blocked.kind, "subresource");
  await settle();
  assert.equal(b.hits.length, 0);
  assert.equal(a.hits.filter((h) => h.url === "/fetch").length, 1, "the page that issued the fetch was served");
});

test("WebSocket: the handshake to the forbidden server never arrives", { timeout: 60_000 }, async (t) => {
  const b = await serve();
  const a = await serve(pagesPointingAt(b));
  t.after(async () => { await a.close(); await b.close(); });

  const session = await open(t, { allowedHosts: `127.0.0.1:${a.port}` });
  await goto(session.id, `${a.origin}/ws`);
  const blocked = await waitForBlock(session.id, (r) => r.url.startsWith(`ws://127.0.0.1:${b.port}`));
  assert.equal(blocked.kind, "websocket");
  await settle();
  assert.equal(b.hits.length, 0, "no upgrade request reached the forbidden server");
});

test("bypass spellings of 127.0.0.1 with the forbidden port are refused; the same spellings with the allowed port work", { timeout: 60_000 }, async (t) => {
  const b = await serve();
  const a = await serve(pagesPointingAt(b));
  t.after(async () => { await a.close(); await b.close(); });

  const session = await open(t, { allowedHosts: `127.0.0.1:${a.port}` });
  // `new URL` folds these three to 127.0.0.1 — so it is the PORT that refuses
  // them, and the message says 127.0.0.1:<port>, the host the browser would use.
  for (const spelling of ["127.1", "0x7f000001", "2130706433"]) {
    await assert.rejects(
      () => goto(session.id, `http://${spelling}:${b.port}/`),
      (error: Error) => { assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${b.port}`), spelling); return true; }
    );
  }
  // IPv4-mapped IPv6 is NOT folded: it is refused as the literal it is.
  await assert.rejects(
    () => goto(session.id, `http://[::ffff:127.0.0.1]:${b.port}/`),
    (error: Error) => { assert.match(error.message, /\[::ffff:7f00:1\]/); assert.match(error.message, /DEMOMOTION_ALLOWED_HOSTS/); return true; }
  );
  await assert.rejects(() => goto(session.id, `http://[::ffff:127.0.0.1]:${a.port}/`), /\[::ffff:7f00:1\]/);
  await settle();
  assert.equal(b.hits.length, 0);

  // Positive half: the folded spellings reach the ALLOWED port, as 127.0.0.1.
  await goto(session.id, `http://127.1:${a.port}/plain`);
  await goto(session.id, `http://0x7f000001:${a.port}/plain`);
  assert.equal(a.hits.filter((h) => h.url === "/plain").length, 2);
  assert.equal(a.hits.filter((h) => h.url === "/plain").every((h) => h.host === `127.0.0.1:${a.port}`), true, "the browser used the folded host");
});

test("DNS pin: a listed name is resolved by OUR resolver and Chromium is pinned to that address", { timeout: 60_000 }, async (t) => {
  const a = await serve();
  t.after(() => a.close());
  const name = "pinned.demomotion.invalid";

  // Assertion zero: the name has no real binding on this host, so a hit can
  // only come from the pin. `.invalid` never resolves (RFC 6761); an offline
  // host fails the same way, just with a different code.
  await assert.rejects(() => dns.lookup(name, { all: true }), (e: NodeJS.ErrnoException) => { assert.ok(e.code, "lookup failed with a code"); return true; });

  const session = await open(t, {
    allowedHosts: `${name}:${a.port},127.0.0.1:${a.port}`,
    lookup: async (hostname) => hostname === name ? [{ address: "127.0.0.1", family: 4 }] : []
  });
  await goto(session.id, `http://${name}:${a.port}/pinned`);
  const hit = a.hits.find((h) => h.url === "/pinned");
  assert.ok(hit, "the request arrived at 127.0.0.1 — Chromium followed the pin, not DNS");
  assert.equal(hit!.host, `${name}:${a.port}`, "and it was addressed to the NAME, not rewritten to the IP");
  assert.deepEqual(status(session.id).blockedRequests, []);

  // Negative half: the same name resolving outside the allowlist is refused
  // with our message, and the resolver — not the browser — is what decided.
  const bad = await open(t, {
    allowedHosts: `${name}:${a.port},127.0.0.1:${a.port}`,
    lookup: async () => [{ address: "169.254.169.254", family: 4 }]
  });
  const before = a.hits.length;
  await assert.rejects(
    () => goto(bad.id, `http://${name}:${a.port}/`),
    (error: Error) => { assert.match(error.message, /169\.254\.169\.254/); assert.match(error.message, /DEMOMOTION_ALLOWED_HOSTS/); return true; }
  );
  assert.equal(a.hits.length, before);
});
