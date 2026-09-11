import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { startSession, goto, click, status, stopSession, inspectPage, type Session } from "../src/session-manager.ts";

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

if (process.platform === "darwin" && !process.env.DEMOMOTION_BROWSER_CHANNEL && !process.env.DEMOMOTION_BROWSER_EXECUTABLE) {
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
        // Destroys live connections first: `server.close` alone waits for every
        // connection to finish, and the browser (torn down AFTER the servers in
        // each test) may hold one open on a request that will never complete —
        // a cleanup hook that waits on it never returns, and node:test gives a
        // hook no timeout of its own: the file hangs, silently.
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); })
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
    // Same-origin fetch and XHR whose ANSWER is the 302 to server B.
    "/fetch-hop": html(`<h1>A</h1><script>fetch("/redirect").catch(function(){});var x=new XMLHttpRequest();x.open("GET","/redirect");x.send()</script>`),
    "/ws": html(`<h1>A</h1><script>try{new WebSocket("${b.origin.replace("http", "ws")}/from-ws")}catch(e){}</script>`),
    // Never answered: a page that includes it never reaches networkidle.
    "/hang": () => {},
    // Loads, then sends itself to server B — while `/hang` keeps the load from
    // ever going idle. What a `goto` has to settle on is the guard, not Playwright.
    "/leave-for-b": html(`<h1 id="stay">A</h1><img src="/hang"><script>location.href="${b.origin}/from-leave"</script>`),
    "/plain": html(`<h1>A</h1>`)
  };
}

/**
 * Cleanup hooks get an explicit timeout. node:test does not give a hook the
 * test's timeout — a hook that never settles is a file that never finishes
 * and never says why (CI run 34610252858: fourteen silent minutes, cancelled).
 * With one, a stuck teardown is a red hook with a name.
 */
const HOOK = { timeout: 20_000 };

async function open(t: any, network: Parameters<typeof startSession>[0]["network"]): Promise<Session> {
  // The hook is registered BEFORE the launch is awaited: a test that times out
  // while the browser is still starting would otherwise get its browser AFTER
  // the timeout, with no hook to close it — and a browser nobody closes keeps
  // the runner's event loop alive after the last test (seen by execution: a
  // diagnostic report of the stuck runner showed a live Chrome `process`
  // handle and its four pipes, and nothing else).
  const pending = startSession({ width: 800, height: 500, headless: true, network });
  t.after(async () => {
    const session = await pending.catch(() => undefined);
    if (!session) return;
    await session.context.close().catch(() => {});
    await session.browser.close().catch(() => {});
    await fs.rm(session.dir, { recursive: true, force: true }).catch(() => {});
  }, HOOK);
  return pending;
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
  t.after(async () => { await a.close(); await b.close(); }, HOOK);

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
  t.after(() => a.close(), HOOK);
  const session = await startSession({ width: 640, height: 400, headless: true, network: { allowedHosts: `127.0.0.1:${a.port}` } });
  t.after(() => fs.rm(session.dir, { recursive: true, force: true }).catch(() => {}), HOOK);
  await goto(session.id, `${a.origin}/`);
  const capture = await stopSession(session.id);
  assert.deepEqual(capture.blockedRequests, []);
  const manifest = JSON.parse(await fs.readFile(capture.manifestPath, "utf8"));
  assert.deepEqual(manifest.blockedRequests, []);
});

test("seed: the second server IS reachable when it is allowlisted (the negative below is not vacuous)", { timeout: 60_000 }, async (t) => {
  const b = await serve();
  const a = await serve(pagesPointingAt(b));
  t.after(async () => { await a.close(); await b.close(); }, HOOK);

  const session = await open(t, { allowedHosts: `127.0.0.1:${a.port},127.0.0.1:${b.port}` });
  await goto(session.id, `${b.origin}/seed`);
  assert.equal(b.hits.filter((h) => h.url === "/seed").length, 1, "server B logged the arrival");
  assert.deepEqual(status(session.id).blockedRequests, []);
});

