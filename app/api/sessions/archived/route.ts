import { NextResponse } from "next/server";
import {
  ARCHIVED_SESSIONS_LIMIT,
  listArchivedSessionsForCwd,
  type SessionPageResult,
} from "@/lib/session-reader";

/**
 * GET /api/sessions/archived?cwd=
 *
 * Optional pagination: `limit` (default 20), `before`, `beforePath`.
 * Without pagination params, returns the full archived list for the cwd (compat).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const cwd = url.searchParams.get("cwd");
    if (!cwd) {
      return NextResponse.json({ error: "cwd query parameter is required" }, { status: 400 });
    }

    const limitParam = url.searchParams.get("limit");
    const before = url.searchParams.get("before");
    const beforePath = url.searchParams.get("beforePath");
    const wantsPage =
      (limitParam != null && limitParam !== "") ||
      (before != null && before !== "") ||
      (beforePath != null && beforePath !== "");

    if (!wantsPage) {
      const sessions = await listArchivedSessionsForCwd(cwd);
      return NextResponse.json({ sessions });
    }

    const limit = limitParam != null && limitParam !== ""
      ? Number(limitParam)
      : ARCHIVED_SESSIONS_LIMIT;
    const safeLimit = Number.isFinite(limit) ? limit : ARCHIVED_SESSIONS_LIMIT;
    const page = (await listArchivedSessionsForCwd(cwd, {
      limit: safeLimit,
      before: before ?? undefined,
      beforePath: beforePath ?? undefined,
    })) as SessionPageResult;

    return NextResponse.json({
      sessions: page.sessions,
      cwd,
      limit: page.limit,
      total: page.total,
      hasMore: page.hasMore,
      nextBefore: page.nextBefore,
      nextBeforePath: page.nextBeforePath,
      loadedHint: page.sessions.length,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
