import { stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { getAllowedRoots, isPathAllowed } from "@/lib/allowed-roots";
import { canonicalizeCwd } from "@/lib/cwd";
import { runExtensionCommand, type ExtensionCommandResult } from "@/lib/extension-command-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROVIDER_USAGE_COMMANDS: Record<string, string> = {
  "grok-cli": "grok-cli-usage",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failureStatus(result: ExtensionCommandResult): number {
  if (result.failure === "command_unavailable") return 404;
  if (result.failure === "timed_out") return 504;
  if (result.failure === "aborted") return 499;
  return 502;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider } = await context.params;
  const command = PROVIDER_USAGE_COMMANDS[provider];
  if (!command) {
    return NextResponse.json({ error: `Usage is not supported for provider: ${provider}` }, { status: 404 });
  }

  const body = await request.json().catch(() => null) as unknown;
  const cwd = isRecord(body) && typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (!cwd) {
    return NextResponse.json({ error: "A workspace is required to query extension usage." }, { status: 400 });
  }

  const canonicalCwd = canonicalizeCwd(cwd);
  const allowedRoots = await getAllowedRoots();
  if (!isPathAllowed(canonicalCwd, allowedRoots)) {
    return NextResponse.json({ error: "Workspace access denied." }, { status: 403 });
  }

  try {
    const cwdStat = await stat(canonicalCwd);
    if (!cwdStat.isDirectory()) {
      return NextResponse.json({ error: "The selected workspace is not a directory." }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "The selected workspace does not exist." }, { status: 400 });
  }

  const result = await runExtensionCommand(canonicalCwd, command, { signal: request.signal });
  return NextResponse.json(
    { provider, ...result },
    { status: result.executed ? 200 : failureStatus(result) },
  );
}
