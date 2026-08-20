import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererRoot = path.join(ROOT, "desktop", "renderer");
const sourceRoot = path.join(ROOT, "desktop-tauri", "src");
const outputRoot = path.join(ROOT, "desktop-tauri", "dist");
const OUTPUT_ALLOWLIST = new Set([
  ".phase-b-build.json",
  "index.html",
  "pet-app.js",
  "pet.css",
  "tauri-bridge.js",
]);

function injectBridge(html) {
  if (html.includes("tauri-bridge.js")) return html;
  if (!html.includes("./pet-app.js")) {
    throw new Error("desktop/renderer/index.html must load ./pet-app.js");
  }
  return html.replace(
    '<script src="./pet-app.js"></script>',
    '<script src="./tauri-bridge.js"></script>\n    <script src="./pet-app.js"></script>',
  );
}

function assertCleanOutput() {
  const entries = readdirSync(outputRoot).sort();
  for (const entry of entries) {
    const fullPath = path.join(outputRoot, entry);
    if (statSync(fullPath).isDirectory() || !OUTPUT_ALLOWLIST.has(entry) || entry.endsWith(".map")) {
      throw new Error(`desktop-tauri/dist contains unexpected build output: ${entry}`);
    }
  }
  const missing = [...OUTPUT_ALLOWLIST].filter((entry) => !entries.includes(entry));
  if (missing.length > 0) {
    throw new Error(`desktop-tauri/dist is missing expected output: ${missing.join(", ")}`);
  }
}

async function build() {
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });

  const rendererHtml = readFileSync(path.join(rendererRoot, "index.html"), "utf8");
  writeFileSync(path.join(outputRoot, "index.html"), injectBridge(rendererHtml), "utf8");
  copyFileSync(path.join(rendererRoot, "pet.css"), path.join(outputRoot, "pet.css"));

  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [path.join(rendererRoot, "pet-app.tsx")],
    outfile: path.join(outputRoot, "pet-app.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    sourcemap: false,
    loader: { ".png": "dataurl", ".webp": "dataurl" },
    logLevel: "info",
  });

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
    path.join(outputRoot, ".phase-b-build.json"),
    `${JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        phase: "B",
        host: "tauri-preview",
        renderer: "desktop/renderer",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  assertCleanOutput();
  console.log("desktop-tauri Phase B renderer+bridge clean build ok");
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
