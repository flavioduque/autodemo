import test from "node:test";
import assert from "node:assert/strict";
import { NetworkPolicy, parseAllowedHosts, type LookupFn } from "../src/network-policy.ts";

// ---------------------------------------------------------------------------
// The allowlist decision, on its own, with NO browser and NO socket. The DNS
// resolver is injected so every test is offline and every resolution is a
// literal the test wrote down — never what the host's resolver happens to say.
//
// Every test has both halves: the thing that must be refused AND the neighbour
// that must keep working. A policy that refuses everything passes the first
// half of every test here and fails the second.
// ---------------------------------------------------------------------------

/** A resolver that answers from a table and counts its calls. */
function tableLookup(table: Record<string, Array<{ address: string; family: 4 | 6 }>>) {
  const calls: string[] = [];
  const lookup: LookupFn = async (hostname) => {
    calls.push(hostname);
    const hit = table[hostname];
    if (!hit) { const e = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as NodeJS.ErrnoException; e.code = "ENOTFOUND"; throw e; }
    return hit;
  };
  return { lookup, calls };
}

/** A resolver that must never be consulted: literals and localhost need no DNS. */
function forbiddenLookup(): LookupFn {
  return async (hostname) => { throw new Error(`lookup must not be called, but was called for ${hostname}`); };
}

async function denial(policy: NetworkPolicy, url: string) {
  const d = await policy.check(url);
  assert.equal(d.allowed, false, `${url} should be refused, was allowed`);
  return d as Extract<typeof d, { allowed: false }>;
}

async function grant(policy: NetworkPolicy, url: string) {
  const d = await policy.check(url);
  assert.equal(d.allowed, true, `${url} should be allowed, was refused: ${d.allowed ? "" : d.message}`);
  return d as Extract<typeof d, { allowed: true }>;
}

// ---------------------------------------------------------------------------
// Default
// ---------------------------------------------------------------------------

test("default (variable unset): loopback only, and a metadata address is refused before any socket", async () => {
  const policy = new NetworkPolicy({ allowedHosts: undefined, lookup: forbiddenLookup() });
  await policy.prepare();
  assert.equal(policy.describe(), "localhost, 127.0.0.1, ::1");
  assert.equal(policy.source, "default");

  // Positive half: the product's primary use case works with nothing configured.
  const ok = await grant(policy, "http://127.0.0.1:5173/app?x=1");
  assert.equal(ok.host, "127.0.0.1");
  assert.equal(ok.port, 5173);
  await grant(policy, "http://localhost:3000/");
  await grant(policy, "http://[::1]:3000/");
  await grant(policy, "https://localhost/");

  // Negative half: the cloud metadata address. `forbiddenLookup` throws if the
  // policy even tries to resolve, so the refusal is decided on the literal alone.
  const d = await denial(policy, "http://169.254.169.254/latest/meta-data/");
  assert.equal(d.reason, "not-listed");
  assert.match(d.message, /169\.254\.169\.254/);
  assert.match(d.message, /DEMOMOTION_ALLOWED_HOSTS/);
  assert.match(d.message, /localhost, 127\.0\.0\.1, ::1/, "the message shows the current allowlist");
});

test("an empty DEMOMOTION_ALLOWED_HOSTS is the default, never allow-all", async () => {
  for (const raw of ["", "  ", ",,"]) {
    const policy = new NetworkPolicy({ allowedHosts: raw, lookup: forbiddenLookup() });
    assert.equal(policy.source, "default", `raw=${JSON.stringify(raw)}`);
    await denial(policy, "http://169.254.169.254/");
    await grant(policy, "http://127.0.0.1/");
  }
});

test("only http: and https: are ever allowed", async () => {
  const policy = new NetworkPolicy({ allowedHosts: undefined, lookup: forbiddenLookup() });
  await grant(policy, "https://127.0.0.1/");
  for (const url of ["ftp://127.0.0.1/", "file:///etc/passwd", "ws://127.0.0.1/", "javascript:alert(1)", "data:text/html,hi"]) {
    const d = await denial(policy, url);
    assert.equal(d.reason, "unsupported-scheme", url);
  }
  const d = await denial(policy, "not a url at all");
  assert.equal(d.reason, "invalid-url");
});

// ---------------------------------------------------------------------------
// Port pinning
// ---------------------------------------------------------------------------

