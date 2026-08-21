import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browseCwdDirectory, CwdBrowseError, listBrowseRoots } from "../lib/cwd-browse";
import {
  buildDirectoryPickerShortcuts,
  nextDirectoryPickerCandidate,
  normalizeDirectoryPickerPlatform,
  resolveDirectoryPickerFinalPath,
  splitDirectoryPickerBreadcrumbs,
} from "../components/sidebar/sidebar-utils";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE_MARKERS = ["cwd/pick-native", "cwd-native-pick", "cwd-local-access"] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readRepoFile(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), "utf8");
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
    assert(listed.platform === process.platform, "browse must report server platform");
    assert(typeof listed.home === "string" && listed.home.length > 0, "browse must return home");
    assert(Array.isArray(listed.roots) && listed.roots.length >= 1, "ordinary browse must return roots");
    assert(listed.entries.some((entry) => entry.name === "alpha-dir"), "browse must list child directories");
    assert(listed.entries.some((entry) => entry.name === "beta-dir"), "browse must list all child directories");
    assert(!listed.entries.some((entry) => entry.name === "note.txt"), "browse must not list files");

    const rootsView = browseCwdDirectory("");
    assert(rootsView.path === "", "empty path must open roots view");
    assert(rootsView.parent === null, "roots view has no parent");
    assert(rootsView.entries.length >= 1, "roots view must return entries");
    assert(Array.isArray(rootsView.roots) && rootsView.roots.length >= 1, "roots view must return roots");
    assert(typeof rootsView.home === "string" && rootsView.home.length > 0, "roots view must return home");
    assert(typeof rootsView.platform === "string", "roots view must return platform");

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

function checkDisplayModel(): void {
  assert(normalizeDirectoryPickerPlatform("win32") === "win32", "win32 platform stays win32");
  assert(normalizeDirectoryPickerPlatform("linux") === "linux", "linux platform stays linux");
  assert(normalizeDirectoryPickerPlatform("freebsd") === "linux", "bsd platforms map to linux copy");

  const win = splitDirectoryPickerBreadcrumbs("C:\\work\\repo", "win32");
  assert(win.length === 3, "Windows path must yield drive plus two segments");
  assert(win[0]?.label === "C:" && win[0]?.path === "C:\\", "Windows breadcrumb root must be the drive");
  assert(win[1]?.label === "work" && win[1]?.path === "C:\\work", "Windows mid crumb must keep a full path");
  assert(win[2]?.label === "repo" && win[2]?.path === "C:\\work\\repo", "Windows leaf crumb must keep a full path");

  const trailing = splitDirectoryPickerBreadcrumbs("C:\\work\\repo\\", "win32");
  assert(trailing.at(-1)?.path === "C:\\work\\repo", "trailing separators must not create empty crumbs");

  const driveRoot = splitDirectoryPickerBreadcrumbs("C:\\", "win32");
  assert(driveRoot.length === 1 && driveRoot[0]?.path === "C:\\", "drive root must stay a single navigable crumb");

  const posix = splitDirectoryPickerBreadcrumbs("/home/user/repo", "linux");
  assert(posix[0]?.label === "/" && posix[0]?.path === "/", "POSIX breadcrumb root must be /");
  assert(posix[1]?.path === "/home", "POSIX home crumb must keep a full path");
  assert(posix.at(-1)?.path === "/home/user/repo", "POSIX leaf crumb must keep a full path");

  const posixRoot = splitDirectoryPickerBreadcrumbs("/", "linux");
  assert(posixRoot.length === 1 && posixRoot[0]?.path === "/", "POSIX filesystem root must be a single crumb");

  const empty = splitDirectoryPickerBreadcrumbs("", "linux");
  assert(empty.length === 0, "roots view must not invent breadcrumb nodes");

  const unc = splitDirectoryPickerBreadcrumbs("\\\\server\\share\\folder", "win32");
  assert(unc[0]?.path === "\\\\server\\share", "UNC root must keep share semantics");
  assert(unc[1]?.label === "folder" && unc[1]?.path === "\\\\server\\share\\folder", "UNC child must keep a full path");

  const shortcuts = buildDirectoryPickerShortcuts({
    roots: [
      { name: "Home", path: "/home/user" },
      { name: "/", path: "/" },
      { name: "Home", path: "/home/user" },
    ],
    home: "/home/user",
    currentProjectPath: "/home/user/repo",
    platform: "linux",
  });
  assert(shortcuts.filter((item) => item.kind === "home").length === 1, "duplicate Home shortcuts must collapse");
  assert(shortcuts.some((item) => item.kind === "root" && item.path === "/"), "root shortcut must remain");
  assert(shortcuts.some((item) => item.kind === "project" && item.path === "/home/user/repo"), "current project shortcut must appear when unique");

  const homeProject = buildDirectoryPickerShortcuts({
    roots: [{ name: "Home", path: "/home/user" }],
    home: "/home/user",
    currentProjectPath: "/home/user",
    platform: "linux",
  });
  assert(!homeProject.some((item) => item.kind === "project"), "current project must not duplicate Home");

  const emptyShortcuts = buildDirectoryPickerShortcuts({
    roots: [],
    home: null,
    currentProjectPath: null,
  });
  assert(emptyShortcuts.length === 0, "empty roots must not invent shortcuts");

  assert(resolveDirectoryPickerFinalPath("/a", "/a/b") === "/a/b", "highlighted child wins the final path");
  assert(resolveDirectoryPickerFinalPath("/a", null) === "/a", "missing candidate falls back to the current directory");
  assert(resolveDirectoryPickerFinalPath("", null) === "", "roots view without a candidate has no final path");
  assert(nextDirectoryPickerCandidate("/a", "/b", "/a/c") === null, "navigation must clear the old candidate");
  assert(nextDirectoryPickerCandidate("/a", "/a", "/a/c") === "/a/c", "same location must keep the candidate");
}

