import { NextResponse } from "next/server";
import {
  listAllSessions,
  listProjectSummaries,
  listRecentSessionsForCwd,
  RECENT_SESSIONS_LIMIT,
  scanArchivedCwds,
} from "@/lib/session-reader";

/**
 * GET /api/sessions
 *
 * Modes:
 * - `?view=projects` — lightweight project summaries for the sidebar (no full JSONL scan).
 * - `?cwd=<path>&limit=10&before=&beforePath=` — paged recent active sessions for one project
 *   (mtime-ordered, bounded JSONL parse + optional parent closure).
 * - default (no browser view params) — full active session list for Usage/compat callers.
 *
 * Always includes archivedCwds / archivedCounts for project picker visibility.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const view = url.searchParams.get("view");
    const cwd = url.searchParams.get("cwd");
    const limitParam = url.searchParams.get("limit");
    const before = url.searchParams.get("before") ?? undefined;
    const beforePath = url.searchParams.get("beforePath") ?? undefined;
    const { cwds: archivedCwds, counts: archivedCounts } = scanArchivedCwds();

    if (view === "projects") {
      const projects = await listProjectSummaries();
      return NextResponse.json({ projects, archivedCwds, archivedCounts });
    }

    if (cwd) {
      const limit = limitParam != null && limitParam !== ""
        ? Number(limitParam)
        : RECENT_SESSIONS_LIMIT;
      const safeLimit = Number.isFinite(limit) ? limit : RECENT_SESSIONS_LIMIT;
      const page = await listRecentSessionsForCwd(cwd, {
        limit: safeLimit,
        before,
        beforePath,
      });
      return NextResponse.json({
        sessions: page.sessions,
        cwd,
        limit: page.limit,
        total: page.total,
        hasMore: page.hasMore,
        nextBefore: page.nextBefore,
        nextBeforePath: page.nextBeforePath,
        loadedHint: page.sessions.length,
        archivedCwds,
        archivedCounts,
      });
    }

    // Full list — do not change semantics for non-sidebar consumers.
    const sessions = await listAllSessions();
    return NextResponse.json({ sessions, archivedCwds, archivedCounts });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
