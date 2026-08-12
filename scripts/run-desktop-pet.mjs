/**
 * Launch the desktop pet under Electron after ensuring the JS bundle exists.
 *
 * Usage: node scripts/run-desktop-pet.mjs
 *        npm run desktop:dev
 *
 * Does NOT start spi. Start the service separately (npm run dev / spi --no-open).
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const MAIN_JS = path.join(ROOT, "desktop", "main", "main.js");
const PRELOAD_JS = path.join(ROOT, "desktop", "preload", "pet-preload.js");
const MAIN_TS = path.join(ROOT, "desktop", "main", "main.ts");
const PRELOAD_TS = path.join(ROOT, "desktop", "preload", "pet-preload.ts");

function isStale(outFile, srcFile) {
  if (!existsSync(outFile)) return true;
  try {
    return statSync(srcFile).mtimeMs > statSync(outFile).mtimeMs;
  } catch {
    return true;
  }
}

async function ensureBuild() {
  const need =
    process.argv.includes("--rebuild") ||
    isStale(MAIN_JS, MAIN_TS) ||
    isStale(PRELOAD_JS, PRELOAD_TS) ||
    !existsSync(MAIN_JS) ||
    !existsSync(PRELOAD_JS);

  if (!need) {
    console.log("[desktop-pet] using existing bundle");
    return;
  }

  console.log("[desktop-pet] building bundle…");
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "build-desktop-pet.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error("desktop-pet build failed");
  }
}

function resolveElectronBinary() {
  try {
    // electron package exports the binary path as the module default string.
    const electronPath = require("electron");
    if (typeof electronPath === "string" && existsSync(electronPath)) {
      return electronPath;
    }
  } catch {
    // fall through
  }
  throw new Error(
    "electron is not installed. Run: npm install  (devDependency electron should be present)",
  );
}

async function main() {
  await ensureBuild();
  if (!existsSync(MAIN_JS) || !existsSync(PRELOAD_JS)) {
    throw new Error("missing desktop bundle; run npm run desktop:build");
  }

  const electronBin = resolveElectronBinary();
  console.log("[desktop-pet] launching", electronBin);
  console.log("[desktop-pet] tip: start service first with  npm run dev  or  spi --no-open");

  const child = spawn(electronBin, [MAIN_JS], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      SNAIL_PET_MAIN: "1",
      // Helpful when debugging attach failures
      ELECTRON_DISABLE_SECURITY_WARNINGS: process.env.ELECTRON_DISABLE_SECURITY_WARNINGS ?? "true",
    },
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 0;
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
