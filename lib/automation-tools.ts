/**
 * Interactive-session-only automation_tasks multi-action tool.
 * Scheduled-origin sessions must never load this tool.
 */

import {
  buildAuthoritySummary,
  hashProposedConfig,
  setUiApprovalContext,
  type ApprovalAction,
} from "./automation-approval";
import { automationService, AutomationServiceError, buildTaskConfigFromInput } from "./automation-service";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
};

function textResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function errorResult(error: unknown): ToolResult {
  if (error instanceof AutomationServiceError) {
    return textResult({
      ok: false,
      error: error.message,
      code: error.code,
      blockedReason: error.blockedReason,
    });
  }
  return textResult({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code: "error",
  });
}

async function confirmSensitive(
  ui: { confirm?: (message: string) => Promise<boolean> } | undefined,
  action: ApprovalAction,
  summaryLines: string[],
  opts?: {
    taskId?: string;
    runId?: string;
    revision?: string | null;
    policyHash?: string | null;
    cwd?: string | null;
    proposedConfigHash?: string | null;
  },
): Promise<boolean> {
  if (!ui?.confirm) return false;
  const message = [
    `Confirm Automation action: ${action}`,
    ...summaryLines,
    "",
    "Schedules execute only while Snail Pi Web is running.",
  ].join("\n");
  const ok = await ui.confirm(message);
  if (ok) {
    setUiApprovalContext({
      action,
      taskId: opts?.taskId,
      runId: opts?.runId,
      revision: opts?.revision,
      policyHash: opts?.policyHash,
      cwd: opts?.cwd,
      proposedConfigHash: opts?.proposedConfigHash,
      summary: summaryLines,
    });
  }
  return ok;
}

export type AutomationToolExecuteContext = {
  cwd?: string;
  sessionManager?: { getSessionId?: () => string };
  ui?: { confirm?: (message: string) => Promise<boolean> };
};

