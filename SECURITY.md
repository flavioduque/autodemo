# Security

DemoMotion controls a real browser and may record sensitive information.

- Never record passwords, API keys, session secrets, payment data, or private customer data.
- Values passed through `browser_fill` are redacted from `capture.json`; they can still be visible in the recorded UI.
- Run the MCP server only for trusted local MCP clients.
- Treat target websites as untrusted input.
- Prefer dedicated demo accounts and seeded demo data.
- Review the final capture before publishing.

## Network allowlist (`DEMOMOTION_ALLOWED_HOSTS`)

An agent driving this server holds a real browser. Without a boundary that
browser reaches whatever the machine reaches: `localhost:<any port>`, a cloud
metadata service at `169.254.169.254`, the internal network. The boundary is a
**strict allowlist** — never a blocklist, which always has the case nobody
enumerated (`[::ffff:127.0.0.1]` walks past every "127.0.0.0/8" check).

**Default (variable unset or empty): `localhost, 127.0.0.1, ::1`, every port.**
Everything else must be listed explicitly.

```
DEMOMOTION_ALLOWED_HOSTS=localhost,127.0.0.1,::1               # the default, spelled out
DEMOMOTION_ALLOWED_HOSTS=127.0.0.1:5173                       # one host, one port
DEMOMOTION_ALLOWED_HOSTS=staging.example.com,203.0.113.7,localhost,127.0.0.1,::1
```

| Entry | Means |
|---|---|
| `host` | that exact hostname or IP literal, on any port |
| `host:port` | that host on that one port only |
| `[::1]:8080` / `::1` | IPv6: brackets only when a port follows |

Semantics, in order of what an operator needs to know:

- **Only `http:` and `https:`.** Every other scheme is refused.
- **The decision is over addresses.** A hostname entry allows the *name*, but
  every address the name resolves to must *also* be listed as an IP entry
  (`staging.example.com` alone is not enough — add `203.0.113.7`). The refusal
  message says exactly which address to add. This is what closes DNS
  rebinding: a listed name whose answer moves to an unlisted address is refused.
- **`localhost` and `*.localhost` are loopback by definition** (RFC 6761) and
  are never sent to DNS. They need `127.0.0.1` and `::1` listed — the default
  does.
- **Names are resolved once, when the session starts,** and the browser is
  launched pinned to those answers (Chromium `--host-resolver-rules`: `MAP
  name address`); every hostname not listed, and every IP literal not listed,
  is made unresolvable in the browser's own resolver (`MAP * ~NOTFOUND` plus
  `EXCLUDE` for each listed literal). A listed name that did not resolve inside
  the allowlist at start stays closed for that session.
- **No wildcards** (`.example.com`, `*.example.com`). A wildcard names an open
  set of hosts that cannot be resolved and pinned at start, which would leave
  the browser resolving on its own — the window the pin exists to close. It is
  a configuration error, not a silent no-op.
- **Ports are enforced by request interception**, not by the resolver (Chromium's
  `EXCLUDE` has no port form).
- **IP spellings.** URL hosts are normalised by the WHATWG parser before the
  check: `127.1`, `0x7f000001`, `2130706433`, `0177.0.0.1` all become
  `127.0.0.1`. IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`, normalised to
  `[::ffff:7f00:1]`) is **its own literal**: refused unless listed in that form.
  Entries go through the same normalisation, so both sides agree.
- **Service workers are blocked** in the recording context: their fetches bypass
  request interception, so the policy could not see them.

What is enforced where — every request goes through **one** policy, at three
hooks, because no single hook sees everything:

1. Playwright `context.route("**/*")`: navigations (`browser_goto`, a click on a
   link, `window.open`), fetch/XHR, scripts, images, iframes — in every page,
   frame and worker of the context.
2. A raw CDP `Fetch` session per page: **HTTP redirect hops**, which Playwright's
   route never sees (playwright-core 1.63 auto-continues them).
3. Playwright `context.routeWebSocket("**/*")`: WebSocket handshakes.

A refused **navigation** fails the tool call with a message naming the host,
the port and the variable to set, and the page stays where it was (no
`chrome-error://` frame in the recording). A refused **sub-resource** is
aborted silently for the page (a rejected `fetch`) and recorded; `session_status`
and `session_stop` report `blockedRequests` (`kind`, `url`, `host`, `port`,
`reason`, `message`, `atMs`) so an agent can see that something was denied.

Known residual, stated precisely:

- A redirect hop that starts **inside a cross-process `<iframe>`** is seen by
  neither hook 1 (Playwright continues redirect hops itself) nor hook 2 (the
  page-level CDP session does not see that frame's requests). The resolver
  rules still stop it at **host** granularity (an unlisted host cannot
  resolve); a redirect to a listed host on an unlisted **port** from inside such
  a frame is not caught.
- Pinning is per listed name and per session; an operator who restarts the
  session re-resolves. There is no window between our lookup and the browser's
  for listed names (the browser does not look them up at all), and unlisted
  names cannot be looked up by the browser.

Report vulnerabilities privately to the repository maintainer rather than filing a public issue with exploit details.
