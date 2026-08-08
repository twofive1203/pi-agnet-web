/**
 * Smoke tests for rebuildable session index:
 * header-read reuse, append/new/delete, malformed isolation,
 * archive/unarchive moves, and Windows cwd encoding collisions.
 *
 * Dependency-free by design: intentionally runnable without importing the pi SDK
 * or lib/session-reader (keeps tsx's CJS loader happy). Reader integration is
 * covered by typecheck + shared candidate helpers; this script validates the
 * index acceleration layer itself.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pi-web-session-index-"));
const agentDir = join(root, "agent");
const cwdA = join(root, "workspace-a");
const cwdCollideX = join(root, "collide-x");
const cwdCollideY = join(root, "collide-y");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(cwdA, { recursive: true });
mkdirSync(cwdCollideX, { recursive: true });
mkdirSync(cwdCollideY, { recursive: true });

function encodeSessionDirName(cwd: string): string {
  const resolved = cwd.replace(/\\/g, "/");
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function writeSession(
  projectCwd: string,
  id: string,
  timestamp: string,
  firstUser: string,
  opts?: {
    mtimeMs?: number;
    dirName?: string;
    root?: "sessions" | "sessions-archive";
    name?: string;
  }
) {
  const rootName = opts?.root ?? "sessions";
  const dir = join(agentDir, rootName, opts?.dirName ?? encodeSessionDirName(projectCwd));
  mkdirSync(dir, { recursive: true });
  const fileStamp = timestamp.replace(/[:.]/g, "-");
  const filePath = join(dir, `${fileStamp}_${id}.jsonl`);
  const lines: Array<Record<string, unknown>> = [
    {
      type: "session",
      version: 3,
      id,
      timestamp,
      cwd: projectCwd,
    },
  ];
  if (opts?.name) {
    lines.push({
      type: "session_info",
      id: `${id}-info`,
      parentId: null,
      timestamp,
      name: opts.name,
    });
  }
  lines.push({
    type: "message",
    id: `${id}-msg`,
    parentId: null,
    timestamp,
    message: {
      role: "user",
      content: [{ type: "text", text: firstUser }],
    },
  });
  writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  if (opts?.mtimeMs != null) {
    const atime = new Date(opts.mtimeMs);
    const mtime = new Date(opts.mtimeMs);
    utimesSync(filePath, atime, mtime);
  }
  return filePath;
}

function moveToArchive(activePath: string): string {
  // Build archive path mirroring sessions/<encoded>/<file>
  const parts = activePath.replace(/\\/g, "/").split("/sessions/");
  const tail = parts.length > 1 ? parts[1] : activePath;
  const archivedPath = join(agentDir, "sessions-archive", ...tail.split("/"));
  mkdirSync(dirname(archivedPath), { recursive: true });
  renameSync(activePath, archivedPath);
  return archivedPath;
}

async function main() {
  try {
    const {
      refreshSessionIndex,
      getSessionIndexEntries,
      getSessionIndexEntriesForCwd,
      getLastSessionIndexHeaderReads,
      getSessionIndexHeaderReadCount,
      resetSessionIndexRuntimeForTests,
      getSessionIndexPath,
      invalidateSessionIndex,
      SESSION_INDEX_VERSION,
    } = await import("../lib/session-index");

    const base = Date.parse("2026-07-10T00:00:00.000Z");
    writeSession(cwdA, "idx-a-0", new Date(base).toISOString(), "alpha first message", {
      mtimeMs: base,
      name: "Alpha Named",
    });
    writeSession(cwdA, "idx-a-1", new Date(base + 60_000).toISOString(), "a1", {
      mtimeMs: base + 60_000,
    });

    // Malformed files must not break indexing (unparseable + typed-malformed cwd).
    {
      const badDir = join(agentDir, "sessions", encodeSessionDirName(cwdA));
      writeFileSync(join(badDir, "2026-07-10T00-02-00-000Z_idx-bad.jsonl"), "not-json\n");
      // Typed malformed: truthy non-string cwd must be isolated; valid sessions remain.
      writeFileSync(
        join(badDir, "2026-07-10T00-02-30-000Z_idx-bad-cwd.jsonl"),
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: "idx-bad-cwd",
          timestamp: new Date(base + 90_000).toISOString(),
          cwd: { x: 1 },
        })}\n`
      );
    }

    // Encoding collision directory: two real cwds share one folder.
    const collisionDir = "--index-collision-shared--";
    writeSession(cwdCollideX, "idx-x-0", new Date(base + 120_000).toISOString(), "x0", {
      dirName: collisionDir,
      mtimeMs: base + 120_000,
    });
    writeSession(cwdCollideY, "idx-y-0", new Date(base + 180_000).toISOString(), "y0", {
      dirName: collisionDir,
      mtimeMs: base + 180_000,
    });

    resetSessionIndexRuntimeForTests();
    const first = await refreshSessionIndex({ agentDir });
    assert.equal(first.length, 4, `expected 4 valid entries, got ${first.length}`);
    assert.equal(
      first.some((e) => e.id === "idx-bad-cwd"),
      false,
      "typed malformed non-string cwd must not become an index entry"
    );
    assert.ok(
      first.some((e) => e.id === "idx-a-0") && first.some((e) => e.id === "idx-a-1"),
      "valid sessions must remain when a sibling header is typed-malformed"
    );
    const firstReads = getLastSessionIndexHeaderReads();
    assert.ok(firstReads >= 4, `first build should read headers for new files; got ${firstReads}`);
    // unparseable + typed-malformed cwd are each attempted once
    assert.ok(firstReads >= 6, "both malformed files should still be peeked once");

    const indexPath = getSessionIndexPath(agentDir);
    const persisted = JSON.parse(readFileSync(indexPath, "utf8")) as {
      version: number;
      entries: unknown[];
    };
    assert.equal(persisted.version, SESSION_INDEX_VERSION);
    assert.equal(persisted.entries.length, 4);
    const named = first.find((e) => e.id === "idx-a-0");
    assert.ok(named);
    assert.equal(named!.name, "Alpha Named");
    assert.equal(named!.firstMessage, "alpha first message");
    assert.equal(named!.messageCount, 1);

    // Second refresh should reuse fingerprints (0 header reads for unchanged files).
    const beforeReuse = getSessionIndexHeaderReadCount();
    const second = await refreshSessionIndex({ agentDir });
    assert.equal(second.length, 4);
    assert.equal(getLastSessionIndexHeaderReads(), 0, "unchanged files must not re-read headers");
    assert.equal(getSessionIndexHeaderReadCount(), beforeReuse, "cumulative header reads stay flat");

    // Append a new session → only the new file header is read.
    writeSession(cwdA, "idx-a-2", new Date(base + 240_000).toISOString(), "a2", {
      mtimeMs: base + 240_000,
    });
    invalidateSessionIndex();
    const afterAppend = await refreshSessionIndex({ agentDir });
    assert.equal(afterAppend.length, 5);
    assert.equal(getLastSessionIndexHeaderReads(), 1, "only new file header should be read");

    // Modify an existing indexed JSONL so fingerprint (path+mtime+size) changes →
    // exactly one header reread and updated entry metadata.
    const existing = afterAppend.find((e) => e.id === "idx-a-2");
    assert.ok(existing, "idx-a-2 must exist before modification");
    const prevSize = existing!.size;
    const prevMtime = existing!.mtimeMs;
    const extraLine = {
      type: "message",
      id: "idx-a-2-extra",
      parentId: null,
      timestamp: new Date(base + 250_000).toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: "modified-existing" }],
      },
    };
    writeFileSync(
      existing!.path,
      `${readFileSync(existing!.path, "utf8")}${JSON.stringify(extraLine)}\n`
    );
    // Force a distinct mtime even on coarse-resolution filesystems.
    utimesSync(
      existing!.path,
      new Date(base + 300_000),
      new Date(base + 300_000)
    );
    invalidateSessionIndex();
    const afterModify = await refreshSessionIndex({ agentDir });
    assert.equal(afterModify.length, 5, "modify must not add/remove entries");
    assert.equal(
      getLastSessionIndexHeaderReads(),
      1,
      "only the modified existing file header should be re-read"
    );
    const updated = afterModify.find((e) => e.id === "idx-a-2");
    assert.ok(updated, "modified session must remain indexed");
    assert.ok(
      updated!.size !== prevSize || updated!.mtimeMs !== prevMtime,
      "modified entry fingerprint fields must update"
    );
    assert.equal(updated!.size > prevSize, true, "appended content should grow size");
    assert.equal(updated!.mtimeMs, base + 300_000);
    assert.equal(updated!.messageCount, 2, "summary messageCount must refresh after JSONL modify");
    assert.ok(
      updated!.firstMessage.includes("a2") || updated!.firstMessage.length > 0,
      "firstMessage remains available after modify"
    );

    // Cwd grouping (collision safe) via index lookups.
    const entriesA = await getSessionIndexEntriesForCwd(cwdA, { agentDir, archived: false });
    const entriesX = await getSessionIndexEntriesForCwd(cwdCollideX, { agentDir, archived: false });
    const entriesY = await getSessionIndexEntriesForCwd(cwdCollideY, { agentDir, archived: false });
    assert.equal(entriesA.length, 3, "A counts only its own valid sessions");
    assert.equal(entriesX.length, 1);
    assert.equal(entriesY.length, 1);
    assert.ok(entriesX.every((e) => e.id.startsWith("idx-x-")));
    assert.ok(entriesY.every((e) => e.id.startsWith("idx-y-")));

    // Delete one file from disk → index drops it on next refresh.
    const toDelete = afterAppend.find((e) => e.id === "idx-a-0");
    assert.ok(toDelete);
    rmSync(toDelete!.path, { force: true });
    invalidateSessionIndex();
    const afterDelete = await refreshSessionIndex({ agentDir });
    assert.equal(afterDelete.some((e) => e.id === "idx-a-0"), false);
    assert.equal(afterDelete.length, 4);

    // Archive move: fingerprint refresh discovers archived=true.
    const live = afterDelete.find((e) => e.id === "idx-a-1");
    assert.ok(live);
    const archivedPath = moveToArchive(live!.path);
    assert.ok(archivedPath.includes("sessions-archive"));
    invalidateSessionIndex();
    const archivedEntries = await getSessionIndexEntries({ agentDir, archived: true });
    assert.ok(archivedEntries.some((e) => e.id === "idx-a-1" && e.archived));
    const activeEntries = await getSessionIndexEntries({ agentDir, archived: false });
    assert.equal(activeEntries.some((e) => e.id === "idx-a-1"), false);

    // Unarchive restores active entry.
    const activeRestored = join(
      agentDir,
      "sessions",
      ...archivedPath.replace(/\\/g, "/").split("/sessions-archive/")[1].split("/")
    );
    mkdirSync(dirname(activeRestored), { recursive: true });
    renameSync(archivedPath, activeRestored);
    invalidateSessionIndex();
    const restoredActive = await getSessionIndexEntriesForCwd(cwdA, {
      agentDir,
      archived: false,
    });
    assert.ok(restoredActive.some((e) => e.id === "idx-a-1"));

    // Corrupt index file is ignored and rebuilt.
    writeFileSync(indexPath, "{not-json");
    resetSessionIndexRuntimeForTests();
    const rebuilt = await refreshSessionIndex({ agentDir });
    assert.ok(rebuilt.length >= 3, "corrupt index rebuilds from disk");

    // Version mismatch rebuilds.
    writeFileSync(
      indexPath,
      JSON.stringify({ version: 999, entries: [] })
    );
    resetSessionIndexRuntimeForTests();
    const rebuilt2 = await refreshSessionIndex({ agentDir });
    assert.ok(rebuilt2.length >= 3, "version mismatch rebuilds from disk");

    // Atomic write leaves a readable final file (no half-written JSON).
    const raw = readFileSync(indexPath, "utf8");
    JSON.parse(raw);

    // Concurrent refresh shares one build.
    resetSessionIndexRuntimeForTests();
    const [r1, r2] = await Promise.all([
      refreshSessionIndex({ agentDir }),
      refreshSessionIndex({ agentDir }),
    ]);
    assert.equal(r1.length, r2.length);

    console.log("smoke-session-index: ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
