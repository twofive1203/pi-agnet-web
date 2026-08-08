/**
 * Smoke tests for workspace session search over the rebuildable index:
 * name/firstMessage matching, archived flag, cwd isolation, case folding,
 * empty/short query, hard limit, index refresh after mutate/archive/delete,
 * corrupt index rebuild, malformed isolation, and client stale-response gate.
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

const root = mkdtempSync(join(tmpdir(), "pi-web-session-search-"));
const agentDir = join(root, "agent");
const cwdA = join(root, "workspace-a");
const cwdB = join(root, "workspace-b");
const cwdCollideX = join(root, "collide-x");
const cwdCollideY = join(root, "collide-y");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(cwdA, { recursive: true });
mkdirSync(cwdB, { recursive: true });
mkdirSync(cwdCollideX, { recursive: true });
mkdirSync(cwdCollideY, { recursive: true });

function encodeSessionDirName(cwd: string): string {
  const resolved = cwd.replace(/\\/g, "/");
  return `--${resolved.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`;
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
    utimesSync(filePath, new Date(opts.mtimeMs), new Date(opts.mtimeMs));
  }
  return filePath;
}

function moveToArchive(activePath: string): string {
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
      invalidateSessionIndex,
      resetSessionIndexRuntimeForTests,
      getSessionIndexPath,
      SESSION_INDEX_VERSION,
    } = await import("../lib/session-index");
    const {
      searchSessionsForCwd,
      sessionSummaryMatchesQuery,
      SESSION_SEARCH_MAX_LIMIT,
    } = await import("../lib/session-search");
    const { shouldApplySessionSearchResponse } = await import("../lib/session-search-client");

    const base = Date.parse("2026-08-01T00:00:00.000Z");
    const pathNamed = writeSession(
      cwdA,
      "search-a-name",
      new Date(base).toISOString(),
      "unrelated body",
      { mtimeMs: base, name: "Project Kickoff" }
    );
    writeSession(
      cwdA,
      "search-a-msg",
      new Date(base + 60_000).toISOString(),
      "UniqueZebraMessage content",
      { mtimeMs: base + 60_000 }
    );
    writeSession(
      cwdA,
      "search-a-other",
      new Date(base + 90_000).toISOString(),
      "plain other",
      { mtimeMs: base + 90_000 }
    );
    writeSession(
      cwdB,
      "search-b-name",
      new Date(base + 120_000).toISOString(),
      "UniqueZebraMessage should not leak",
      { mtimeMs: base + 120_000, name: "Project Kickoff B" }
    );

    // Archived match in cwdA
    const archivedLive = writeSession(
      cwdA,
      "search-a-archived",
      new Date(base + 150_000).toISOString(),
      "archived zebra note",
      { mtimeMs: base + 150_000, name: "Old Archive Title" }
    );
    moveToArchive(archivedLive);

    // Encoding collision directory
    const collisionDir = "--search-collision-shared--";
    writeSession(cwdCollideX, "search-x-0", new Date(base + 180_000).toISOString(), "collide x zebra", {
      dirName: collisionDir,
      mtimeMs: base + 180_000,
    });
    writeSession(cwdCollideY, "search-y-0", new Date(base + 210_000).toISOString(), "collide y only", {
      dirName: collisionDir,
      mtimeMs: base + 210_000,
    });

    // Malformed sibling must not break search for valid sessions.
    {
      const badDir = join(agentDir, "sessions", encodeSessionDirName(cwdA));
      writeFileSync(join(badDir, "2026-08-01T00-03-00-000Z_search-bad.jsonl"), "not-json\n");
    }

    resetSessionIndexRuntimeForTests();
    await refreshSessionIndex({ agentDir });

    // 1) Active name hit
    {
      const res = await searchSessionsForCwd({
        cwd: cwdA,
        query: "kickoff",
        agentDir,
        includeArchived: true,
      });
      assert.ok(res.sessions.some((s) => s.id === "search-a-name"));
      assert.equal(
        res.sessions.some((s) => s.id === "search-b-name"),
        false,
        "cwd B must not appear in cwd A search"
      );
    }

    // 2) Active firstMessage hit (case-insensitive)
    {
      const res = await searchSessionsForCwd({
        cwd: cwdA,
        query: "uniquezebra",
        agentDir,
      });
      assert.ok(res.sessions.some((s) => s.id === "search-a-msg"));
      assert.equal(res.sessions.some((s) => s.id === "search-b-name"), false);
    }

    // 3) Archived hit + archived flag
    {
      const res = await searchSessionsForCwd({
        cwd: cwdA,
        query: "archive",
        agentDir,
        includeArchived: true,
      });
      const hit = res.sessions.find((s) => s.id === "search-a-archived");
      assert.ok(hit, "archived session should match");
      assert.equal(hit!.archived, true);
    }

    // 4) includeArchived=false excludes archived
    {
      const res = await searchSessionsForCwd({
        cwd: cwdA,
        query: "archive",
        agentDir,
        includeArchived: false,
      });
      assert.equal(res.sessions.some((s) => s.id === "search-a-archived"), false);
    }

    // 5) Cwd isolation for collision dirs
    {
      const x = await searchSessionsForCwd({ cwd: cwdCollideX, query: "zebra", agentDir });
      const y = await searchSessionsForCwd({ cwd: cwdCollideY, query: "zebra", agentDir });
      assert.ok(x.sessions.every((s) => s.id.startsWith("search-x-")));
      assert.equal(y.sessions.length, 0);
    }

    // 6) Empty / short query
    {
      const empty = await searchSessionsForCwd({ cwd: cwdA, query: "   ", agentDir });
      assert.equal(empty.total, 0);
      assert.equal(empty.sessions.length, 0);
      assert.equal(sessionSummaryMatchesQuery({ name: "A", firstMessage: "B" }, ""), false);
    }

    // 7) Hard limit + hasMore
    {
      for (let i = 0; i < 12; i++) {
        writeSession(
          cwdA,
          `search-limit-${i}`,
          new Date(base + 300_000 + i * 1000).toISOString(),
          `limit-token-${i}`,
          { mtimeMs: base + 300_000 + i * 1000, name: `LimitToken ${i}` }
        );
      }
      invalidateSessionIndex();
      await refreshSessionIndex({ agentDir });
      const res = await searchSessionsForCwd({
        cwd: cwdA,
        query: "limittoken",
        agentDir,
        limit: 5,
      });
      assert.equal(res.sessions.length, 5);
      assert.equal(res.hasMore, true);
      assert.ok(res.total >= 12);
      assert.ok(SESSION_SEARCH_MAX_LIMIT >= res.limit);
      const capped = await searchSessionsForCwd({
        cwd: cwdA,
        query: "limittoken",
        agentDir,
        limit: 10_000,
      });
      assert.ok(capped.limit <= SESSION_SEARCH_MAX_LIMIT);
      assert.ok(capped.sessions.length <= SESSION_SEARCH_MAX_LIMIT);
    }

    // 8) Modify JSONL → summary/search updates
    {
      const named = (
        await searchSessionsForCwd({ cwd: cwdA, query: "Project Kickoff", agentDir })
      ).sessions.find((s) => s.id === "search-a-name");
      assert.ok(named);
      const infoLine = {
        type: "session_info",
        id: "search-a-name-renamed",
        parentId: null,
        timestamp: new Date(base + 400_000).toISOString(),
        name: "Renamed Rocket",
      };
      writeFileSync(
        pathNamed,
        `${readFileSync(pathNamed, "utf8")}${JSON.stringify(infoLine)}\n`
      );
      utimesSync(pathNamed, new Date(base + 410_000), new Date(base + 410_000));
      invalidateSessionIndex();
      await refreshSessionIndex({ agentDir });
      const afterRename = await searchSessionsForCwd({
        cwd: cwdA,
        query: "rocket",
        agentDir,
      });
      assert.ok(afterRename.sessions.some((s) => s.id === "search-a-name"));
      const old = await searchSessionsForCwd({
        cwd: cwdA,
        query: "Project Kickoff",
        agentDir,
      });
      assert.equal(old.sessions.some((s) => s.id === "search-a-name"), false);
    }

    // 9) Delete + archive/unarchive refresh
    {
      const delTarget = writeSession(
        cwdA,
        "search-a-delete",
        new Date(base + 500_000).toISOString(),
        "delete-me-token",
        { mtimeMs: base + 500_000 }
      );
      invalidateSessionIndex();
      await refreshSessionIndex({ agentDir });
      assert.ok(
        (await searchSessionsForCwd({ cwd: cwdA, query: "delete-me-token", agentDir })).sessions
          .some((s) => s.id === "search-a-delete")
      );
      rmSync(delTarget, { force: true });
      invalidateSessionIndex();
      await refreshSessionIndex({ agentDir });
      assert.equal(
        (await searchSessionsForCwd({ cwd: cwdA, query: "delete-me-token", agentDir })).sessions
          .length,
        0
      );

      const archPath = writeSession(
        cwdA,
        "search-a-move",
        new Date(base + 520_000).toISOString(),
        "move-archive-token",
        { mtimeMs: base + 520_000 }
      );
      invalidateSessionIndex();
      await refreshSessionIndex({ agentDir });
      const archivedPath = moveToArchive(archPath);
      invalidateSessionIndex();
      const archivedHit = await searchSessionsForCwd({
        cwd: cwdA,
        query: "move-archive-token",
        agentDir,
        includeArchived: true,
      });
      assert.ok(archivedHit.sessions.some((s) => s.id === "search-a-move" && s.archived));

      const restored = join(
        agentDir,
        "sessions",
        ...archivedPath.replace(/\\/g, "/").split("/sessions-archive/")[1].split("/")
      );
      mkdirSync(dirname(restored), { recursive: true });
      renameSync(archivedPath, restored);
      invalidateSessionIndex();
      const restoredHit = await searchSessionsForCwd({
        cwd: cwdA,
        query: "move-archive-token",
        agentDir,
        includeArchived: false,
      });
      assert.ok(restoredHit.sessions.some((s) => s.id === "search-a-move" && !s.archived));
    }

    // 10) Corrupt index rebuilds
    {
      const indexPath = getSessionIndexPath(agentDir);
      writeFileSync(indexPath, "{broken");
      resetSessionIndexRuntimeForTests();
      const rebuilt = await searchSessionsForCwd({
        cwd: cwdA,
        query: "uniquezebra",
        agentDir,
      });
      assert.ok(rebuilt.sessions.some((s) => s.id === "search-a-msg"));
      writeFileSync(indexPath, JSON.stringify({ version: 999, entries: [] }));
      resetSessionIndexRuntimeForTests();
      const rebuilt2 = await searchSessionsForCwd({
        cwd: cwdA,
        query: "uniquezebra",
        agentDir,
      });
      assert.ok(rebuilt2.sessions.some((s) => s.id === "search-a-msg"));
      assert.equal(SESSION_INDEX_VERSION, 2);
    }

    // 11) Client stale response gate
    {
      assert.equal(
        shouldApplySessionSearchResponse({
          aborted: false,
          requestCwd: cwdA,
          activeCwd: cwdA,
          requestSeq: 2,
          latestSeq: 2,
        }),
        true
      );
      assert.equal(
        shouldApplySessionSearchResponse({
          aborted: true,
          requestCwd: cwdA,
          activeCwd: cwdA,
          requestSeq: 2,
          latestSeq: 2,
        }),
        false
      );
      assert.equal(
        shouldApplySessionSearchResponse({
          aborted: false,
          requestCwd: cwdA,
          activeCwd: cwdB,
          requestSeq: 2,
          latestSeq: 2,
        }),
        false,
        "cwd switch must drop stale search responses"
      );
      assert.equal(
        shouldApplySessionSearchResponse({
          aborted: false,
          requestCwd: cwdA,
          activeCwd: cwdA,
          requestSeq: 1,
          latestSeq: 3,
        }),
        false,
        "older request seq must not apply"
      );
    }

    console.log("smoke-session-search: ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
