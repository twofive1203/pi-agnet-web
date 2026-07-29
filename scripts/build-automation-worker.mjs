#!/usr/bin/env node
/**
 * Build a stable standalone Automation worker artifact used by both
 * `next dev` and `next start` (and published package runtime).
 *
 * Output: lib/automation-worker-runtime.cjs
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "lib", "automation-worker-host.ts");
const outFile = join(root, "lib", "automation-worker-runtime.cjs");
const metaFile = join(root, "lib", "automation-worker-runtime.meta.json");

mkdirSync(dirname(outFile), { recursive: true });

if (!existsSync(entry)) {
  console.error(`automation worker entry missing: ${entry}`);
  process.exit(1);
}

await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // Keep the heavy SDK external; the published runtime always has node_modules.
  external: [
    "@earendil-works/*",
    "cron-parser",
  ],
  sourcemap: false,
  logLevel: "warning",
  // Worker is forked as a plain Node process; keep __dirname stable.
  banner: {
    js: '"use strict";\n',
  },
});

const bytes = readFileSync(outFile);
const sha256 = createHash("sha256").update(bytes).digest("hex");
writeFileSync(
  metaFile,
  `${JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      entry: "lib/automation-worker-host.ts",
      outfile: "lib/automation-worker-runtime.cjs",
      size: bytes.length,
      sha256,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(`automation worker built: ${outFile} (${bytes.length} bytes, sha256=${sha256.slice(0, 12)}…)`);
