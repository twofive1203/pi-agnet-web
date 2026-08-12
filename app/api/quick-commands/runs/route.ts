import { NextResponse } from "next/server";
import {
  listQuickCommandRuns,
  QuickCommandRunnerError,
  startQuickCommandRun,
} from "@/lib/quick-command-runner";
import {
  QuickCommandStoreError,
  resolveAuthorizedProjectCwd,
} from "@/lib/quick-command-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET: recent/active runs for a project cwd. */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const cwd = await resolveAuthorizedProjectCwd(url.searchParams.get("cwd"));
    return NextResponse.json({
      cwd,
      runs: listQuickCommandRuns(cwd),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      error instanceof QuickCommandStoreError || error instanceof QuickCommandRunnerError
        ? error.status
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * POST: start a run by saved commandId only.
 * Body may not carry executable command text — server re-reads project config.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      cwd?: unknown;
      commandId?: unknown;
      trustConfirmed?: unknown;
      trustDigest?: unknown;
    };
    const result = await startQuickCommandRun(body);
    if (!result.ok) {
      const status =
        result.code === "forbidden"
          ? 403
          : result.code === "not_found"
            ? 404
            : result.code === "limit" || result.code === "busy"
              ? 409
              : result.code === "trust_required"
                ? 428
                : 400;
      return NextResponse.json(result, { status });
    }
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      error instanceof QuickCommandStoreError || error instanceof QuickCommandRunnerError
        ? error.status
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
