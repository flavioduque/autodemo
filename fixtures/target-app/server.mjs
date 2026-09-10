// Zero-dependency static server for the fixture target app.
// Fixed port 4321 (override with FIXTURE_PORT) so recorded demos stay reproducible.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.FIXTURE_PORT ?? 4321);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

/**
 * Named routes.
 *
 * `/` is the bare CRM. `/embedded` is the SAME CRM one frame deeper: a host
 * document whose only own content is a cookie banner, with the product inside a
 * full-viewport <iframe>. That is the shape of the real site that showed the
 * tooling was blind to iframe content.
 */
const ROUTES = {
  "/": "index.html",
  "/embedded": "embedded.html",
  "/embedded/": "embedded.html"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const rel = ROUTES[url.pathname] ?? (url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, "index.html")) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const body = await fs.readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store"
    }).end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fixture target-app on http://127.0.0.1:${PORT}`);
});