test("host:port pins the port; a bare host allows every port", async () => {
  const pinned = new NetworkPolicy({ allowedHosts: "127.0.0.1:3000", lookup: forbiddenLookup() });
  await grant(pinned, "http://127.0.0.1:3000/");
  assert.equal((await denial(pinned, "http://127.0.0.1:3001/")).reason, "not-listed");
  assert.equal((await denial(pinned, "http://127.0.0.1/")).reason, "not-listed", "port 80 is not port 3000");
  assert.match((await denial(pinned, "http://127.0.0.1:3001/")).message, /127\.0\.0\.1:3001/, "the refusal names host AND port");

  const open = new NetworkPolicy({ allowedHosts: "127.0.0.1", lookup: forbiddenLookup() });
  await grant(open, "http://127.0.0.1:3000/");
  await grant(open, "http://127.0.0.1:3001/");
  await grant(open, "https://127.0.0.1/");
  assert.equal((await grant(open, "https://127.0.0.1/")).port, 443, "https defaults to 443");
});

// ---------------------------------------------------------------------------
// Address normalisation traps — what `new URL()` does on this Node, pinned down
// ---------------------------------------------------------------------------

test("IPv4 shorthand forms fold to 127.0.0.1 before the check, so the PORT decides", async () => {
  const policy = new NetworkPolicy({ allowedHosts: "127.0.0.1:3000", lookup: forbiddenLookup() });
  // Node 26's WHATWG URL parser normalises every one of these to 127.0.0.1.
  // That is stated, not assumed: the decision reports the folded host.
  for (const literal of ["127.1", "0x7f000001", "2130706433", "0177.0.0.1", "127.000.000.001"]) {
    const ok = await grant(policy, `http://${literal}:3000/`);
    assert.equal(ok.host, "127.0.0.1", `${literal} folds to 127.0.0.1`);
    const d = await denial(policy, `http://${literal}:3001/`);
    assert.equal(d.host, "127.0.0.1", `${literal}:3001 is refused AS 127.0.0.1:3001`);
    assert.match(d.message, /127\.0\.0\.1:3001/);
  }
});

test("IPv4-mapped IPv6 is its own literal: refused unless listed in that form", async () => {
  const policy = new NetworkPolicy({ allowedHosts: "127.0.0.1:3000", lookup: forbiddenLookup() });
  // `new URL` rewrites [::ffff:127.0.0.1] to [::ffff:7f00:1]; neither is 127.0.0.1.
  const d = await denial(policy, "http://[::ffff:127.0.0.1]:3000/");
  assert.equal(d.host, "[::ffff:7f00:1]");
  assert.equal(d.reason, "not-listed");
  await denial(policy, "http://[::ffff:7f00:1]:3000/");

  // Positive half: an operator who really means it lists it, in either spelling.
  const listed = new NetworkPolicy({ allowedHosts: "[::ffff:127.0.0.1]:3000", lookup: forbiddenLookup() });
  await grant(listed, "http://[::ffff:127.0.0.1]:3000/");
  await grant(listed, "http://[::ffff:7f00:1]:3000/");
  await denial(listed, "http://127.0.0.1:3000/");
});

test("IPv6 literals compare in their normalised form", async () => {
  const policy = new NetworkPolicy({ allowedHosts: "::1", lookup: forbiddenLookup() });
  await grant(policy, "http://[::1]:3000/");
  await grant(policy, "http://[0:0:0:0:0:0:0:1]:3000/");
  await grant(policy, "http://[0000:0000:0000:0000:0000:0000:0000:0001]/");
  await denial(policy, "http://[::2]/");
  await denial(policy, "http://127.0.0.1/");
});

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

test("a listed name is refused when it resolves to an address outside the allowlist", async () => {
  const bad = tableLookup({ "demo.invalid": [{ address: "169.254.169.254", family: 4 }] });
  const policy = new NetworkPolicy({ allowedHosts: "demo.invalid,127.0.0.1", lookup: bad.lookup });
  await policy.prepare();
  const d = await denial(policy, "http://demo.invalid/");
  assert.equal(d.reason, "resolves-outside-allowlist");
  assert.match(d.message, /demo\.invalid/);
  assert.match(d.message, /169\.254\.169\.254/);
  assert.match(d.message, /DEMOMOTION_ALLOWED_HOSTS/);
  assert.ok(bad.calls.includes("demo.invalid"), "the resolver was really consulted");
});

test("the same name resolving to an allowed address passes, and DNS happens once per origin", async () => {
  const good = tableLookup({ "demo.invalid": [{ address: "127.0.0.1", family: 4 }] });
  const policy = new NetworkPolicy({ allowedHosts: "demo.invalid,127.0.0.1", lookup: good.lookup });
  await policy.prepare();
  const callsAfterPrepare = good.calls.length;
  const ok = await grant(policy, "http://demo.invalid/");
  assert.deepEqual(ok.addresses, ["127.0.0.1"]);
  assert.equal(good.calls.length, callsAfterPrepare + 1, "one lookup for the first check");
  await grant(policy, "http://demo.invalid/other");
  await grant(policy, "http://demo.invalid/third?x");
  assert.equal(good.calls.length, callsAfterPrepare + 1, "same origin: served from the decision cache");
  await grant(policy, "http://demo.invalid:8080/");
  assert.equal(good.calls.length, callsAfterPrepare + 2, "another port is another origin");
});

