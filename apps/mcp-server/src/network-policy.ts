import dns from "node:dns/promises";
import net from "node:net";

/**
 * The network allowlist: WHERE the recorded browser may send bytes.
 *
 * Strict allowlist, never a blocklist. A blocklist always has the case nobody
 * enumerated (`::ffff:127.0.0.1` walks past every "127.0.0.0/8" check); an
 * allowlist has no such property — anything not listed is closed.
 *
 * Entries (`DEMOMOTION_ALLOWED_HOSTS`, comma-separated):
 *
 *   host            an exact hostname or IP literal, any port
 *   host:port       the same, pinned to ONE port
 *   [::1]:port      IPv6 with a port needs brackets; bare `::1` is fine without
 *
 * Default when the variable is unset or empty: `localhost, 127.0.0.1, ::1` —
 * the product's primary use case, and closed to everything else.
 *
 * Deliberately NOT supported: wildcards (`.example.com`, `*.example.com`). A
 * wildcard names an open set of hosts, none of which can be resolved and pinned
 * when the session starts, so the browser's own DNS lookup could disagree with
 * ours — the exact window this policy exists to close. List the names.
 *
 * A HOSTNAME entry allows the name, but every address the name resolves to must
 * ALSO be listed (as an IP entry). That is what makes a name entry safe against
 * rebinding: the decision is over addresses, and a name whose answer changes
 * to something unlisted is refused. `localhost` and `*.localhost` are loopback
 * by definition (RFC 6761) and are never sent to DNS, exactly as Chromium does.
 *
 * Two mechanisms rest on this class:
 *  - `check(url)` is the per-request decision, consulted by the route layer for
 *    every request the browser makes. Decisions are cached per origin so the
 *    per-request cost is a map lookup, not a DNS resolution.
 *  - `chromiumArgs()` pins each listed name in Chromium's own resolver
 *    (`--host-resolver-rules`) to the address WE resolved at session start, and
 *    closes that resolver to every host not listed — so Chromium cannot resolve
 *    a name to somewhere we never checked.
 */

export type LookupAddress = { address: string; family: 4 | 6 };
export type LookupFn = (hostname: string) => Promise<LookupAddress[]>;

export interface AllowEntry {
  /** The entry as the operator wrote it (trimmed). */
  raw: string;
  kind: "ip" | "name";
  /** Normalised: lowercase, trailing dot removed; IPs in `new URL` canonical form, no brackets. */
  host: string;
  /** Undefined = every port. */
  port?: number;
}

export type DenialReason =
  | "invalid-url"
  | "unsupported-scheme"
  | "not-listed"
  | "unresolvable"
  | "not-pinned"
  | "resolves-outside-allowlist";

export interface Allowed {
  allowed: true;
  url: string;
  host: string;
  port: number;
  /** For a hostname, what it resolved to; for a literal, the literal itself. */
  addresses: string[];
}

export interface Denied {
  allowed: false;
  url: string;
  host: string;
  port: number;
  reason: DenialReason;
  /** The message an agent reads: names the host, the variable, and what to add. */
  message: string;
}

export type Decision = Allowed | Denied;

export const DEFAULT_ALLOWED_HOSTS = "localhost,127.0.0.1,::1";
export const ENV_VAR = "DEMOMOTION_ALLOWED_HOSTS";

const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1"];

function configError(entry: string, why: string): Error {
  return new Error(`${ENV_VAR} entry ${JSON.stringify(entry)} is not valid: ${why}. Entries are "host" or "host:port" (IPv6 with a port as "[::1]:port"), separated by commas.`);
}

/** `localhost` and anything under it: loopback without DNS (RFC 6761 §6.3). */
export function isLocalhostName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost");
}

/**
 * Parses one entry. The host part goes through `new URL` so an entry is
 * normalised exactly the way a URL's host is normalised at check time —
 * `127.1`, `0x7f000001` and `2130706433` all become `127.0.0.1`, IPv6 becomes
 * its compressed lowercase form. The port is taken off BEFORE that, because the
 * URL parser drops a default port (`127.0.0.1:80` would otherwise read as "any").
 */
function parseEntry(raw: string): AllowEntry {
  if (raw.startsWith(".") || raw.includes("*")) throw configError(raw, "wildcards are not supported; list each hostname");
  if (raw.includes("/") || raw.includes("?") || raw.includes("#") || raw.includes("@")) throw configError(raw, "only a host and an optional port are allowed");

  let hostPart = raw;
  let port: number | undefined;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw);
  if (bracketed) {
    hostPart = `[${bracketed[1]}]`;
    if (bracketed[2] !== undefined) port = Number(bracketed[2]);
  } else if (raw.includes(":") && raw.indexOf(":") !== raw.lastIndexOf(":")) {
    // Bare IPv6 (`::1`): no port possible without brackets.
    hostPart = `[${raw}]`;
  } else {
    const withPort = /^([^:]+):(.*)$/.exec(raw);
    if (withPort) {
      hostPart = withPort[1];
      if (!/^\d{1,5}$/.test(withPort[2])) throw configError(raw, `port ${JSON.stringify(withPort[2])} is not a number`);
      port = Number(withPort[2]);
    }
  }
  if (port !== undefined && (port < 1 || port > 65535)) throw configError(raw, `port ${port} is out of range`);

  let parsed: URL;
  try {
    parsed = new URL(`http://${hostPart}/`);
  } catch {
    throw configError(raw, "not a valid hostname or IP literal");
  }
  if (parsed.username || parsed.pathname !== "/" || parsed.search || parsed.hash) throw configError(raw, "only a host and an optional port are allowed");

  const host = normaliseHost(parsed.hostname);
  return { raw, kind: net.isIP(host) ? "ip" : "name", host, port };
}

