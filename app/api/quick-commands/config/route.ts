import { NextResponse } from "next/server";
import {
  QuickCommandStoreError,
  readQuickCommandConfig,
  resolveAuthorizedProjectCwd,
  writeQuickCommandConfig,
} from "@/lib/quick-command-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET: full project quick-command config for the management UI. */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const cwd = await resolveAuthorizedProjectCwd(url.searchParams.get("cwd"));
    const config = readQuickCommandConfig(cwd);
    return NextResponse.json({
      cwd,
      configPath: `${cwd.replace(/\\/g, "/")}/.pi/quick-commands.json`,
      config,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof QuickCommandStoreError ? error.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/** PUT: replace project quick-command definitions (revision-checked). */
export async function PUT(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      cwd?: unknown;
      commands?: unknown;
      expectedRevision?: unknown;
    };
    const cwd = await resolveAuthorizedProjectCwd(body.cwd);
    const expectedRevision =
      typeof body.expectedRevision === "string" || body.expectedRevision === null
        ? body.expectedRevision
        : undefined;
    const config = writeQuickCommandConfig(cwd, body.commands, expectedRevision);
    return NextResponse.json({
      cwd,
      configPath: `${cwd.replace(/\\/g, "/")}/.pi/quick-commands.json`,
      config,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof QuickCommandStoreError ? error.status : 500;
    const code = error instanceof QuickCommandStoreError ? error.code : undefined;
    return NextResponse.json({ error: message, code }, { status });
  }
}
