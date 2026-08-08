import { NextResponse } from "next/server";
import {
  searchSessionsForCwd,
  SESSION_SEARCH_DEFAULT_LIMIT,
  SESSION_SEARCH_MIN_QUERY_CHARS,
} from "@/lib/session-search";

/**
 * GET /api/sessions/search?cwd=...&q=...&includeArchived=1&limit=50
 *
 * Workspace-scoped full session search over indexed name + firstMessage.
 * Independent from recent/archived pagination so UI state cannot cross-contaminate.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const cwd = url.searchParams.get("cwd") ?? "";
    const q = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
    const includeArchivedParam = url.searchParams.get("includeArchived");
    const includeArchived =
      includeArchivedParam == null ||
      includeArchivedParam === "" ||
      includeArchivedParam === "1" ||
      includeArchivedParam.toLowerCase() === "true";
    const limitParam = url.searchParams.get("limit");
    const limit =
      limitParam != null && limitParam !== ""
        ? Number(limitParam)
        : SESSION_SEARCH_DEFAULT_LIMIT;

    if (!cwd.trim()) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }

    const trimmed = q.trim();
    if (trimmed.length < SESSION_SEARCH_MIN_QUERY_CHARS) {
      return NextResponse.json({
        sessions: [],
        total: 0,
        hasMore: false,
        query: q,
        cwd,
        limit: Number.isFinite(limit) ? limit : SESSION_SEARCH_DEFAULT_LIMIT,
        minQueryChars: SESSION_SEARCH_MIN_QUERY_CHARS,
      });
    }

    const result = await searchSessionsForCwd({
      cwd,
      query: q,
      includeArchived,
      limit: Number.isFinite(limit) ? limit : SESSION_SEARCH_DEFAULT_LIMIT,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
