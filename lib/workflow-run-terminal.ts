import { normalizeCheckResult, normalizeImplementResult } from "./workflow-prompts";
import type { NormalizedWorkflowNativeResult } from "./workflow-native-result";
import type { WorkflowRunRecord, WorkflowRunState } from "./workflow-types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function missingExpectedMutation(child: Record<string, unknown> | null): boolean {
  if (!child || !isRecord(child.effects) || !isRecord(child.effects.fileMutation)) return false;
  return child.effects.fileMutation.status === "missing" && child.effects.fileMutation.expected === true;
}

function isValidatedNoChange(result: ReturnType<typeof normalizeImplementResult>): boolean {
  return Boolean(
    result &&
    result.outcome === "validated_no_change" &&
    result.acceptanceSatisfied === true &&
    result.changedFiles.length === 0 &&
    result.validation.length > 0 &&
    result.validation.every((validation) => validation.ok),
  );
}

export function applyWorkflowNativeTerminal(
  run: WorkflowRunRecord,
  result: NormalizedWorkflowNativeResult & {
    kind: "terminal";
    state: Extract<WorkflowRunState, "completed" | "failed" | "cancelled">;
    snapshotIntegrityError?: string | null;
  },
): WorkflowRunRecord {
  const { child, details, state } = result;
  const endedAt = new Date().toISOString();
  const summaryText = result.text.trim();
  const normalizedImplement =
    state === "completed" && run.phase === "implement"
      ? normalizeImplementResult(summaryText)
      : run.implementResult;
  const invalidNoChange = state === "completed" && run.phase === "implement" &&
    missingExpectedMutation(child) && !isValidatedNoChange(normalizedImplement);
  const snapshotIntegrityError = result.snapshotIntegrityError?.trim() || null;
  const finalState = snapshotIntegrityError || invalidNoChange ? "failed" : state;
  const implementResult = finalState === "completed" ? normalizedImplement : run.implementResult;
  const checkResult =
    finalState === "completed" && run.phase === "check"
      ? normalizeCheckResult(summaryText)
      : run.checkResult;
  const summary = run.phase === "implement"
    ? normalizedImplement?.summary ?? summaryText
    : checkResult?.summary ?? summaryText;
  return {
    ...run,
    state: finalState,
    nativeRunId: optionalString(details?.runId) ?? optionalString(details?.id) ?? run.nativeRunId,
    asyncDir: optionalString(details?.asyncDir) ?? run.asyncDir,
    sessionFile:
      optionalString(child?.sessionFile) ?? optionalString(details?.sessionFile) ?? run.sessionFile,
    outputFile: optionalString(details?.outputFile) ?? run.outputFile,
    model: optionalString(child?.model) ?? optionalString(details?.model) ?? run.model,
    thinking:
      optionalString(child?.thinking) ??
      optionalString(child?.thinkingLevel) ??
      optionalString(details?.thinking) ??
      run.thinking,
    summary: summary || run.summary,
    implementResult,
    checkResult,
    error:
      finalState === "completed"
        ? null
        : {
            code: snapshotIntegrityError
              ? "snapshot_integrity"
              : invalidNoChange
                ? "invalid_no_change"
                : finalState,
            message: snapshotIntegrityError ?? (invalidNoChange
              ? "Implementation made no observed edits and did not provide a validated_no_change result with passing validation."
              : result.diagnostic || `Native subagent run ${finalState}`),
          },
    endedAt: run.endedAt ?? endedAt,
    lastReconciledAt: endedAt,
  };
}
