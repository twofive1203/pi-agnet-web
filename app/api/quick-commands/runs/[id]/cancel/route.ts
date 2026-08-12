import { NextResponse } from "next/server";
import {
  cancelQuickCommandRun,
  QuickCommandRunnerError,
} from "@/lib/quick-command-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const run = cancelQuickCommandRun(id);
    return NextResponse.json({ run });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof QuickCommandRunnerError ? error.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
