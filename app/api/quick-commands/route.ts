import { NextResponse } from "next/server";
import {
  listActiveQuickCommandRuns,
  listQuickCommandRuns,
} from "@/lib/quick-command-runner";
import {
  QuickCommandStoreError,
  readQuickCommandConfig,
  resolveAuthorizedProjectCwd,
} from "@/lib/quick-command-store";
import type { QuickCommandListItem } from "@/lib/quick-command-types";
import { isQuickCommandActiveStatus } from "@/lib/quick-command-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET: list enabled project quick commands + lightweight run projection. */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const cwdParam = url.searchParams.get("cwd");
    const cwd = await resolveAuthorizedProjectCwd(cwdParam);
    const config = readQuickCommandConfig(cwd);
    const runs = listQuickCommandRuns(cwd);
    const activeByCommand = new Map<string, (typeof runs)[number]>();
    for (const run of runs) {
      if (!isQuickCommandActiveStatus(run.status)) continue;
      if (!activeByCommand.has(run.commandId)) activeByCommand.set(run.commandId, run);
    }

    const commands: QuickCommandListItem[] = config.commands
      .filter((command) => command.enabled)
      .map((command) => {
        const active = activeByCommand.get(command.id) ?? null;
        return {
          id: command.id,
          name: command.name,
          description: command.description,
          command: command.command,
          cwd: command.cwd,
          confirmBeforeRun: command.confirmBeforeRun,
          autoExpandOutput: command.autoExpandOutput,
          enabled: command.enabled,
          order: command.order,
          activeRunId: active?.id ?? null,
          activeStatus: active?.status ?? null,
        };
      });

    return NextResponse.json({
      cwd,
      revision: config.revision,
      commands,
      activeRuns: listActiveQuickCommandRuns(cwd),
      recentRuns: runs.slice(0, 12),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof QuickCommandStoreError ? error.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