function checkWiring(): void {
  const route = readRepoFile("app", "api", "cwd", "browse", "route.ts");
  assert(route.includes('export const runtime = "nodejs"'), "browse route must run in the Node.js runtime");
  assert(route.includes("browseCwdDirectory(pathParam)"), "browse route must use shared browse helper");

  const picker = readRepoFile("components", "sidebar", "WorkspacePicker.tsx");
  assert(picker.includes("DirectoryPickerDialog"), "workspace picker must mount directory picker dialog");
  assert(picker.includes("ProjectPickerDialog"), "workspace picker must mount project picker dialog");
  assert(picker.includes("setProjectPickerOpen(true)"), "workspace card opens project picker modal");
  assert(picker.includes("setDirectoryPickerOpen(true)"), "add-project opens the web directory dialog directly");
  assert(picker.includes('fetch("/api/cwd/open"'), "workspace menu still opens the authorized project folder");
  assert(!picker.includes("tryNativeDirectoryPick"), "add-project must not prefer a native picker");
  assert(!picker.includes("/api/cwd/pick-native"), "add-project must not call pick-native");
  assert(!picker.includes("nativePickerAvailable"), "workspace picker must not pass native picker props");

  const projectDialog = readRepoFile("components", "sidebar", "ProjectPickerDialog.tsx");
  assert(projectDialog.includes("createPortal"), "project dialog must portal to document body");
  assert(projectDialog.includes('t("sidebar.addProject")'), "project dialog must expose add-project entry");
  assert(projectDialog.includes("filterCwdPickerGroups"), "project dialog must support path search");
  assert(projectDialog.includes("onSelect"), "project dialog must select cwd on row click");

  const dialog = readRepoFile("components", "sidebar", "DirectoryPickerDialog.tsx");
  assert(dialog.includes("fetch(`/api/cwd/browse"), "dialog must load directories from browse API");
  assert(dialog.includes('fetch("/api/cwd/validate"'), "dialog must validate before selecting cwd");
  assert(dialog.includes("createPortal"), "dialog must portal to document body");
  assert(dialog.includes("data-server-platform"), "dialog must expose server platform");
  assert(dialog.includes("normalizeDirectoryPickerPlatform"), "dialog must consume the shared platform model");
  assert(dialog.includes("splitDirectoryPickerBreadcrumbs"), "dialog must render breadcrumbs from the shared model");
  assert(dialog.includes("buildDirectoryPickerShortcuts"), "dialog must render shortcuts from the shared model");
  assert(dialog.includes("resolveDirectoryPickerFinalPath"), "dialog must derive the final path from the shared model");
  assert(dialog.includes("requestSeqRef"), "dialog must ignore stale browse responses");
  assert(dialog.includes('role="listbox"'), "directory list must expose listbox semantics");
  assert(dialog.includes("aria-selected"), "selected directory must expose selected semantics");
  assert(dialog.includes("directory-picker-shortcuts"), "dialog must render the shortcut pane");
  assert(dialog.includes("directory-picker-enter"), "dialog must expose an explicit enter action");
  assert(dialog.includes('event.key === "Escape"'), "dialog must close on Escape");
  assert(dialog.includes("previouslyFocusedRef"), "dialog must restore focus on close");
  assert(!dialog.includes("nativePickerAvailable"), "dialog must not keep native picker props");
  assert(!dialog.includes("onRequestNativePicker"), "dialog must not re-enter a native picker");
}

