// Zero-dependency static server for the showcase fixture.
// Fixed port 4322 (override with SHOWCASE_PORT) so it never collides with the
// target-app fixture on 4321.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SHOWCASE_PORT ?? 4322);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

/** Named routes. `/` is the landing page, `/signup` the account flow. */
const ROUTES = {
  "/": "index.html",
  "/signup": "signup.html",
  "/signup/": "signup.html"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const rel = ROUTES[url.pathname] ?? url.pathname.slice(1);
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) {
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
  console.log(`fixture showcase-app on http://127.0.0.1:${PORT}`);
});
