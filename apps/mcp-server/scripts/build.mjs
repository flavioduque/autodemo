// Builds the publishable `autodemo` package: ONE file, dist/cli.js.
//
// The three workspace packages (@autodemo/schema, core, compositor) are pure
// TypeScript with no build of their own — they are consumed as source inside
// the monorepo. A published package cannot depend on `workspace:*` raw TS, so
// they are bundled INTO dist/cli.js here. Everything in `dependencies` stays
// external: playwright, hyperframes and gsap are located at runtime by
// `require.resolve` (the renderer copies gsap.min.js and spawns the hyperframes
// CLI), so they must remain real packages in node_modules.
//
// No `keepNames`: that is the esbuild option that injects `__name(...)` into
// functions Playwright later serialises into the page (see `inPage` in
// session-manager.ts). The helper there guards against it anyway; this keeps
// the bundle from needing the guard in the first place.
import { build } from "esbuild";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const dist = path.join(root, "dist");
const outfile = path.join(dist, "cli.js");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, "src/cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: Object.keys(pkg.dependencies).flatMap((name) => [name, `${name}/*`]),
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: false,
  legalComments: "none",
  logLevel: "info"
});
chmodSync(outfile, 0o755);

// npm ships README.md and LICENSE from the package directory when present.
// Both live at the repository root; copy them in so the npm page shows the
// real README and the tarball carries the licence. (Gitignored here.)
for (const file of ["README.md", "LICENSE"]) copyFileSync(path.join(root, "../..", file), path.join(root, file));