test("the per-origin cache hands back each request's OWN url and message, not the first one it saw", async () => {
  // Regression: the first version cached whole decisions per origin, so the
  // second goto on an origin navigated to the FIRST path checked there.
  const policy = new NetworkPolicy({ allowedHosts: "127.0.0.1:3000", lookup: forbiddenLookup() });
  const first = await grant(policy, "http://127.0.0.1:3000/plain");
  const second = await grant(policy, "http://127.0.0.1:3000/redirect?x=1");
  assert.equal(first.url, "http://127.0.0.1:3000/plain");
  assert.equal(second.url, "http://127.0.0.1:3000/redirect?x=1");
  const d1 = await denial(policy, "http://127.0.0.1:3001/one");
  const d2 = await denial(policy, "http://127.0.0.1:3001/two");
  assert.equal(d1.url, "http://127.0.0.1:3001/one");
  assert.equal(d2.url, "http://127.0.0.1:3001/two");
  assert.match(d2.message, /\/two/);
  assert.doesNotMatch(d2.message, /\/one/);
});

test("EVERY resolved address must be allowed, not just one", async () => {
  const mixed = tableLookup({ "demo.invalid": [{ address: "127.0.0.1", family: 4 }, { address: "10.0.0.9", family: 4 }] });
  const policy = new NetworkPolicy({ allowedHosts: "demo.invalid,127.0.0.1", lookup: mixed.lookup });
  await policy.prepare();
  const d = await denial(policy, "http://demo.invalid/");
  assert.equal(d.reason, "resolves-outside-allowlist");
  assert.match(d.message, /10\.0\.0\.9/, "names the offending address");
});

test("rebinding: a name that resolved inside the allowlist at session start is refused when it later resolves outside", async () => {
  let answer = [{ address: "127.0.0.1", family: 4 as const }];
  const calls: string[] = [];
  const lookup: LookupFn = async (h) => { calls.push(h); return answer; };
  const policy = new NetworkPolicy({ allowedHosts: "demo.invalid,127.0.0.1", lookup });
  await policy.prepare();
  assert.ok(calls.length >= 1, "prepare resolved the listed name");
  answer = [{ address: "169.254.169.254", family: 4 }];
  const d = await denial(policy, "http://demo.invalid/");
  assert.equal(d.reason, "resolves-outside-allowlist");
});

test("a name that is not listed is refused without consulting DNS at all", async () => {
  const spy = tableLookup({ "evil.invalid": [{ address: "127.0.0.1", family: 4 }] });
  const policy = new NetworkPolicy({ allowedHosts: undefined, lookup: spy.lookup });
  await policy.prepare();
  const d = await denial(policy, "http://evil.invalid/");
  assert.equal(d.reason, "not-listed");
  assert.deepEqual(spy.calls, [], "resolving to an allowed address does not make an unlisted name allowed");
});

test("a name that cannot be resolved is refused, and the failure is not cached", async () => {
  const spy = tableLookup({});
  const policy = new NetworkPolicy({ allowedHosts: "demo.invalid,127.0.0.1", lookup: spy.lookup });
  await policy.prepare();
  const before = spy.calls.length;
  const d = await denial(policy, "http://demo.invalid/");
  assert.equal(d.reason, "unresolvable");
  assert.match(d.message, /demo\.invalid/);
  await denial(policy, "http://demo.invalid/");
  assert.equal(spy.calls.length, before + 2, "a transient failure is retried on the next check");
});

test("a name that did not resolve when the session started stays closed even if it resolves later", async () => {
  const table: Record<string, Array<{ address: string; family: 4 }>> = {};
  const spy = tableLookup(table);
  const policy = new NetworkPolicy({ allowedHosts: "demo.invalid,127.0.0.1", lookup: spy.lookup });
  await policy.prepare();
  table["demo.invalid"] = [{ address: "127.0.0.1", family: 4 }];
  const d = await denial(policy, "http://demo.invalid/");
  assert.equal(d.reason, "not-pinned");
  assert.match(d.message, /new session/);
});

test("a name entry with a port: the port applies to the name and to its addresses", async () => {
  const good = tableLookup({ "demo.invalid": [{ address: "127.0.0.1", family: 4 }] });
  const policy = new NetworkPolicy({ allowedHosts: "demo.invalid:3000,127.0.0.1:3000", lookup: good.lookup });
  await policy.prepare();
  await grant(policy, "http://demo.invalid:3000/");
  assert.equal((await denial(policy, "http://demo.invalid:3001/")).reason, "not-listed");

  // The address side: name allowed on any port, but the address only on 3000.
  const narrow = new NetworkPolicy({ allowedHosts: "demo.invalid,127.0.0.1:3000", lookup: good.lookup });
  await narrow.prepare();
  await grant(narrow, "http://demo.invalid:3000/");
  const d = await denial(narrow, "http://demo.invalid:3001/");
  assert.equal(d.reason, "resolves-outside-allowlist");
  assert.match(d.message, /127\.0\.0\.1:3001/);
});

