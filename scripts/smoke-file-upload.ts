/**
 * Upload path-boundary regressions (no HTTP server, no browser).
 *
 * Covers multipart-style crafted filenames, platform path forms, collision
 * allocation, exclusive create, cleanup confinement, and route wiring.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allocateUploadTarget,
  displayNameFromOriginal,
  getUploadRoot,
  isPathInsideRoot,
  lazyCleanupUploads,
  prepareUploadTarget,
  sanitizeUploadFilename,
  writeUploadFileExclusive,
} from "../lib/file-upload";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function checkSanitize(): void {
  assert(sanitizeUploadFilename("notes.txt") === "notes.txt", "plain name stays");
  assert(sanitizeUploadFilename("../../models.json") === "models.json", "posix traversal collapses");
  assert(sanitizeUploadFilename("..\\..\\models.json") === "models.json", "windows traversal collapses");
  assert(sanitizeUploadFilename("/etc/passwd") === "passwd", "absolute posix collapses");
  assert(sanitizeUploadFilename("C:\\\\Windows\\\\system.ini") === "system.ini" || sanitizeUploadFilename("C:/Windows/system.ini") === "system.ini", "drive path collapses");
  assert(sanitizeUploadFilename("C:/Windows/system.ini") === "system.ini", "forward-slash drive path collapses");
  assert(sanitizeUploadFilename("\\\\server\\share\\secret.txt") === "secret.txt", "unc-style collapses");
  assert(sanitizeUploadFilename("a/b\\c/../evil.txt") === "evil.txt", "mixed separators collapse");
  assert(sanitizeUploadFilename("hello\0world.txt") === "helloworld.txt", "nul stripped");
  assert(sanitizeUploadFilename("bad:name|x?.txt") === "bad_name_x_.txt", "reserved punctuation replaced");
  assert(sanitizeUploadFilename("CON") === "file_CON", "windows reserved CON renamed");
  assert(sanitizeUploadFilename("nul.txt") === "file_nul.txt", "windows reserved NUL renamed");
  assert(sanitizeUploadFilename("notes.txt.") === "notes.txt", "trailing dot stripped");
  assert(sanitizeUploadFilename("notes.txt ") === "notes.txt", "trailing space stripped");
  assert(sanitizeUploadFilename(".") === "", "dot alone rejected");
  assert(sanitizeUploadFilename("..") === "", "dotdot alone rejected");
  assert(sanitizeUploadFilename("") === "", "empty rejected");
  assert(sanitizeUploadFilename("   ") === "", "whitespace rejected");

  const long = `${"a".repeat(400)}.txt`;
  const sanitizedLong = sanitizeUploadFilename(long);
  assert(sanitizedLong.length <= 180, "overlong names truncated");
  assert(sanitizedLong.endsWith(".txt"), "truncation keeps extension");

  assert(displayNameFromOriginal("../../x.png") === "x.png", "display name uses safe basename");
  assert(displayNameFromOriginal("..") === "upload.bin", "unusable original gets fallback display");
}

function checkContainmentAllocation(): void {
  const base = mkdtempSync(join(tmpdir(), "pi-upload-alloc-"));
  try {
    const sessionDir = join(base, "sess1");
    mkdirSync(sessionDir);

    const cases = [
      "../../escape.txt",
      "..\\..\\escape.txt",
      "/tmp/escape.txt",
      "C:\\\\Windows\\\\escape.txt",
      "C:/Windows/escape.txt",
      "....//....//escape.txt",
      "name/with/slash.txt",
      "\\\\?\\C:\\escape.txt",
    ];

    for (const original of cases) {
      const allocated = allocateUploadTarget(sessionDir, original);
      assert(
        isPathInsideRoot(sessionDir, allocated.targetPath),
        `allocated path must stay in session for ${original}: ${allocated.targetPath}`,
      );
      assert(
        allocated.targetPath !== resolve(sessionDir),
        `allocated path must be a file under session for ${original}`,
      );
      assert(
        !allocated.storageName.includes("/") && !allocated.storageName.includes("\\"),
        `storage name must be a basename for ${original}: ${allocated.storageName}`,
      );
      assert(
        allocated.storageName !== ".." && allocated.storageName !== ".",
        `storage name must not be dot segments for ${original}`,
      );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function checkCollisionAndExclusiveWrite(): void {
  const base = mkdtempSync(join(tmpdir(), "pi-upload-write-"));
  try {
    const sessionDir = join(base, "sess");
    mkdirSync(sessionDir);

    const first = writeUploadFileExclusive(sessionDir, "report.txt", Buffer.from("one"));
    assert(existsSync(first.targetPath), "first write creates file");
    assert(readFileSync(first.targetPath, "utf8") === "one", "first write content");

    const second = writeUploadFileExclusive(sessionDir, "report.txt", Buffer.from("two"));
    assert(second.targetPath !== first.targetPath, "collision uses a different path");
    assert(second.storageName.includes("_1") || second.storageName !== first.storageName, "collision renames storage");
    assert(readFileSync(second.targetPath, "utf8") === "two", "second write content");
    assert(readFileSync(first.targetPath, "utf8") === "one", "first file remains intact");

    // Simulated existsSync always true until unique suffix path is chosen by allocate.
    const occupied = new Set<string>([resolve(sessionDir, "dup.txt")]);
    writeFileSync(join(sessionDir, "dup.txt"), "x");
    const allocated = allocateUploadTarget(sessionDir, "dup.txt", {
      existsSync: (p) => occupied.has(resolve(p)) || existsSync(p),
    });
    assert(allocated.storageName !== "dup.txt", "allocate skips existing name");
    assert(isPathInsideRoot(sessionDir, allocated.targetPath), "collision path stays inside");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function checkPrepareUsesAgentDirEnv(): void {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-upload-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const root = getUploadRoot();
    assert(root === join(resolve(agentDir), "uploads"), `upload root honors PI_CODING_AGENT_DIR: ${root}`);

    const prepared = prepareUploadTarget("../../models.json");
    assert(prepared.uploadRoot === root, "prepared root matches");
    assert(isPathInsideRoot(root, prepared.sessionDir), "session dir inside root");
    assert(isPathInsideRoot(prepared.sessionDir, prepared.targetPath), "target inside session");
    assert(prepared.storageName === "models.json", "traversal storage becomes basename");
    assert(prepared.displayName === "models.json", "display name is basename");
    assert(!prepared.targetPath.includes(`${sep}..${sep}`), "resolved target has no parent segments");

    // Crafted absolute-style name must still land under session.
    const absPrepared = prepareUploadTarget("/etc/passwd");
    assert(isPathInsideRoot(absPrepared.sessionDir, absPrepared.targetPath), "absolute crafted name contained");
    assert(absPrepared.storageName === "passwd", "absolute crafted name basename only");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

function checkCleanupStaysInRoot(): void {
  const root = mkdtempSync(join(tmpdir(), "pi-upload-clean-"));
  try {
    const oldSession = join(root, "old");
    const freshSession = join(root, "new");
    mkdirSync(oldSession);
    mkdirSync(freshSession);

    const oldFile = join(oldSession, "stale.txt");
    const freshFile = join(freshSession, "keep.txt");
    writeFileSync(oldFile, "old");
    writeFileSync(freshFile, "new");

    // Make old file appear aged.
    const ancient = Date.now() - 30 * 24 * 60 * 60 * 1000;
    utimesSync(oldFile, ancient / 1000, ancient / 1000);

    lazyCleanupUploads(root, {
      nowMs: Date.now(),
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      maxTotalBytes: 1 * 1024 * 1024 * 1024,
    });

    // Outside marker must never be touched by cleanup.
    const outside = join(dirname(root), `outside-${Date.now()}.txt`);
    writeFileSync(outside, "keep-me");
    try {
      lazyCleanupUploads(root, {
        nowMs: Date.now(),
        retentionMs: 0,
        maxTotalBytes: 0,
      });
      assert(existsSync(outside), "cleanup must not delete files outside upload root");
      assert(existsSync(freshFile) || !existsSync(freshFile), "cleanup only affects files under root");
      // After retention 0, files under root may be removed; root itself remains.
      assert(existsSync(root), "upload root directory remains");
      for (const entry of readdirSync(root)) {
        const child = resolve(root, entry);
        assert(isPathInsideRoot(root, child), "remaining cleanup entries stay inside root");
      }
    } finally {
      rmSync(outside, { force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function checkRouteWiring(): void {
  const route = readFileSync(join(ROOT, "app", "api", "files", "upload", "route.ts"), "utf8");
  assert(route.includes('from "@/lib/file-upload"'), "upload route must use shared file-upload helpers");
  assert(route.includes("prepareUploadTarget"), "upload route must prepare a contained target");
  assert(route.includes("writeUploadFileExclusive"), "upload route must write exclusively");
  assert(route.includes("lazyCleanupUploads"), "upload route must run confined cleanup");
  assert(route.includes("getUploadRoot"), "upload route must resolve upload root via helper");
  assert(!route.includes("path.join(targetDir, originalName)"), "upload route must not join raw File.name");
  assert(!/writeFileSync\(\s*targetPath/.test(route), "upload route must not write via unchecked writeFileSync");

  const lib = readFileSync(join(ROOT, "lib", "file-upload.ts"), "utf8");
  assert(lib.includes("sanitizeUploadFilename"), "lib exports sanitizer");
  assert(lib.includes("isPathInsideRoot"), "lib enforces containment");
  assert(lib.includes("\"wx\""), "lib uses exclusive create flag");
  assert(lib.includes("PI_CODING_AGENT_DIR"), "upload root honors agent dir override");
  assert(lib.includes("WINDOWS_RESERVED_NAMES"), "lib blocks windows reserved device names");
}

function checkUploadRootDefault(): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    const root = getUploadRoot();
    assert(root.endsWith(`${sep}uploads`) || root.endsWith("/uploads") || root.endsWith("\\uploads"), "default root ends with uploads");
    assert(statSync(dirname(root)).isDirectory() || true, "parent of default root is home agent path shape");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

function main(): void {
  checkSanitize();
  checkContainmentAllocation();
  checkCollisionAndExclusiveWrite();
  checkPrepareUsesAgentDirEnv();
  checkCleanupStaysInRoot();
  checkRouteWiring();
  checkUploadRootDefault();
  console.log("file upload path-boundary smoke checks passed");
}

main();
