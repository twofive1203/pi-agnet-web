import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openPathInFileManager } from "../lib/open-path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function checkInputValidation(): Promise<void> {
  const empty = await openPathInFileManager("  ");
  assert(!empty.ok && empty.error === "Path is required", "empty paths must fail before spawning an opener");

  const missingPath = join(ROOT, `missing-open-folder-${Date.now()}`);
  const missing = await openPathInFileManager(missingPath);
  assert(!missing.ok && missing.error.startsWith("Path does not exist:"), "missing paths must fail before spawning an opener");
}

function checkClientAction(): void {
  const source = readFileSync(join(ROOT, "components", "sidebar", "WorkspacePicker.tsx"), "utf8");
  assert(source.includes('fetch("/api/cwd/open"'), "workspace folder action must call POST /api/cwd/open");
  assert(
    /onClick=\{\(e\) => \{[\s\S]{0,240}void handleOpenProjectFolder\(\);[\s\S]{0,80}\}\}/.test(source),
    "open-folder menu item must use click activation so mouse, touch, and keyboard all work",
  );
  assert(source.includes('showFolderStatus(t("sidebar.openingFolder"), 0)'), "open-folder action must expose pending feedback");
  assert(source.includes("await appDialog.alert"), "open-folder failures must be visible in an application dialog");
}

function checkServerBoundary(): void {
  const route = readFileSync(join(ROOT, "app", "api", "cwd", "open", "route.ts"), "utf8");
  assert(route.includes('export const runtime = "nodejs"'), "open-folder route must run in the Node.js runtime");
  assert(route.includes("canonicalizeCwd(cwd)"), "open-folder route must canonicalize paths");
  assert(route.includes("isOpenAllowed(cwd, canonicalCwd)"), "open-folder route must authorize paths");
  assert(route.includes("openPathInFileManager(canonicalCwd)"), "open-folder route must use the shared opener");

  const opener = readFileSync(join(ROOT, "lib", "open-path.ts"), "utf8");
  assert(!/shell\s*:\s*true/.test(opener), "path opener must not use shell: true");
  assert(opener.includes('command: "explorer.exe"'), "Windows opener must use explorer.exe directly");
  assert(
    /command: "explorer\.exe",[\s\S]{0,160}windowsHide: false/.test(opener),
    "Windows Explorer must be launched visibly instead of inheriting a hidden window state",
  );
  assert(
    !opener.includes('"-WindowStyle",\n          "Hidden"'),
    "Windows opener must not create hidden Explorer windows through PowerShell",
  );
  assert(opener.includes('command: "open"'), "macOS opener must use open");
  assert(opener.includes('command: "xdg-open"'), "Linux opener must use xdg-open");
}

async function main(): Promise<void> {
  await checkInputValidation();
  checkClientAction();
  checkServerBoundary();
  console.log("open project folder smoke checks passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