test("negative: the same server, not allowlisted — goto fails with OUR message and the server logs nothing", { timeout: 60_000 }, async (t) => {
  const b = await serve();
  const a = await serve(pagesPointingAt(b));
  t.after(async () => { await a.close(); await b.close(); }, HOOK);

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
  t.after(async () => { await a.close(); await b.close(); }, HOOK);

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
  t.after(() => a.close(), HOOK);
  const previous = process.env.DEMOMOTION_ALLOWED_HOSTS;
  delete process.env.DEMOMOTION_ALLOWED_HOSTS;
  t.after(() => { if (previous !== undefined) process.env.DEMOMOTION_ALLOWED_HOSTS = previous; });

  const session = await open(t, undefined);
  assert.equal(status(session.id).allowedHosts, "localhost, 127.0.0.1, ::1");
  await goto(session.id, `${a.origin}/`);
  // The navigation reached A. (A `/favicon.ico` to this allowed host may also
  // arrive during networkidle; scope to the navigation, which is the point.)
  assert.equal(a.hits.filter((h) => h.url === "/").length, 1, "the allowlisted navigation did not reach the server");

  // Refused on the literal, by the pre-check in goto: nothing is navigated, so
  // no request exists for the http guard to see — the only record is ours.
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
  t.after(async () => { await a.close(); await b.close(); }, HOOK);

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
  assert.equal(session.page.url(), `${a.origin}/plain`, "the page did not move");

  // Positive half: with B allowed, the same 302 is followed and goto lands on B.
  const allowed = await open(t, { allowedHosts: `127.0.0.1:${a.port},127.0.0.1:${b.port}` });
  await goto(allowed.id, `${a.origin}/redirect`);
  assert.equal(allowed.page.url(), `${b.origin}/from-redirect`, "the allowed redirect was not followed to its target");
  assert.equal(b.hits.filter((h) => h.url === "/from-redirect").length, 1);
  assert.deepEqual(status(allowed.id).blockedRequests, []);
  assert.equal(allowed.actions.at(-1)?.type, "goto", "the allowed navigation was recorded");
});

