import { NextResponse } from "next/server";
import {
  dismissQuickCommandRun,
  getQuickCommandRun,
  QuickCommandRunnerError,
} from "@/lib/quick-command-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const run = getQuickCommandRun(id);
    if (!run) {
      return NextResponse.json({ error: "Quick command run not found" }, { status: 404 });
    }
    return NextResponse.json({ run });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof QuickCommandRunnerError ? error.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/** DELETE: drop a finished run from the in-memory recent list (UI clear). */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    dismissQuickCommandRun(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof QuickCommandRunnerError ? error.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
