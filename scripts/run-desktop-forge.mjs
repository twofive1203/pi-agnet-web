#!/usr/bin/env node
/**
 * Stable Electron Forge launcher for the pet-only desktop package.
 *
 * Forge runs from desktop/ so its private package.json is the application root;
 * the root package remains the independently published npm `spi` package.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_ROOT = path.join(ROOT, "desktop");
const FORGE_CLI = path.join(
  ROOT,
  "node_modules",
  "@electron-forge",
  "cli",
  "dist",
  "electron-forge.js",
);
const command = process.argv[2];

if (command !== "package" && command !== "make") {
  console.error("Usage: node scripts/run-desktop-forge.mjs <package|make> [forge options]");
  process.exit(2);
}
if (!existsSync(FORGE_CLI)) {
  console.error("Electron Forge is unavailable. Run npm install at the repository root first.");
  process.exit(1);
}

for (const step of [
  [process.execPath, [path.join(ROOT, "scripts", "build-desktop-pet.mjs")]],
  [process.execPath, [FORGE_CLI, command, DESKTOP_ROOT, ...process.argv.slice(3)]],
]) {
  const completed = spawnSync(step[0], step[1], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) process.exit(completed.status ?? 1);
}