test("goto settles on the guard's block, not on Playwright: a page that leaves for the forbidden server while its load never goes idle", { timeout: 60_000 }, async (t) => {
  // `/leave-for-b` never reaches networkidle (its <img> is never answered), so
  // Playwright's goto on its own would only settle on the navigation timeout —
  // 30 s, or never, depending on how the Chromium build reports the aborted
  // load. The guard records the block at once; goto must fail with it at once.
  const b = await serve();
  const a = await serve(pagesPointingAt(b));
  t.after(async () => { await a.close(); await b.close(); }, HOOK);

  const session = await open(t, { allowedHosts: `127.0.0.1:${a.port}` });
  const started = Date.now();
  await assert.rejects(
    () => goto(session.id, `${a.origin}/leave-for-b`),
    (error: Error) => {
      assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${b.port}/from-leave`), "names the URL the page tried to leave for");
      assert.match(error.message, /DEMOMOTION_ALLOWED_HOSTS/);
      return true;
    }
  );
  // Playwright on its own could only settle this at its 30 s navigation
  // timeout (or never). The window includes serving and running the page, so
  // the bound is generous for a loaded host, and still well under 30 s.
  const tookMs = Date.now() - started;
  assert.ok(tookMs < 20_000, `goto took ${tookMs}ms to fail — it waited on Playwright, not on the guard`);
  assert.equal(b.hits.length, 0, "the forbidden server was never reached");
  assert.equal(await session.page.locator("#stay").count(), 1, "the original document is still there");
  const blocked = status(session.id).blockedRequests;
  assert.equal(blocked.length, 1, JSON.stringify(blocked));
  assert.equal(blocked[0].kind, "navigation");

  // The other half: a block that is NOT this page's own navigation — a fetch
  // from the page, and a fetch/XHR whose 302 hop is refused (labelled
  // `redirect`, issued from the main frame) — does not fail a goto that is
  // otherwise fine.
  await goto(session.id, `${a.origin}/fetch`);
  await waitForBlock(session.id, (r) => r.url === `${b.origin}/from-fetch`);
  assert.equal(session.actions.at(-1)?.url, `${a.origin}/fetch`, "a goto with a refused sub-resource still completed and was recorded");
  await goto(session.id, `${a.origin}/fetch-hop`);
  await waitForBlock(session.id, (r) => r.url === `${b.origin}/from-redirect`);
  assert.equal(session.actions.at(-1)?.url, `${a.origin}/fetch-hop`, "a goto whose page's fetch was redirected somewhere forbidden still completed and was recorded");
  assert.equal(session.page.url(), `${a.origin}/fetch-hop`);
});

test("subresource redirect: fetch() and XHR answered 302 to the forbidden server — zero hits, both hops recorded as redirects; the same hops are followed when B is allowed", { timeout: 60_000 }, async (t) => {
  // Chromium restarts a cross-origin fetch()/XHR redirect as a NEW request with
  // no redirect mark, and Playwright's route auto-continues it as a redirect: a
  // layer judging only marked hops let this one through, on the main page.
  const b = await serve();
  const a = await serve(pagesPointingAt(b));
  t.after(async () => { await a.close(); await b.close(); }, HOOK);

  const session = await open(t, { allowedHosts: `127.0.0.1:${a.port}` });
  await goto(session.id, `${a.origin}/fetch-hop`);
  await settle(800);
  assert.equal(a.hits.filter((h) => h.url === "/redirect").length, 2, "fetch and XHR did not both request the redirecting URL");
  assert.equal(b.hits.length, 0, `a hop reached the forbidden server: ${JSON.stringify(b.hits)}`);
  const hops = status(session.id).blockedRequests.filter((r) => r.url === `${b.origin}/from-redirect`);
  assert.equal(hops.length, 2, `expected the fetch hop and the XHR hop, got ${JSON.stringify(status(session.id).blockedRequests)}`);
  assert.deepEqual(hops.map((r) => r.kind), ["redirect", "redirect"]);

  // Positive half: with B allowed, the very same hops arrive.
  const allowed = await open(t, { allowedHosts: `127.0.0.1:${a.port},127.0.0.1:${b.port}` });
  await goto(allowed.id, `${a.origin}/fetch-hop`);
  await settle(800);
  assert.equal(b.hits.filter((h) => h.url === "/from-redirect").length, 2, "the allowed redirects were not followed");
  assert.deepEqual(status(allowed.id).blockedRequests, []);
});

test("click: a link to the forbidden server — the click does not reach it, the page stays, the block is recorded", { timeout: 60_000 }, async (t) => {
  const b = await serve();
  const a = await serve(pagesPointingAt(b));
  t.after(async () => { await a.close(); await b.close(); }, HOOK);

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
  t.after(async () => { await a.close(); await b.close(); }, HOOK);

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
  t.after(async () => { await a.close(); await b.close(); }, HOOK);

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
  t.after(async () => { await a.close(); await b.close(); }, HOOK);

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
  t.after(() => a.close(), HOOK);
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

// ---------------------------------------------------------------------------
// Other TARGETS: cross-process iframes (OOPIFs), popups, nested OOPIFs.
//
// The redirect layer is a CDP `Fetch` session, and a `Fetch` session sees one
// TARGET. A cross-site <iframe> is its own target (Chromium site isolation), a
// popup is its own target, an iframe inside that iframe on a third site is a
// third. Every one of them must be guarded, and guarded BEFORE its first
// request goes out.
//
// A third site is needed for the iframe to be out-of-process: a second port on
// 127.0.0.1 is the same site (scheme + host). `localhost` and `sub.localhost`
// are different sites from `127.0.0.1` AND from each other, and both are
// loopback by definition (RFC 6761), so they still reach the local servers with
// no DNS. Every scenario ASSERTS the frame landed in a separate target via
// `Target.getTargets` — otherwise it would be exercising the same-process path
// that already worked.
// ---------------------------------------------------------------------------

/** Server B, reached as two distinct sites. */
const asLocalhost = (b: LocalServer) => `http://localhost:${b.port}`;
const asSubLocalhost = (b: LocalServer) => `http://sub.localhost:${b.port}`;

/** A, B (as localhost and sub.localhost) allowed; C — the third server — not. */
function allowAandB(a: LocalServer, b: LocalServer) {
  return `127.0.0.1:${a.port},localhost:${b.port},sub.localhost:${b.port},127.0.0.1:${b.port},[::1]:${b.port}`;
}

/** Three servers: A embeds B; B (and popups) try to reach C, which is not allowlisted. */
async function targetsScenario(t: any) {
  const c = await serve();
  const b: LocalServer = await serve({
    "/frame": html(`<h1 id="inframe">B</h1><button id="inframe-btn" onclick="this.textContent='clicked'">go</button>`),
    "/frame-hop": html(`<h1>B</h1><script>fetch("/hop").catch(function(){})</script>`),
    "/hop": (res) => { res.writeHead(302, { location: `${c.origin}/from-oopif-hop` }); res.end(); },
    // Embeds B AGAIN, as a third site (sub.localhost), whose document hops.
    // Read at request time: `b` does not exist while its own routes are declared.
    "/nested": (res) => html(`<h1>B</h1><iframe id="inner" src="${asSubLocalhost(b)}/frame-hop"></iframe>`)(res)
  });
  const a = await serve({
    "/embed": html(`<h1>A</h1><iframe id="f" src="${asLocalhost(b)}/frame"></iframe>`),
    "/embed-hop": html(`<h1>A</h1><iframe id="f" src="${asLocalhost(b)}/frame-hop"></iframe>`),
    "/embed-nested": html(`<h1>A</h1><iframe id="f" src="${asLocalhost(b)}/nested"></iframe>`),
    "/redirect": (res) => { res.writeHead(302, { location: `${c.origin}/from-popup-hop` }); res.end(); },
    "/popups": html(`<h1>A</h1>
      <button id="open-ok" onclick="window.open(location.origin + '/plain')">ok</button>
      <button id="open-bad" onclick="window.open('${c.origin}/from-popup')">bad</button>
      <button id="open-hop" onclick="window.open(location.origin + '/redirect')">hop</button>`),
    "/plain": html(`<h1>A</h1>`)
  });
  t.after(async () => { await a.close(); await b.close(); await c.close(); }, HOOK);
  return { a, b, c };
}

/** Chromium's own list of out-of-process iframe targets, read through a throwaway session. */
async function oopifTargets(session: Session): Promise<Array<{ url: string }>> {
  const cdp = await session.context.newCDPSession(session.page);
  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    return targetInfos.filter((info) => info.type === "iframe").map((info) => ({ url: info.url }));
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function assertOutOfProcess(session: Session, frameOrigin: string) {
  const targets = await oopifTargets(session);
  assert.ok(targets.some((info) => info.url.startsWith(frameOrigin)),
    `the ${frameOrigin} frame is not a separate target — it is in-process, and this test would exercise the wrong path. Targets: ${JSON.stringify(targets)}`);
}

test("OOPIF redirect: a fetch inside a cross-process iframe answered 302 to the forbidden port — zero hits, block recorded as a redirect", { timeout: 60_000 }, async (t) => {
  const { a, b, c } = await targetsScenario(t);
  const session = await open(t, { allowedHosts: allowAandB(a, b) });
  await goto(session.id, `${a.origin}/embed-hop`);
  await settle(800);

  // SEED: the frame was served, its script ran, the hop was really issued.
  assert.equal(b.hits.filter((h) => h.url === "/frame-hop").length, 1, "the iframe document was not served");
  assert.equal(b.hits.filter((h) => h.url === "/hop").length, 1, "the fetch inside the iframe was never issued");
  await assertOutOfProcess(session, asLocalhost(b));

  assert.deepEqual(c.hits, [], `the forbidden server logged a hit from inside the OOPIF: ${JSON.stringify(c.hits)}`);
  const blocked = await waitForBlock(session.id, (r) => r.url === `${c.origin}/from-oopif-hop`);
  assert.equal(blocked.kind, "redirect");
});

test("nested OOPIF: an iframe on a third site inside the cross-process iframe is guarded too", { timeout: 60_000 }, async (t) => {
  const { a, b, c } = await targetsScenario(t);
  const session = await open(t, { allowedHosts: allowAandB(a, b) });
  await goto(session.id, `${a.origin}/embed-nested`);
  await settle(1000);

  assert.equal(b.hits.filter((h) => h.url === "/nested").length, 1, "the outer iframe was not served");
  assert.equal(b.hits.filter((h) => h.url === "/frame-hop").length, 1, "the inner iframe was not served");
  assert.equal(b.hits.filter((h) => h.url === "/hop").length, 1, "the fetch inside the inner iframe was never issued");
  const targets = await oopifTargets(session);
  assert.ok(targets.some((i) => i.url.startsWith(asLocalhost(b))), `outer frame not out-of-process: ${JSON.stringify(targets)}`);
  assert.ok(targets.some((i) => i.url.startsWith(asSubLocalhost(b))), `inner frame not out-of-process: ${JSON.stringify(targets)}`);

  assert.deepEqual(c.hits, [], `the forbidden server logged a hit from inside the NESTED OOPIF: ${JSON.stringify(c.hits)}`);
  const blocked = await waitForBlock(session.id, (r) => r.url === `${c.origin}/from-oopif-hop`);
  assert.equal(blocked.kind, "redirect");
});

test("legitimate cross-process iframe: it loads, inspect sees into it, a click inside it lands and records", { timeout: 60_000 }, async (t) => {
  const { a, b } = await targetsScenario(t);
  const session = await open(t, { allowedHosts: allowAandB(a, b) });
  await goto(session.id, `${a.origin}/embed`);
  await assertOutOfProcess(session, asLocalhost(b));
  assert.equal(b.hits.filter((h) => h.url === "/frame").length, 1, "the iframe document was not served");

  const frame = session.page.frames().find((f) => f.url().startsWith(asLocalhost(b)));
  assert.ok(frame, "Playwright did not attach the cross-process frame");
  assert.equal(await frame!.locator("#inframe-btn").textContent(), "go", "the button is not in its initial state");

  const inspected = await inspectPage(session.id);
  assert.deepEqual(inspected.skippedFrames, []);
  assert.ok(inspected.elements.some((e) => e.selector === "#inframe-btn" && e.frameUrl.startsWith(asLocalhost(b))),
    `inspect did not see into the OOPIF: ${JSON.stringify(inspected.elements)}`);

  await click(session.id, "#inframe-btn", "go");
  // The EFFECT, read from the frame in a separate command.
  assert.equal(await frame!.locator("#inframe-btn").textContent(), "clicked", "the click never reached the iframe");
  const action = session.actions.at(-1)!;
  assert.equal(action.type, "click");
  assert.ok(action.x! > 0 && action.x! < 1 && action.y! > 0 && action.y! < 1, "the click recorded no viewport coordinates");
  assert.deepEqual(status(session.id).blockedRequests, []);
});

test("popup: window.open to the allowed host loads; to the forbidden host is stopped on its first request and recorded", { timeout: 60_000 }, async (t) => {
  const { a, c } = await targetsScenario(t);
  const session = await open(t, { allowedHosts: `127.0.0.1:${a.port}` });
  await goto(session.id, `${a.origin}/popups`);

  const okPopup = session.context.waitForEvent("page");
  await click(session.id, "#open-ok", "ok");
  const popup = await okPopup;
  await popup.waitForLoadState();
  assert.equal(popup.url(), `${a.origin}/plain`);
  assert.equal(a.hits.filter((h) => h.url === "/plain").length, 1, "the allowed popup was not served");
  assert.deepEqual(status(session.id).blockedRequests, []);

  // No `page` event to wait for here: Playwright reports a popup only once its
  // first navigation COMMITS (crPage `_firstNonInitialNavigationCommittedPromise`),
  // and this one is aborted before it can.
  await click(session.id, "#open-bad", "bad");
  const blocked = await waitForBlock(session.id, (r) => r.url === `${c.origin}/from-popup`);
  assert.equal(blocked.kind, "navigation");
  await settle();
  assert.deepEqual(c.hits, [], `the forbidden popup reached the server: ${JSON.stringify(c.hits)}`);
  assert.ok(session.context.pages().every((p) => !p.url().startsWith(c.origin)), "a window is showing the forbidden URL");
});

test("popup via redirect: window.open to the allowed host answering 302 to the forbidden port — zero hits, block recorded", { timeout: 60_000 }, async (t) => {
  const { a, c } = await targetsScenario(t);
  const session = await open(t, { allowedHosts: `127.0.0.1:${a.port}` });
  await goto(session.id, `${a.origin}/popups`);

  // Again no `page` event to wait for: with the hop refused, the popup's first
  // navigation never commits and Playwright never reports the window.
  await click(session.id, "#open-hop", "hop");
  const blocked = await waitForBlock(session.id, (r) => r.url === `${c.origin}/from-popup-hop`);
  assert.equal(blocked.kind, "redirect");
  await settle(800);
  assert.equal(a.hits.filter((h) => h.url === "/redirect").length, 1, "the redirecting URL was never requested");
  assert.deepEqual(c.hits, [], `the popup followed the redirect to the forbidden server: ${JSON.stringify(c.hits)}`);
  assert.ok(session.context.pages().every((p) => !p.url().startsWith(c.origin)), "a window is showing the forbidden URL");
});

test("iframe churn: after creating and destroying cross-process iframes, no target lingers and the guard still holds", { timeout: 90_000 }, async (t) => {
  const { a, b, c } = await targetsScenario(t);
  const session = await open(t, { allowedHosts: allowAandB(a, b) });
  await goto(session.id, `${a.origin}/plain`);
  assert.deepEqual(await oopifTargets(session), [], "the plain page already has an out-of-process frame");

  const embed = (src: string) => session.page.evaluate((url: string) => new Promise<void>((resolve) => {
    const frame = document.createElement("iframe");
    frame.id = "churn";
    frame.onload = () => resolve();
    frame.src = url;
    document.body.appendChild(frame);
  }), src);
  const remove = () => session.page.evaluate(() => { document.getElementById("churn")?.remove(); });

  const ROUNDS = 5;
  for (let round = 0; round < ROUNDS; round++) {
    await embed(`${asLocalhost(b)}/frame`);
    // SEED, every round: the frame really was a separate target while it lived.
    await assertOutOfProcess(session, asLocalhost(b));
    await remove();
  }
  assert.equal(b.hits.filter((h) => h.url === "/frame").length, ROUNDS, "not every iframe was served");
  // Chromium's own view: nothing lingers once the frames are gone.
  for (let waited = 0; (await oopifTargets(session)).length > 0 && waited < 4000; waited += 100) await settle(100);
  assert.deepEqual(await oopifTargets(session), [], "an iframe target outlived its element");

  // And the guard is intact for the next one.
  await embed(`${asLocalhost(b)}/frame-hop`);
  const blocked = await waitForBlock(session.id, (r) => r.url === `${c.origin}/from-oopif-hop`);
  assert.equal(blocked.kind, "redirect");
  await settle();
  assert.equal(b.hits.filter((h) => h.url === "/hop").length, 1, "the hop inside the last iframe was never issued");
  assert.deepEqual(c.hits, [], `the forbidden server was reached after churn: ${JSON.stringify(c.hits)}`);
});
