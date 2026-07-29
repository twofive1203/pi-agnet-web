#!/usr/bin/env node
/**
 * Build a stable standalone Automation extension-discovery worker artifact.
 * Used by catalog discovery in both next dev and next start (never Next-bundled).
 *
 * Output: lib/automation-extension-discovery-runtime.cjs
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "lib", "automation-extension-discovery-host.ts");
const outFile = join(root, "lib", "automation-extension-discovery-runtime.cjs");
const metaFile = join(root, "lib", "automation-extension-discovery-runtime.meta.json");

mkdirSync(dirname(outFile), { recursive: true });

if (!existsSync(entry)) {
  console.error(`automation discovery worker entry missing: ${entry}`);
  process.exit(1);
}

await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // Keep heavy SDK external; discovery host only needs local runtime modules.
  external: ["@earendil-works/*", "cron-parser"],
  sourcemap: false,
  logLevel: "warning",
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
      entry: "lib/automation-extension-discovery-host.ts",
      outfile: "lib/automation-extension-discovery-runtime.cjs",
      size: bytes.length,
      sha256,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(
  `automation discovery worker built: ${outFile} (${bytes.length} bytes, sha256=${sha256.slice(0, 12)}…)`,
);
