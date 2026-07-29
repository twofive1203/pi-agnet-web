import { jsonError, jsonOk, withAutomationRead } from "@/lib/automation-api";
import { automationService } from "@/lib/automation-service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    withAutomationRead(req);
    const { searchParams } = new URL(req.url);
    let cwd = searchParams.get("cwd");
    const cron = searchParams.get("cron");
    const timezone = searchParams.get("timezone");
    const useDefault = searchParams.get("defaultCwd") === "1" || searchParams.get("defaultCwd") === "true";

    // Stable default cwd resolves to its canonical path for authoritative target resources.
    if ((!cwd || !cwd.trim()) && useDefault) {
      cwd = automationService.resolveDefaultCwdCanonical() ?? cwd;
    }

    let nextPreview: unknown[] | undefined;
    if (cron && timezone) {
      try {
        nextPreview = automationService.previewSchedule({ cron, timezone, count: 5 });
      } catch {
        nextPreview = [];
      }
    }

    if (cwd && cwd.trim()) {
      const { existsSync, statSync } = await import("fs");
      const pathExists = existsSync(cwd);
      let isDirectory = false;
      if (pathExists) {
        try {
          isDirectory = statSync(cwd).isDirectory();
        } catch {
          isDirectory = false;
        }
      }
      if (!pathExists || !isDirectory) {
        return jsonOk({
          tools: [],
          models: [],
          cwd,
          nextPreview: nextPreview ?? [],
          diagnostics: {
            cwdExists: false,
            isDirectory,
            pathExists,
            source: "target-cwd",
            reason: !pathExists ? "cwd_missing" : "cwd_not_directory",
          },
        });
      }
      const [tools, models] = await Promise.all([
        automationService.catalogForCwd(cwd),
        automationService.modelsForCwd(cwd),
      ]);
      return jsonOk({
        tools,
        models,
        cwd,
        nextPreview: nextPreview ?? [],
        diagnostics: {
          cwdExists: true,
          isDirectory: true,
          pathExists: true,
          source: "target-cwd",
        },
      });
    }

    // Await actual SDK schemas so cold UI catalogs never freeze interim fallback digests.
    const tools = await automationService.catalogAsync();
    return jsonOk({
      tools,
      models: [],
      nextPreview: nextPreview ?? [],
      diagnostics: { source: "static-default" },
    });
  } catch (error) {
    return jsonError(error);
  }
}
