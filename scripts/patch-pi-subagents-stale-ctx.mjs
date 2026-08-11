/**
 * Keep pi-subagents shutdown/cleanup tolerant of Pi 0.84+ stale-ctx errors.
 * npm install rewrites node_modules, so apply this from postinstall.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));

function resolvePiSubagentsRoot() {
  try {
    return dirname(require.resolve("pi-subagents/package.json"));
  } catch {
    // package exports may not expose package.json; walk up from the entry.
  }

  try {
    let resolved = require.resolve("pi-subagents");
    while (resolved !== dirname(resolved)) {
      if (existsSync(join(resolved, "package.json"))) return resolved;
      resolved = dirname(resolved);
    }
  } catch {
    // fall through to filesystem fallback
  }

  const fallback = join(root, "node_modules", "pi-subagents");
  if (existsSync(join(fallback, "package.json"))) return fallback;
  return null;
}

const packageRoot = resolvePiSubagentsRoot();
if (!packageRoot) {
  console.log("[patch-pi-subagents-stale-ctx] pi-subagents not installed; skip");
  process.exit(0);
}

const target = join(packageRoot, "src", "extension", "index.ts");
if (!existsSync(target)) {
  console.warn(`[patch-pi-subagents-stale-ctx] missing ${target}; skip`);
  process.exit(0);
}

const source = readFileSync(target, "utf8");
const oldMatcher = `function isStaleExtensionContextError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("Extension context no longer active");
}`;

const newMatcher = `function isStaleExtensionContextError(error: unknown): boolean {
	// Pi 0.84+ uses "This extension ctx is stale..."; keep the older phrasing too.
	return error instanceof Error
		&& (error.message.includes("This extension ctx is stale")
			|| error.message.includes("extension ctx is stale")
			|| error.message.includes("Extension context no longer active"));
}`;

if (source.includes('error.message.includes("This extension ctx is stale")')) {
  console.log("[patch-pi-subagents-stale-ctx] already applied");
  process.exit(0);
}

if (!source.includes(oldMatcher)) {
  console.warn("[patch-pi-subagents-stale-ctx] expected matcher not found; package may have changed");
  process.exit(0);
}

writeFileSync(target, source.replace(oldMatcher, newMatcher), "utf8");
console.log("[patch-pi-subagents-stale-ctx] applied Pi 0.84+ stale-ctx matcher");
