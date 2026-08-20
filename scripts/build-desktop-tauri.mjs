import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(ROOT, "desktop-tauri", "src");
const outputRoot = path.join(ROOT, "desktop-tauri", "dist");

async function build() {
  mkdirSync(outputRoot, { recursive: true });
  copyFileSync(path.join(sourceRoot, "index.html"), path.join(outputRoot, "index.html"));

  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [path.join(sourceRoot, "tauri-bridge.ts")],
    outfile: path.join(outputRoot, "tauri-bridge.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    sourcemap: false,
    logLevel: "info",
  });

  writeFileSync(
    path.join(outputRoot, ".phase-a-build.json"),
    `${JSON.stringify({ builtAt: new Date().toISOString(), phase: "A", host: "tauri-preview" }, null, 2)}\n`,
    "utf8",
  );
  console.log("desktop-tauri Phase A UI build ok");
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