export const automationTasksToolDefinition = {
  name: "automation_tasks",
  label: "Automation Tasks",
  description:
    "Manage Snail Pi scheduled Automations (list/create/update/activate/pause/archive/run_now/runs/promote/scheduler). Only use when the user explicitly asks. Never invent confirmation.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description:
          "list|get|create|update|activate|resume|pause|archive|run_now|list_runs|get_run|cancel_run|get_run_session|export_run|promote_run|delete_run_artifacts|scheduler_status|repair_scheduler_lock|set_global_disabled|catalog",
      },
      taskId: { type: "string" },
      runId: { type: "string" },
      expectedRevision: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      cron: { type: "string" },
      timezone: { type: "string" },
      cwd: { type: "string" },
      cwdSource: { type: "string", enum: ["project", "default"] },
      provider: { type: "string" },
      modelId: { type: "string" },
      thinking: { type: "string" },
      prompt: { type: "string" },
      maxRuntimeMs: { type: "number" },
      tools: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            origin: { type: "string" },
            sourcePath: { type: "string" },
          },
        },
      },
      budgets: {
        type: "object",
        properties: {
          maxRunsPerDay: { type: "number" },
          maxTokensPerRun: { type: "number" },
          maxMonthlyCostUsd: { type: "number" },
          consecutiveFailureThreshold: { type: "number" },
        },
      },
      approvalExpiresAt: { type: ["string", "null"] },
      /** Required for set_global_disabled — true disables, false enables. */
      disabled: { type: "boolean", description: "Global kill switch value for set_global_disabled" },
      offset: { type: "number", description: "Pagination offset for list/list_runs/get_run_session" },
      limit: { type: "number", description: "Pagination limit for list/list_runs/get_run_session" },
      // Model-supplied confirmed must be ignored for authority.
      confirmed: { type: "boolean" },
    },
    required: ["action"],
  },
  async execute(
    _toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    ctx: AutomationToolExecuteContext,
  ): Promise<ToolResult> {
    void signal;
    try {
      const action = String(params.action || "");
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? null;

      switch (action) {
        case "list":
          return textResult({ ok: true, tasks: automationService.listTasks() });
        case "get":
          return textResult({ ok: true, task: automationService.getTask(String(params.taskId)) });
        case "catalog":
          return textResult({ ok: true, tools: automationService.catalog() });
        case "scheduler_status":
          return textResult({ ok: true, scheduler: automationService.schedulerStatus() });
        case "list_runs": {
          const offset = typeof params.offset === "number" ? params.offset : 0;
          const limit = typeof params.limit === "number" ? params.limit : 50;
          const page = automationService.listRuns(
            params.taskId ? String(params.taskId) : undefined,
            undefined,
            offset,
            limit,
          );
          return textResult({ ok: true, ...page });
        }
        case "get_run":
          return textResult({ ok: true, run: automationService.getRun(String(params.runId)) });
        case "get_run_session": {
          const offset = typeof params.offset === "number" ? params.offset : 0;
          const limit = typeof params.limit === "number" ? params.limit : 100;
          // Equivalent to UI: paginated transcript AND changes projection.
          const session = automationService.getRunSession(
            String(params.runId),
            undefined,
            offset,
            limit,
          );
          return textResult({
            ok: true,
            session,
            changes: (session as { changes?: unknown }).changes ?? null,
          });
        }
        case "create": {
          const task = await automationService.createDraft({
            name: String(params.name ?? ""),
            description: params.description ? String(params.description) : "",
            cron: String(params.cron ?? ""),
            timezone: String(params.timezone ?? "UTC"),
            cwd: params.cwd ? String(params.cwd) : undefined,
            cwdSource: (params.cwdSource as "project" | "default" | undefined) ?? (params.cwd ? "project" : "default"),
            provider: String(params.provider ?? ""),
            modelId: String(params.modelId ?? ""),
            thinking: params.thinking ? String(params.thinking) : null,
            prompt: String(params.prompt ?? ""),
            maxRuntimeMs: typeof params.maxRuntimeMs === "number" ? params.maxRuntimeMs : undefined,
            tools: params.tools as never,
            budgets: params.budgets as never,
            approvalExpiresAt:
              params.approvalExpiresAt === null
                ? null
                : params.approvalExpiresAt
                  ? String(params.approvalExpiresAt)
                  : undefined,
            createdBySessionId: sessionId,
          });
          return textResult({ ok: true, task });
        }
        case "update": {
          const taskId = String(params.taskId);
          const existing = automationService.getTask(taskId);
          const base = (existing.pendingConfig ?? existing.approvedConfig) as import("./automation-types").AutomationTaskConfig;
          // Build proposed config and confirm THAT mutation, not existing state.
          // Preserve tools when omitted; include budgets + approvalExpiresAt for parity.
          const proposed = await buildTaskConfigFromInput({
            name: (params.name as string | undefined) ?? base.name,
            description: (params.description as string | undefined) ?? base.description,
            cron: (params.cron as string | undefined) ?? base.schedule.cron,
            timezone: (params.timezone as string | undefined) ?? base.schedule.timezone,
            cwd: (params.cwd as string | undefined) ?? base.target.cwd,
            cwdSource: (params.cwdSource as "project" | "default" | undefined) ?? base.target.cwdSource,
            provider: (params.provider as string | undefined) ?? base.agent.provider,
            modelId: (params.modelId as string | undefined) ?? base.agent.modelId,
            thinking:
              params.thinking !== undefined ? (params.thinking as string | null) : base.agent.thinking,
            prompt: (params.prompt as string | undefined) ?? base.agent.prompt,
            maxRuntimeMs: (params.maxRuntimeMs as number | undefined) ?? base.agent.maxRuntimeMs,
            tools:
              params.tools !== undefined
                ? (params.tools as never)
                : base.authority.tools.map((t) => ({
                    name: t.name,
                    origin: t.origin,
                    sourcePath: t.sourcePath,
                  })),
            budgets:
              params.budgets !== undefined
                ? { ...base.authority.budgets, ...(params.budgets as object) }
                : base.authority.budgets,
            approvalExpiresAt:
              params.approvalExpiresAt !== undefined
                ? (params.approvalExpiresAt as string | null)
                : base.authority.approvalExpiresAt,
          });
          const proposedHash = hashProposedConfig(proposed);
          const summary = [
            "Proposed mutation (not current approved state):",
            ...buildAuthoritySummary(proposed),
            `Proposed config hash: ${proposedHash.slice(0, 16)}`,
          ];
          const ok = await confirmSensitive(ctx.ui, "update_sensitive", summary, {
            taskId,
            revision: existing.revision,
            policyHash: proposed.authority.policyHash,
            cwd: proposed.target.cwd,
            proposedConfigHash: proposedHash,
          });
          if (!ok) return textResult({ ok: false, code: "approval_required", error: "User declined or no UI" });
          const task = await automationService.updateTask(
            taskId,
            {
              expectedRevision: String(params.expectedRevision ?? existing.revision),
              name: params.name as string | undefined,
              description: params.description as string | undefined,
              cron: params.cron as string | undefined,
              timezone: params.timezone as string | undefined,
              cwd: params.cwd as string | undefined,
              cwdSource: params.cwdSource as "project" | "default" | undefined,
              provider: params.provider as string | undefined,
              modelId: params.modelId as string | undefined,
              thinking: params.thinking as string | undefined,
              prompt: params.prompt as string | undefined,
              maxRuntimeMs: params.maxRuntimeMs as number | undefined,
              tools: params.tools as never,
              budgets: params.budgets as never,
              approvalExpiresAt:
                params.approvalExpiresAt === undefined
                  ? undefined
                  : (params.approvalExpiresAt as string | null),
              sensitive: true,
            },
            { mode: "ui" },
          );
          return textResult({ ok: true, task });
        }
        case "activate":
        case "resume": {
          const taskId = String(params.taskId);
          const existing = automationService.getTask(taskId);
          const resume =
            action === "resume" || existing.status === "paused" || existing.status === "blocked";
          const approvalAction: ApprovalAction = resume ? "resume" : "activate";
          const cfg = (existing.pendingConfig ?? existing.approvedConfig) as import("./automation-types").AutomationTaskConfig;
          const ok = await confirmSensitive(
            ctx.ui,
            approvalAction,
            existing.authoritySummary ?? buildAuthoritySummary(cfg),
            {
              taskId,
              revision: existing.revision,
              policyHash: cfg.authority.policyHash,
              cwd: cfg.target.cwd,
            },
          );
          if (!ok) return textResult({ ok: false, code: "approval_required", error: "User declined or no UI" });
          const task = await automationService.activate(
            taskId,
            String(params.expectedRevision ?? existing.revision),
            { mode: "ui" },
          );
          return textResult({ ok: true, task });
        }
        case "pause": {
          const taskId = String(params.taskId);
          const existing = automationService.getTask(taskId);
          const task = await automationService.pause(
            taskId,
            String(params.expectedRevision ?? existing.revision),
          );
          return textResult({ ok: true, task });
        }
        case "archive": {
          const taskId = String(params.taskId);
          const existing = automationService.getTask(taskId);
          const cfg = existing.approvedConfig as import("./automation-types").AutomationTaskConfig;
          const ok = await confirmSensitive(ctx.ui, "archive", existing.authoritySummary ?? [], {
            taskId,
            revision: existing.revision,
            policyHash: cfg.authority.policyHash,
            cwd: cfg.target.cwd,
          });
          if (!ok) return textResult({ ok: false, code: "approval_required", error: "User declined or no UI" });
          const task = await automationService.archive(
            taskId,
            String(params.expectedRevision ?? existing.revision),
            { mode: "ui" },
          );
          return textResult({ ok: true, task });
        }
        case "run_now": {
          const taskId = String(params.taskId);
          const existing = automationService.getTask(taskId);
          const cfg = existing.approvedConfig as import("./automation-types").AutomationTaskConfig;
          const ok = await confirmSensitive(ctx.ui, "run_now", existing.authoritySummary ?? [], {
            taskId,
            revision: existing.revision,
            policyHash: cfg.authority.policyHash,
            cwd: cfg.target.cwd,
          });
          if (!ok) return textResult({ ok: false, code: "approval_required", error: "User declined or no UI" });
          const run = await automationService.runNow(
            taskId,
            String(params.expectedRevision ?? existing.revision),
            { mode: "ui" },
          );
          return textResult({ ok: true, run });
        }
        case "cancel_run": {
          const runId = String(params.runId);
          const run = automationService.getRun(runId);
          const task = automationService.getTask(String(run.taskId));
          const cfg = task.approvedConfig as import("./automation-types").AutomationTaskConfig;
          const ok = await confirmSensitive(
            ctx.ui,
            "cancel_run",
            [`Cancel run ${runId}`, `Task ${run.taskId}`, `Cwd ${run.cwd}`, `Revision ${task.revision}`],
            {
              taskId: run.taskId,
              runId,
              cwd: run.cwd,
              revision: task.revision,
              policyHash: cfg.authority.policyHash,
            },
          );
          if (!ok) return textResult({ ok: false, code: "approval_required", error: "User declined or no UI" });
          const updated = await automationService.cancelRun(runId, { mode: "ui" });
          return textResult({ ok: true, run: updated });
        }
        case "export_run": {
          const runId = String(params.runId);
          const run = automationService.getRun(runId);
          const task = automationService.getTask(String(run.taskId));
          const cfg = task.approvedConfig as import("./automation-types").AutomationTaskConfig;
          const ok = await confirmSensitive(
            ctx.ui,
            "export_run",
            [`Export run ${runId}`, `Cwd ${run.cwd}`, `Revision ${task.revision}`],
            {
              taskId: run.taskId,
              runId,
              cwd: run.cwd,
              revision: task.revision,
              policyHash: cfg.authority.policyHash,
            },
          );
          if (!ok) return textResult({ ok: false, code: "approval_required", error: "User declined or no UI" });
          const exported = await automationService.exportRun(runId, { mode: "ui" });
          return textResult({
            ok: true,
            runId: exported.runId,
            filename: exported.filename,
            bytes: exported.content.byteLength,
            contentBase64: exported.content.toString("base64").slice(0, 200) + "…",
          });
        }
        case "promote_run": {
          const runId = String(params.runId);
          const run = automationService.getRun(runId);
          const task = automationService.getTask(String(run.taskId));
          const cfg = task.approvedConfig as import("./automation-types").AutomationTaskConfig;
          const ok = await confirmSensitive(
            ctx.ui,
            "promote",
            [`Promote run ${runId}`, `Cwd ${run.cwd}`, `Revision ${task.revision}`],
            {
              taskId: run.taskId,
              runId,
              cwd: run.cwd,
              revision: task.revision,
              policyHash: cfg.authority.policyHash,
            },
          );
          if (!ok) return textResult({ ok: false, code: "approval_required", error: "User declined or no UI" });
          const promotion = await automationService.promoteRun(runId, { mode: "ui" });
          return textResult({ ok: true, promotion });
        }
        case "delete_run_artifacts": {
          const runId = String(params.runId);
          const run = automationService.getRun(runId);
          const task = automationService.getTask(String(run.taskId));
          const cfg = task.approvedConfig as import("./automation-types").AutomationTaskConfig;
          const ok = await confirmSensitive(
            ctx.ui,
            "delete_artifacts",
            [`Delete artifacts for run ${runId}`, `Cwd ${run.cwd}`, `Revision ${task.revision}`],
            {
              taskId: run.taskId,
              runId,
              cwd: run.cwd,
              revision: task.revision,
              policyHash: cfg.authority.policyHash,
            },
          );
          if (!ok) return textResult({ ok: false, code: "approval_required", error: "User declined or no UI" });
          const result = await automationService.deleteRunArtifacts(runId, { mode: "ui" });
          return textResult({ ok: true, result });
        }
        case "repair_scheduler_lock": {
          const ok = await confirmSensitive(ctx.ui, "repair_scheduler", ["Repair scheduler lock"]);
          if (!ok) return textResult({ ok: false, code: "approval_required", error: "User declined or no UI" });
          const result = await automationService.repairSchedulerLock({ mode: "ui" });
          return textResult({ ok: true, result });
        }
        case "set_global_disabled": {
          const disabled = Boolean(params.disabled);
          const ok = await confirmSensitive(
            ctx.ui,
            "set_global_disabled",
            [`Set global Automation disabled=${disabled}`],
          );
          if (!ok) return textResult({ ok: false, code: "approval_required", error: "User declined or no UI" });
          const scheduler = await automationService.setDisabled(disabled, { mode: "ui" });
          return textResult({ ok: true, scheduler });
        }
        default:
          return textResult({ ok: false, code: "validation", error: `Unknown action: ${action}` });
      }
    } catch (error) {
      return errorResult(error);
    }
  },
};

export function createAutomationToolDefinitions(): unknown[] {
  return [
    {
      name: automationTasksToolDefinition.name,
      label: automationTasksToolDefinition.label,
      description: automationTasksToolDefinition.description,
      parameters: automationTasksToolDefinition.parameters,
      execute: automationTasksToolDefinition.execute,
    },
  ];
}
