import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath, buildSessionContext } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { canonicalizeCwd } from "@/lib/cwd";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const liveSession = getRpcSession(id);
    const liveManager = liveSession?.isAlive()
      && liveSession.sessionFile
      && canonicalizeCwd(liveSession.sessionFile) === canonicalizeCwd(filePath)
      ? liveSession.inner.sessionManager
      : null;
    const sm = liveManager ?? SessionManager.open(filePath);
    const context = buildSessionContext(sm.getEntries() as never, leafId);

    return NextResponse.json({ context });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
