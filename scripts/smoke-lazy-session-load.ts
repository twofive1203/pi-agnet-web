import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "pi-web-lazy-sessions-"));
const agentDir = join(root, "agent");
const cwdA = join(root, "workspace-a");
const cwdB = join(root, "workspace-b");
const cwdCollideX = join(root, "collide-x");
const cwdCollideY = join(root, "collide-y");
const cwdArchiveX = join(root, "archive-x");
const cwdArchiveY = join(root, "archive-y");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(cwdA, { recursive: true });
mkdirSync(cwdB, { recursive: true });
mkdirSync(cwdCollideX, { recursive: true });
mkdirSync(cwdCollideY, { recursive: true });
mkdirSync(cwdArchiveX, { recursive: true });
mkdirSync(cwdArchiveY, { recursive: true });

function encodeSessionDirName(cwd: string): string {
  const resolved = cwd.replace(/\\/g, "/");
  // Mirror pi encoding used by session-reader (path.resolve semantics differ by OS; use absolute paths).
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function writeSession(
  projectCwd: string,
  id: string,
  timestamp: string,
  firstUser: string,
  opts?: { parentPath?: string; mtimeMs?: number; dirName?: string; root?: "sessions" | "sessions-archive" }
) {
  const rootName = opts?.root ?? "sessions";
  const dir = join(agentDir, rootName, opts?.dirName ?? encodeSessionDirName(projectCwd));
  mkdirSync(dir, { recursive: true });
  const fileStamp = timestamp.replace(/[:.]/g, "-");
  const filePath = join(dir, `${fileStamp}_${id}.jsonl`);
  const lines = [
    {
      type: "session",
      version: 3,
      id,
      timestamp,
      cwd: projectCwd,
      ...(opts?.parentPath ? { parentSession: opts.parentPath } : {}),
    },
    {
      type: "message",
      id: `${id}-msg`,
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: [{ type: "text", text: firstUser }],
      },
    },
  ];
  writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  if (opts?.mtimeMs != null) {
    const atime = new Date(opts.mtimeMs);
    const mtime = new Date(opts.mtimeMs);
    utimesSync(filePath, atime, mtime);
  }
  return filePath;
}

