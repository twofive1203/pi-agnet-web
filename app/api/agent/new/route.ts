import { NextResponse } from "next/server";
import { startNewAgentSession } from "@/lib/new-agent-session";

// POST /api/agent/new  body: { cwd: string; type: string; message: string; ... }
// Spawns a brand-new pi session and immediately sends the first command.
// Returns { sessionId, data } where sessionId is pi's real session id.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;
    const result = await startNewAgentSession({ cwd: cwd ?? "", command });
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ success: true, sessionId: result.sessionId, data: result.data });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