/** Lowercase, trailing dot off, IPv6 brackets off. */
function normaliseHost(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  while (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

/** How a host is spelled in a message: bare, unless a port follows an IPv6 literal (then brackets, as in a URL). */
function displayHost(host: string, port?: number): string {
  const spelled = port !== undefined && net.isIP(host) === 6 ? `[${host}]` : host;
  return port === undefined ? spelled : `${spelled}:${port}`;
}

/** A host as it appears inside a URL: IPv6 in brackets. */
function urlHost(host: string): string {
  return net.isIP(host) === 6 ? `[${host}]` : host;
}

export function parseAllowedHosts(raw: string): AllowEntry[] {
  return raw.split(",").map((v) => v.trim()).filter(Boolean).map(parseEntry);
}

function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  return dns.lookup(hostname, { all: true }) as Promise<LookupAddress[]>;
}

export interface NetworkPolicyOptions {
  /** The raw variable value; `undefined` or blank means the default. */
  allowedHosts?: string | undefined;
  /** Injected for tests; defaults to `dns.lookup(host, { all: true })`. */
  lookup?: LookupFn;
}

export class NetworkPolicy {
  readonly entries: AllowEntry[];
  readonly source: "default" | "env";
  private readonly lookup: LookupFn;
  /** Per ORIGIN (scheme + host + port): the part of a decision that does not depend on the path. */
  private readonly decisions = new Map<string, Promise<CoreDecision>>();
  /** Listed hostname -> the ONE address Chromium is pinned to for this session. */
  private readonly pins = new Map<string, string>();
  private prepared = false;

  constructor(opts: NetworkPolicyOptions = {}) {
    const raw = opts.allowedHosts?.trim() ?? "";
    const entries = raw ? parseAllowedHosts(raw) : [];
    this.source = entries.length ? "env" : "default";
    this.entries = entries.length ? entries : parseAllowedHosts(DEFAULT_ALLOWED_HOSTS);
    this.lookup = opts.lookup ?? defaultLookup;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, lookup?: LookupFn): NetworkPolicy {
    return new NetworkPolicy({ allowedHosts: env[ENV_VAR], lookup });
  }

  /** The allowlist as a human reads it, for messages and `session_status`. */
  describe(): string {
    return this.entries.map((e) => displayHost(e.host, e.port)).join(", ");
  }

  /**
   * Resolves every listed hostname ONCE, before the browser is launched, and
   * remembers the address to pin it to. A name whose answer is not fully inside
   * the allowlist, or that does not resolve, is left unpinned — and stays
   * closed for the session (`not-pinned`), because an unpinned name is one the
   * browser would resolve on its own.
   */
  async prepare(): Promise<void> {
    if (this.prepared) return;
    this.prepared = true;
    for (const entry of this.entries) {
      if (entry.kind !== "name" || isLocalhostName(entry.host)) continue;
      let addresses: LookupAddress[];
      try {
        addresses = await this.lookup(entry.host);
      } catch {
        continue;
      }
      if (!addresses.length) continue;
      const bad = addresses.find((a) => !this.ipEntryFor(normaliseHost(a.address)));
      if (bad) continue;
      const preferred = addresses.find((a) => a.family === 4) ?? addresses[0];
      this.pins.set(entry.host, normaliseHost(preferred.address));
    }
  }

  /**
   * Chromium launch flags that make its resolver agree with this policy:
   * every pinned name maps to the address we resolved (first matching MAP
   * wins, so the pins come before the catch-all), everything else is
   * unresolvable, and listed literals plus localhost-family names are excluded
   * from the catch-all. IPv6 literals go in bare: Chromium's EXCLUDE does not
   * parse brackets.
   */
  chromiumArgs(): string[] {
    const rules: string[] = [];
    for (const [name, address] of this.pins) rules.push(`MAP ${name} ${address}`);
    rules.push("MAP * ~NOTFOUND");
    const excluded = new Set<string>();
    for (const entry of this.entries) {
      if (entry.kind === "name" && !isLocalhostName(entry.host)) continue;
      if (excluded.has(entry.host)) continue;
      excluded.add(entry.host);
      rules.push(`EXCLUDE ${entry.host}`);
    }
    return [`--host-resolver-rules=${rules.join(", ")}`];
  }

  /**
   * The decision for a URL. Cached per origin (scheme + host + port), so the
   * per-request cost on a hot path is a map lookup and one small allocation:
   * only the URL and the message differ between two requests to one origin.
   */
  check(url: string): Promise<Decision> {
    const parsed = parseUrl(url);
    if (!parsed.ok) return Promise.resolve(parsed.denial);
    let core = this.decisions.get(parsed.origin);
    if (!core) {
      core = this.decide(parsed);
      this.decisions.set(parsed.origin, core);
      core.then((decision) => {
        // A resolver hiccup must not close an origin for the whole session.
        if (!decision.allowed && decision.reason === "unresolvable") this.decisions.delete(parsed.origin);
      }, () => this.decisions.delete(parsed.origin));
    }
    return core.then((decision) => this.materialise(decision, parsed));
  }

  private materialise(core: CoreDecision, target: ParsedTarget): Decision {
    if (core.allowed) return { allowed: true, url: target.url, host: target.host, port: target.port, addresses: core.addresses };
    const current = `currently ${this.describe()}${this.source === "default" ? " — the default" : ""}`;
    const fix = core.toAdd
      ? ` To allow it, set ${ENV_VAR} to include ${JSON.stringify(core.toAdd)} and start a new session.`
      : "";
    return {
      allowed: false,
      url: target.url,
      host: urlHost(target.host),
      port: target.port,
      reason: core.reason,
      message: `DemoMotion refused ${target.url}: ${core.why} (${current}).${fix}`
    };
  }

  private async decide(target: ParsedTarget): Promise<CoreDecision> {
    const { host, port } = target;
    const hostPort = displayHost(host, port);

    if (net.isIP(host)) {
      if (this.ipEntryFor(host, port)) return { allowed: true, addresses: [host] };
      return this.deny("not-listed", `${JSON.stringify(hostPort)} is not in ${ENV_VAR}`, hostPort);
    }

    if (!this.nameEntryFor(host, port)) {
      return this.deny("not-listed", `${JSON.stringify(hostPort)} is not in ${ENV_VAR}`, hostPort);
    }

    let addresses: string[];
    if (isLocalhostName(host)) {
      addresses = LOOPBACK_ADDRESSES;
    } else {
      let resolved: LookupAddress[];
      try {
        resolved = await this.lookup(host);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
        return this.deny("unresolvable", `${JSON.stringify(host)} is listed but could not be resolved (${code})`);
      }
      addresses = resolved.map((a) => normaliseHost(a.address));
      if (!addresses.length) return this.deny("unresolvable", `${JSON.stringify(host)} is listed but resolved to no address`);
    }

    const outside = addresses.filter((a) => !this.ipEntryFor(a, port));
    if (outside.length) {
      const first = displayHost(outside[0], port);
      return this.deny(
        "resolves-outside-allowlist",
        `${JSON.stringify(host)} is listed but resolves to ${addresses.map((a) => displayHost(a)).join(", ")}, and ${JSON.stringify(first)} is not in ${ENV_VAR}`,
        outside.map((a) => displayHost(a, port)).join(",")
      );
    }
    if (!isLocalhostName(host) && !this.pins.has(host)) {
      // Resolves inside the allowlist NOW, but did not when the browser was
      // launched: Chromium holds no pin for it and would resolve it on its own.
      return this.deny(
        "not-pinned",
        `${JSON.stringify(host)} did not resolve inside the allowlist when this session started, so the browser was not pinned to it; start a new session once it resolves`
      );
    }
    return { allowed: true, addresses };
  }

  private deny(reason: DenialReason, why: string, toAdd?: string): CoreDecision {
    return { allowed: false, reason, why, toAdd };
  }

  private ipEntryFor(address: string, port?: number): AllowEntry | undefined {
    return this.entries.find((e) => e.kind === "ip" && e.host === address && (e.port === undefined || port === undefined || e.port === port));
  }

  private nameEntryFor(name: string, port: number): AllowEntry | undefined {
    return this.entries.find((e) => e.kind === "name" && e.host === name && (e.port === undefined || e.port === port));
  }
}

/** What is cached per origin: everything about a decision except the URL it is for. */
type CoreDecision =
  | { allowed: true; addresses: string[] }
  | { allowed: false; reason: DenialReason; why: string; toAdd?: string };

interface ParsedTarget { ok: true; url: string; origin: string; host: string; port: number }
type ParseResult = ParsedTarget | { ok: false; origin?: undefined; denial: Denied };

function parseUrl(raw: string): ParseResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, denial: { allowed: false, url: raw, host: "", port: 0, reason: "invalid-url", message: `DemoMotion refused ${JSON.stringify(raw)}: not a valid URL.` } };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      denial: { allowed: false, url: raw, host: url.hostname, port: 0, reason: "unsupported-scheme", message: `DemoMotion refused ${raw}: only http: and https: URLs can be opened (got ${url.protocol}).` }
    };
  }
  const host = normaliseHost(url.hostname);
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { ok: true, url: url.toString(), origin: `${url.protocol}//${host}:${port}`, host, port };
}