async function main() {
  try {
    const base = Date.parse("2026-07-01T00:00:00.000Z");
    // 12 sessions in project A; only 10 newest by mtime should be returned.
    const pathsA: string[] = [];
    for (let i = 0; i < 12; i++) {
      const ts = new Date(base + i * 60_000).toISOString();
      pathsA.push(
        writeSession(cwdA, `session-a-${i}`, ts, `hello-a-${i}`, {
          mtimeMs: base + i * 60_000,
        })
      );
    }
    // Older session with parent outside window (session-a-0 is oldest).
    writeSession(cwdA, "session-a-fork", new Date(base + 13 * 60_000).toISOString(), "forked", {
      parentPath: pathsA[0],
      mtimeMs: base + 13 * 60_000,
    });

    writeSession(cwdB, "session-b-0", "2026-07-02T00:00:00.000Z", "hello-b", {
      mtimeMs: base + 1000 * 60_000,
    });

    // Malformed directory: unreadable header should not break discovery.
    const badDir = join(agentDir, "sessions", "--bad-project--");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "2026-07-01T00-00-00-000Z_bad.jsonl"), "not-json\n");

    // Encoding-collision directory: two real cwds share one encoded folder (Windows lossy encoding).
    const collisionDirName = "--collision-shared-dir--";
    writeSession(cwdCollideX, "session-x-0", "2026-07-03T00:00:00.000Z", "hello-x", {
      dirName: collisionDirName,
      mtimeMs: base + 2000 * 60_000,
    });
    writeSession(cwdCollideX, "session-x-1", "2026-07-03T00:01:00.000Z", "hello-x-1", {
      dirName: collisionDirName,
      mtimeMs: base + 2001 * 60_000,
    });
    writeSession(cwdCollideY, "session-y-0", "2026-07-03T00:02:00.000Z", "hello-y", {
      dirName: collisionDirName,
      mtimeMs: base + 2002 * 60_000,
    });
    // Interleave extra Y sessions so recent loading must skip foreign-cwd files to fill limit.
    for (let i = 1; i <= 12; i++) {
      writeSession(cwdCollideY, `session-y-${i}`, new Date(base + (2100 + i) * 60_000).toISOString(), `y-${i}`, {
        dirName: collisionDirName,
        mtimeMs: base + (2100 + i) * 60_000,
      });
    }

    // Newest file in project A is completely malformed (newer mtime than all valid sessions).
    // Header-only filtering must exclude it from full JSONL opens (no limit+1 backfill),
    // and latestSession must use the newest valid readable candidate instead.
    {
      const dir = join(agentDir, "sessions", encodeSessionDirName(cwdA));
      const corruptPath = join(dir, "2026-07-01T00-50-00-000Z_session-a-corrupt.jsonl");
      writeFileSync(corruptPath, "not-json-header\n{also-broken\n");
      utimesSync(corruptPath, new Date(base + 50 * 60_000), new Date(base + 50 * 60_000));
    }

    // Several additional malformed newest files: old "parse until limit successes" would open
    // limit + malformedCount; header filter keeps full opens at most `limit`.
    {
      const dir = join(agentDir, "sessions", encodeSessionDirName(cwdA));
      for (let i = 0; i < 3; i++) {
        const p = join(dir, `2026-07-01T00-5${i}-00-000Z_session-a-corrupt-extra-${i}.jsonl`);
        writeFileSync(p, `not-json-${i}\n`);
        utimesSync(p, new Date(base + (51 + i) * 60_000), new Date(base + (51 + i) * 60_000));
      }
    }

    // Exact filename id that points at a fully malformed JSONL (no valid header).
    {
      const dir = join(agentDir, "sessions", encodeSessionDirName(cwdB));
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "2026-07-02T02-00-00-000Z_session-malformed-detail.jsonl"),
        "not-a-session-header\n"
      );
    }

    // Archive collision: shared archive dir holds two real cwds + one malformed file.
    const archiveCollisionDir = "--archive-collision-shared--";
    writeSession(cwdArchiveX, "session-ax-0", "2026-07-04T00:00:00.000Z", "ax-0", {
      root: "sessions-archive",
      dirName: archiveCollisionDir,
    });
    writeSession(cwdArchiveX, "session-ax-1", "2026-07-04T00:01:00.000Z", "ax-1", {
      root: "sessions-archive",
      dirName: archiveCollisionDir,
    });
    writeSession(cwdArchiveY, "session-ay-0", "2026-07-04T00:02:00.000Z", "ay-0", {
      root: "sessions-archive",
      dirName: archiveCollisionDir,
    });
    {
      const dir = join(agentDir, "sessions-archive", archiveCollisionDir);
      writeFileSync(join(dir, "2026-07-04T00-03-00-000Z_session-archive-bad.jsonl"), "nope\n");
    }

    // Near-id collision: substring must not match exact session id lookup.
    writeSession(cwdB, "session-a-0-extra", "2026-07-02T01:00:00.000Z", "near-id", {
      mtimeMs: base + 1100 * 60_000,
    });

    const {
      listProjectSummaries,
      listRecentSessionsForCwd,
      listAllSessions,
      findSessionFileById,
      resolveSessionPath,
      isArchivedSessionPath,
      scanArchivedCwds,
      readSessionHeaderLine,
      RECENT_SESSIONS_LIMIT,
    } = await import("../lib/session-reader");

    const projects = await listProjectSummaries();
    assert.equal(projects.length, 4, `expected 4 projects, got ${projects.length}: ${projects.map((p) => p.cwd).join(" | ")}`);
    const projectA = projects.find((p) => p.cwd.replace(/\\/g, "/") === cwdA.replace(/\\/g, "/"));
    const projectB = projects.find((p) => p.cwd.replace(/\\/g, "/") === cwdB.replace(/\\/g, "/"));
    const projectX = projects.find((p) => p.cwd.replace(/\\/g, "/") === cwdCollideX.replace(/\\/g, "/"));
    const projectY = projects.find((p) => p.cwd.replace(/\\/g, "/") === cwdCollideY.replace(/\\/g, "/"));
    assert.ok(projectA, "project A missing from summaries");
    assert.ok(projectB, "project B missing from summaries");
    assert.ok(projectX, "collision project X missing from summaries");
    assert.ok(projectY, "collision project Y missing from summaries");
    // Pure not-json files are excluded from header-matched count (12 + fork = 13).
    assert.equal(projectA!.sessionCount, 13, "project A should count only header-matched jsonl files");
    assert.ok(projectA!.latestSession, "project A should expose latest valid session summary despite newer malformed files");
    assert.notEqual(projectA!.latestSession!.id, "session-a-corrupt", "latestSession must skip malformed newest candidate");
    assert.equal(projectA!.latestSession!.id, "session-a-fork", "newest valid A session is the fork");
    assert.equal(projectX!.sessionCount, 2, "collision project X count is only its own files");
    assert.equal(projectY!.sessionCount, 13, "collision project Y count is only its own files");

    // Instrument full JSONL opens: malformed newest must not cause limit+1 SessionManager.open calls.
    const originalOpen = SessionManager.open.bind(SessionManager);
    let openCount = 0;
    (SessionManager as unknown as { open: typeof SessionManager.open }).open = ((...args: Parameters<typeof SessionManager.open>) => {
      openCount += 1;
      return originalOpen(...args);
    }) as typeof SessionManager.open;
    let recent;
    try {
      recent = await listRecentSessionsForCwd(cwdA, RECENT_SESSIONS_LIMIT);
    } finally {
      (SessionManager as unknown as { open: typeof SessionManager.open }).open = originalOpen;
    }
    // Page window is limit; parent-closure may add a small number of ancestors on top.
    assert.ok(
      recent.sessions.length >= RECENT_SESSIONS_LIMIT,
      "expected at least a full recent window"
    );
    assert.ok(
      recent.sessions.length <= RECENT_SESSIONS_LIMIT + 5,
      `recent+closure must stay near the page bound; got ${recent.sessions.length}`
    );
    assert.equal(recent.total, 13, "total should count header-matched files only");
    // Page parses ≤ limit; parent closure may open a few more ancestors (not malformed backfill).
    assert.ok(
      openCount <= RECENT_SESSIONS_LIMIT + 5,
      `must fully parse at most limit + parent-closure files; got ${openCount} opens`
    );
    // With 4 newer malformed files, a "retry until limit successes" strategy would open 14+.
    assert.ok(
      openCount < RECENT_SESSIONS_LIMIT + 4 + 5,
      `malformed newest files must not force limit+N full parses; got ${openCount} opens`
    );
    // Without parent closure, oldest stays outside the strict page window.
    const recentNoClosure = await listRecentSessionsForCwd(cwdA, {
      limit: RECENT_SESSIONS_LIMIT,
      includeParentClosure: false,
    });
    assert.equal(recentNoClosure.sessions.length, RECENT_SESSIONS_LIMIT, "strict page size without closure");
    assert.ok(
      recentNoClosure.sessions.every((s) => s.id !== "session-a-0"),
      "oldest session should fall outside recent window by mtime when closure is off"
    );
    assert.ok(
      recent.sessions.every((s) => !String(s.id).startsWith("session-a-corrupt")),
      "malformed candidates must not appear in recent list"
    );
    const fork = recent.sessions.find((s) => s.id === "session-a-fork");
    assert.ok(fork, "forked recent session should be present");
    assert.equal(fork!.parentSessionId, "session-a-0", "parentSessionId extracted from path");
    // Parent outside the mtime window must be auto-included via parent closure.
    assert.ok(
      recent.sessions.some((s) => s.id === "session-a-0"),
      "parent closure should include session-a-0 even outside the recent window"
    );
    assert.equal(recent.hasMore, true, "13 header-matched sessions with limit 10 => hasMore");
    assert.ok(recent.nextBefore, "nextBefore cursor required when hasMore");
    assert.ok(recent.nextBeforePath, "nextBeforePath tie-break required when hasMore");

    // Second page via before cursor: remaining sessions, no overlap with first-page core ids
    // (parent-closure extras from page 1 may legitimately reappear and must dedupe on the client).
    const page2 = await listRecentSessionsForCwd(cwdA, {
      limit: RECENT_SESSIONS_LIMIT,
      before: recent.nextBefore!,
      beforePath: recent.nextBeforePath!,
      includeParentClosure: false,
    });
    assert.equal(page2.hasMore, false, "second page should exhaust remaining sessions");
    assert.ok(page2.sessions.length >= 1, "second page returns remaining sessions");
    assert.ok(
      page2.sessions.some((s) => s.id === "session-a-0"),
      "oldest session appears on later page when parent closure is off"
    );
    const page1CoreIds = new Set(
      recent.sessions
        .filter((s) => s.id !== "session-a-0") // closure-only parent may sit outside the strict page window
        .map((s) => s.id)
    );
    for (const s of page2.sessions) {
      assert.equal(page1CoreIds.has(s.id), false, `page2 id ${s.id} must not overlap page1 core window`);
    }

    // Exact boundary: 10 matching sessions => no hasMore
    const exact = await listRecentSessionsForCwd(cwdB, { limit: 10, includeParentClosure: false });
    // cwdB has session-b-0 + near-id = 2 (+ malformed is header-invalid)
    assert.equal(exact.hasMore, false, "fewer than limit => hasMore false");
    assert.equal(exact.nextBefore, null);

    // Empty project
    const emptyCwd = join(root, "empty-project");
    mkdirSync(emptyCwd, { recursive: true });
    const emptyPage = await listRecentSessionsForCwd(emptyCwd, 10);
    assert.equal(emptyPage.total, 0);
    assert.equal(emptyPage.sessions.length, 0);
    assert.equal(emptyPage.hasMore, false);

    // Collision recent loading fills limit from matching cwd only.
    const recentX = await listRecentSessionsForCwd(cwdCollideX, RECENT_SESSIONS_LIMIT);
    assert.equal(recentX.total, 2, "X total ignores Y files in shared dir");
    assert.equal(recentX.sessions.length, 2, "X recent returns only X sessions");
    assert.ok(recentX.sessions.every((s) => s.id.startsWith("session-x-")), "X recent ids");

    const recentY = await listRecentSessionsForCwd(cwdCollideY, RECENT_SESSIONS_LIMIT);
    assert.equal(recentY.total, 13, "Y total ignores X files in shared dir");
    assert.equal(recentY.sessions.length, RECENT_SESSIONS_LIMIT, "Y recent fills limit from matching files");
    assert.ok(recentY.sessions.every((s) => s.id.startsWith("session-y-")), "Y recent ids");
    assert.ok(
      recentY.sessions.every((s) => s.id !== "session-y-0"),
      "oldest Y session falls outside window when limit filled from newer Y files"
    );

    // Full scan remains unbounded.
    const all = await listAllSessions();
    assert.ok(all.length >= 14, `full list should include all sessions, got ${all.length}`);
    assert.ok(all.some((s) => s.id === "session-a-0"), "full list includes old session");

    // Direct id resolution without requiring presence in recent window.
    const found = findSessionFileById("session-a-0");
    assert.ok(found, "filename scan finds old session");
    const resolved = await resolveSessionPath("session-a-0");
    assert.ok(resolved, "resolveSessionPath finds old session");
    assert.equal(resolved, found);

    // Exact id match: near-id must not be returned for session-a-0.
    assert.ok(
      found && !found.includes("session-a-0-extra"),
      "findSessionFileById must not substring-match a longer id"
    );
    const near = findSessionFileById("session-a-0-extra");
    assert.ok(near, "exact longer id still resolves");
    assert.equal(findSessionFileById("session-a"), null, "partial id must not match");

    // Separator-safe archive path detection (Windows + POSIX).
    assert.equal(isArchivedSessionPath("C:\\\\Users\\\\x\\\\.pi\\\\agent\\\\sessions-archive\\\\proj\\\\a.jsonl"), true);
    assert.equal(isArchivedSessionPath("C:/Users/x/.pi/agent/sessions-archive/proj/a.jsonl"), true);
    assert.equal(isArchivedSessionPath("C:\\\\Users\\\\x\\\\.pi\\\\agent\\\\sessions\\\\proj\\\\a.jsonl"), false);

    // Archive project visibility groups every JSONL by header cwd (not one header per dir).
    const archived = await scanArchivedCwds();
    const norm = (p: string) => p.replace(/\\/g, "/");
    const ax = archived.cwds.find((c) => norm(c) === norm(cwdArchiveX));
    const ay = archived.cwds.find((c) => norm(c) === norm(cwdArchiveY));
    assert.ok(ax, "archive scan must surface collision cwd X");
    assert.ok(ay, "archive scan must surface collision cwd Y");
    assert.equal(archived.counts[ax!], 2, "archive X count is only its own files");
    assert.equal(archived.counts[ay!], 1, "archive Y count is only its own files");
    assert.equal(
      Object.values(archived.counts).reduce((sum, n) => sum + n, 0),
      3,
      "malformed archive file must not contribute to any cwd count"
    );

    // Archived pagination for a larger archive set.
    const cwdArchiveBig = join(root, "archive-big");
    mkdirSync(cwdArchiveBig, { recursive: true });
    for (let i = 0; i < 25; i++) {
      writeSession(
        cwdArchiveBig,
        `session-ab-${i}`,
        new Date(base + (3000 + i) * 60_000).toISOString(),
        `ab-${i}`,
        {
          root: "sessions-archive",
          mtimeMs: base + (3000 + i) * 60_000,
        }
      );
    }
    const {
      listArchivedSessionsForCwd,
      ARCHIVED_SESSIONS_LIMIT,
    } = await import("../lib/session-reader");
    const archPage1 = await listArchivedSessionsForCwd(cwdArchiveBig, {
      limit: ARCHIVED_SESSIONS_LIMIT,
    });
    assert.equal(archPage1.total, 25, "archived total counts header-matched files");
    assert.equal(archPage1.sessions.length, ARCHIVED_SESSIONS_LIMIT, "archived first page bounded");
    assert.equal(archPage1.hasMore, true, "archived hasMore when total > limit");
    assert.ok(archPage1.nextBefore && archPage1.nextBeforePath, "archived cursor present");
    const archPage2 = await listArchivedSessionsForCwd(cwdArchiveBig, {
      limit: ARCHIVED_SESSIONS_LIMIT,
      before: archPage1.nextBefore!,
      beforePath: archPage1.nextBeforePath!,
    });
    assert.equal(archPage2.sessions.length, 5, "archived second page returns remainder");
    assert.equal(archPage2.hasMore, false);
    const archIds = new Set(archPage1.sessions.map((s) => s.id));
    for (const s of archPage2.sessions) {
      assert.equal(archIds.has(s.id), false, "archived pages must not overlap");
    }

    // Exact filename-id match to malformed JSONL fails closed (detail route peeks header → 404).
    const malformedFound = findSessionFileById("session-malformed-detail");
    assert.ok(malformedFound, "filename scan still finds exact id path");
    assert.equal(readSessionHeaderLine(malformedFound!), null, "malformed detail has no valid header");
    const malformedResolved = await resolveSessionPath("session-malformed-detail");
    assert.equal(
      malformedResolved,
      null,
      "resolveSessionPath must not trust exact-id paths with invalid headers"
    );

    console.log("smoke-lazy-session-load: ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
