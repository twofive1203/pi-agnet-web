import { NextResponse } from "next/server";
import {
  invalidateSessionPathCache,
  readSessionHeaderLine,
  resolveLiveOrDiskSessionManager,
  resolveSessionPath,
} from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import {
  buildSessionTranscriptPage,
  httpStatusForTranscriptError,
  parseTranscriptSearchParams,
} from "@/lib/session-transcript";
import type { SessionEntry } from "@/lib/types";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const peeked = readSessionHeaderLine(filePath);
    if (!peeked || peeked.id !== id) {
      invalidateSessionPathCache(id);
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    let entries: SessionEntry[];
    let currentLeafId: string | null;
    try {
      const sm = resolveLiveOrDiskSessionManager(filePath, getRpcSession(id));
      const header = sm.getHeader();
      if (!header?.id || header.id !== id) {
        invalidateSessionPathCache(id);
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      entries = sm.getEntries() as unknown as SessionEntry[];
      currentLeafId = sm.getLeafId();
    } catch {
      invalidateSessionPathCache(id);
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const query = parseTranscriptSearchParams(new URL(req.url).searchParams);
    try {
      const transcript = buildSessionTranscriptPage(entries, {
        leafId: query.leafId ?? currentLeafId,
        beforeEntryId: query.beforeEntryId,
        limit: query.limit,
      });
      return NextResponse.json(transcript);
    } catch (error) {
      const mapped = httpStatusForTranscriptError(error);
      if (mapped.status < 500) {
        return NextResponse.json({ error: mapped.error }, { status: mapped.status });
      }
      throw error;
    }
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