function checkNoNativePickerResidue(): void {
  assert(!existsSync(join(ROOT, "app", "api", "cwd", "pick-native", "route.ts")), "pick-native route must be deleted");
  assert(!existsSync(join(ROOT, "lib", "cwd-local-access.ts")), "cwd-local-access must be deleted");
  assert(!existsSync(join(ROOT, "lib", "cwd-native-pick.ts")), "cwd-native-pick must be deleted");
  assert(!existsSync(join(ROOT, "scripts", "smoke-cwd-native-pick.ts")), "native picker smoke must be deleted");

  const pkg = readRepoFile("package.json");
  assert(!pkg.includes("test:cwd-native-pick"), "package.json must not keep test:cwd-native-pick");
  assert(!pkg.includes("smoke-cwd-native-pick"), "package.json must not keep the native picker smoke");

  const agents = readRepoFile("AGENTS.md");
  assert(!agents.includes("test:cwd-native-pick"), "AGENTS.md must not keep test:cwd-native-pick");
  assert(!agents.includes("native-picker"), "AGENTS.md must not keep the native-picker auth exception");

  const docs = [
    ["docs", "modules", "api.md"],
    ["docs", "modules", "frontend.md"],
    ["docs", "modules", "library.md"],
    ["docs", "architecture", "overview.md"],
    ["docs", "operations", "troubleshooting.md"],
  ] as const;
  for (const parts of docs) {
    const text = readRepoFile(...parts);
    for (const marker of NATIVE_MARKERS) {
      assert(!text.includes(marker), `${parts.join("/")} must not mention ${marker}`);
    }
  }

  const runtimeFiles = [
    ["components", "sidebar", "WorkspacePicker.tsx"],
    ["components", "sidebar", "DirectoryPickerDialog.tsx"],
    ["lib", "cwd-browse.ts"],
    ["app", "api", "cwd", "browse", "route.ts"],
    ["app", "api", "cwd", "validate", "route.ts"],
    ["app", "api", "cwd", "open", "route.ts"],
  ] as const;
  for (const parts of runtimeFiles) {
    const text = readRepoFile(...parts);
    for (const marker of NATIVE_MARKERS) {
      assert(!text.includes(marker), `${parts.join("/")} must not mention ${marker}`);
    }
  }
}

function main(): void {
  checkRoots();
  checkBrowseDirectories();
  checkDisplayModel();
  checkWiring();
  checkNoNativePickerResidue();
  console.log("cwd browse smoke checks passed");
}

main();