test("localhost and *.localhost are loopback by definition (RFC 6761): no DNS, both loopback addresses must be listed", async () => {
  const policy = new NetworkPolicy({ allowedHosts: "app.localhost,127.0.0.1,::1", lookup: forbiddenLookup() });
  await policy.prepare();
  const ok = await grant(policy, "http://app.localhost:3000/");
  assert.deepEqual([...ok.addresses].sort(), ["127.0.0.1", "::1"]);

  const v4only = new NetworkPolicy({ allowedHosts: "localhost,127.0.0.1", lookup: forbiddenLookup() });
  await v4only.prepare();
  const d = await denial(v4only, "http://localhost:3000/");
  assert.equal(d.reason, "resolves-outside-allowlist");
  assert.match(d.message, /::1/, "says which loopback address is missing");
});

// ---------------------------------------------------------------------------
// Chromium resolver rules (the pin)
// ---------------------------------------------------------------------------

test("chromium args pin every listed name to the address it resolved to and close the resolver to everything else", async () => {
  const table = tableLookup({
    "demo.invalid": [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }],
    "gone.invalid": []
  });
  const policy = new NetworkPolicy({ allowedHosts: "demo.invalid, 127.0.0.1, ::1, localhost, [::ffff:127.0.0.1]:3000", lookup: table.lookup });
  await policy.prepare();
  const args = policy.chromiumArgs();
  assert.equal(args.length, 1);
  const rules = args[0].replace(/^--host-resolver-rules=/, "");
  const parts = rules.split(",").map((p) => p.trim());
  // The pin prefers IPv4 (Chromium's MAP takes ONE replacement); it comes BEFORE
  // the catch-all, because the first matching MAP wins.
  assert.equal(parts[0], "MAP demo.invalid 127.0.0.1");
  assert.equal(parts[1], "MAP * ~NOTFOUND");
  // Literals and localhost-family names are excluded from the catch-all.
  // IPv6 is written bare: Chromium's EXCLUDE does not understand brackets.
  assert.ok(parts.includes("EXCLUDE 127.0.0.1"), rules);
  assert.ok(parts.includes("EXCLUDE ::1"), rules);
  assert.ok(parts.includes("EXCLUDE localhost"), rules);
  assert.ok(parts.includes("EXCLUDE ::ffff:7f00:1"), rules);
  // A pinned name is NOT excluded (an exclusion would skip its MAP).
  assert.ok(!parts.includes("EXCLUDE demo.invalid"), rules);
});

test("a listed name that resolves outside the allowlist at session start is not pinned", async () => {
  const table = tableLookup({ "demo.invalid": [{ address: "169.254.169.254", family: 4 }] });
  const policy = new NetworkPolicy({ allowedHosts: "demo.invalid,127.0.0.1", lookup: table.lookup });
  await policy.prepare();
  const rules = policy.chromiumArgs()[0];
  assert.doesNotMatch(rules, /MAP demo\.invalid/);
  assert.match(rules, /MAP \* ~NOTFOUND/);
});

// ---------------------------------------------------------------------------
// Entry syntax
// ---------------------------------------------------------------------------

test("entry syntax: host, host:port, bare or bracketed IPv6, case and trailing dot folded, blanks ignored", () => {
  const entries = parseAllowedHosts(" LOCALHOST. , 127.0.0.1:3000 ,, ::1 , [::1]:8080 , Example.COM:443 , [::ffff:127.0.0.1] ");
  assert.deepEqual(entries.map((e) => `${e.kind} ${e.host}${e.port === undefined ? "" : ":" + e.port}`), [
    "name localhost",
    "ip 127.0.0.1:3000",
    "ip ::1",
    "ip ::1:8080",
    "name example.com:443",
    "ip ::ffff:7f00:1"
  ]);
});

test("entry syntax: wildcards, paths, credentials and bad ports are configuration errors, not silent no-ops", () => {
  for (const bad of [".example.com", "*.example.com", "host/path", "user@host", "host:abc", "host:99999", "http://host", "host?x=1", "host:0"]) {
    assert.throws(() => parseAllowedHosts(bad), /DEMOMOTION_ALLOWED_HOSTS/, `entry ${JSON.stringify(bad)} must be rejected`);
  }
  // Positive half: the message says which entry and why, and a sound list next to it still parses.
  assert.throws(() => parseAllowedHosts("127.0.0.1, .example.com"), /"\.example\.com"/);
  assert.equal(parseAllowedHosts("127.0.0.1, example.com").length, 2);
});
