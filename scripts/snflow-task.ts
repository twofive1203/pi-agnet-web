#!/usr/bin/env npx tsx
/**
 * Project-local SnFlow CLI wrapper.
 * Forwards to the Snail Pi Web package script (workflow-task.ts) when resolvable.
 *
 * Managed by SnFlow setup — do not hand-edit; re-run Update SnFlow instead.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

function candidates(): string[] {
  const out: string[] = [];
  const require = createRequire(path.join(process.cwd(), "package.json"));
  try {
    const pkgJson = require.resolve("@twofive/snail-pi-web/package.json");
    out.push(path.join(path.dirname(pkgJson), "scripts", "workflow-task.ts"));
  } catch {
    // package not installed in this project
  }

  // Dev monorepo / linked checkout heuristics
  const here = path.dirname(fileURLToPath(import.meta.url));
  out.push(
    path.resolve(here, "..", "node_modules", "@twofive", "snail-pi-web", "scripts", "workflow-task.ts"),
    path.resolve(here, "..", "..", "scripts", "workflow-task.ts"),
    path.resolve(here, "..", "scripts", "workflow-task.ts"),
  );

  if (process.env.SNAIL_PI_WEB_ROOT) {
    out.push(path.join(process.env.SNAIL_PI_WEB_ROOT, "scripts", "workflow-task.ts"));
  }
  return out;
}

function resolveWorkflowTask(): string | null {
  for (const candidate of candidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const target = resolveWorkflowTask();
if (!target) {
  console.error(
    [
      "snflow-task: could not resolve Snail Pi Web scripts/workflow-task.ts",
      "Install @twofive/snail-pi-web in this project, set SNAIL_PI_WEB_ROOT, or use the SnFlow panel / manual task files.",
    ].join("\n"),
  );
  process.exit(2);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", target, ...process.argv.slice(2)],
  { stdio: "inherit", cwd: process.cwd(), env: process.env },
);

process.exit(result.status ?? 1);
