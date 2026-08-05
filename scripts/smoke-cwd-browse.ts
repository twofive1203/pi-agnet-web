import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browseCwdDirectory, CwdBrowseError, listBrowseRoots } from "../lib/cwd-browse";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function checkRoots(): void {
  const roots = listBrowseRoots();
  assert(roots.length >= 1, "browse roots must include at least Home");
  assert(roots.some((entry) => entry.name === "Home"), "browse roots must expose Home");
  if (process.platform === "win32") {
    assert(roots.some((entry) => /^[A-Z]:$/.test(entry.name)), "Windows roots must include a drive letter");
  } else {
    assert(roots.some((entry) => entry.path === "/"), "POSIX roots must include /");
  }
}

function checkBrowseDirectories(): void {
  const base = mkdtempSync(join(tmpdir(), "pi-cwd-browse-"));
  try {
    const childA = join(base, "alpha-dir");
    const childB = join(base, "beta-dir");
    mkdirSync(childA);
    mkdirSync(childB);
    writeFileSync(join(base, "note.txt"), "not a directory");

    const listed = browseCwdDirectory(base);
    assert(listed.path.length > 0, "browse must return a canonical path");
    assert(listed.entries.some((entry) => entry.name === "alpha-dir"), "browse must list child directories");
    assert(listed.entries.some((entry) => entry.name === "beta-dir"), "browse must list all child directories");
    assert(!listed.entries.some((entry) => entry.name === "note.txt"), "browse must not list files");

    const rootsView = browseCwdDirectory("");
    assert(rootsView.path === "", "empty path must open roots view");
    assert(rootsView.parent === null, "roots view has no parent");
    assert(rootsView.entries.length >= 1, "roots view must return entries");

    let missingFailed = false;
    try {
      browseCwdDirectory(join(base, "missing-dir"));
    } catch (error) {
      missingFailed = error instanceof CwdBrowseError && error.status === 400;
    }
    assert(missingFailed, "missing directories must raise CwdBrowseError 400");

    let fileFailed = false;
    try {
      browseCwdDirectory(join(base, "note.txt"));
    } catch (error) {
      fileFailed = error instanceof CwdBrowseError && error.status === 400;
    }
    assert(fileFailed, "file paths must raise CwdBrowseError 400");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function checkWiring(): void {
  const route = readFileSync(join(ROOT, "app", "api", "cwd", "browse", "route.ts"), "utf8");
  assert(route.includes('export const runtime = "nodejs"'), "browse route must run in the Node.js runtime");
  assert(route.includes("browseCwdDirectory(pathParam)"), "browse route must use shared browse helper");

  const picker = readFileSync(join(ROOT, "components", "sidebar", "WorkspacePicker.tsx"), "utf8");
  assert(picker.includes("DirectoryPickerDialog"), "workspace picker must mount directory picker dialog");
  assert(picker.includes('t("sidebar.addProject")'), "workspace picker must expose add-project entry");

  const dialog = readFileSync(join(ROOT, "components", "sidebar", "DirectoryPickerDialog.tsx"), "utf8");
  assert(dialog.includes('fetch(`/api/cwd/browse'), "dialog must load directories from browse API");
  assert(dialog.includes('fetch("/api/cwd/validate"'), "dialog must validate before selecting cwd");
  assert(dialog.includes("createPortal"), "dialog must portal to document body");
}

function main(): void {
  checkRoots();
  checkBrowseDirectories();
  checkWiring();
  console.log("cwd browse smoke checks passed");
}

main();
