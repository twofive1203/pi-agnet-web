/**
 * Prompt builders and structured-output normalizers for SnFlow implement/check phases.
 */

import {
  isValidWorkflowRunId,
  isValidWorkflowTaskId,
  isWorkflowRunPhase,
  type WorkflowCheckFinding,
  type WorkflowCheckResult,
  type WorkflowCheckVerdict,
  type WorkflowImplementResult,
  type WorkflowRunPhase,
  type WorkflowValidationResult,
} from "./workflow-types";

export const WORKFLOW_DISPATCH_PROTOCOL_VERSION = 1 as const;
export const WORKFLOW_DISPATCH_MARKER_PREFIX = "SNFLOW_DISPATCH ";
export const WORKFLOW_IMPLEMENT_AGENT = "snflow-implement";
export const WORKFLOW_CHECK_AGENT = "snflow-check";

export interface WorkflowDispatchMarker {
  v: typeof WORKFLOW_DISPATCH_PROTOCOL_VERSION;
  taskId: string;
  phase: WorkflowRunPhase;
  revision: string;
  cwd: string;
  /** Optional v1 extension used by new dispatches; omitted by legacy assets. */
  runId?: string;
  /** Immutable requirements/design/plan digest for the run-owned snapshot. */
  specRevision?: string;
}

export class WorkflowDispatchMarkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowDispatchMarkerError";
  }
}

export interface WorkflowPromptContext {
  taskId: string;
  title: string;
  cwd: string;
  pathLabels: {
    requirements: string;
    design: string;
    plan: string;
    taskJson: string;
  };
  phase: WorkflowRunPhase;
  /** Optional summary from the latest implement run, for check phase. */
  implementSummary?: string | null;
  taskRevision: string;
  runId?: string;
  specRevision?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function buildWorkflowDispatchMarker(
  marker: Omit<WorkflowDispatchMarker, "v">,
): string {
  return `${WORKFLOW_DISPATCH_MARKER_PREFIX}${JSON.stringify({
    v: WORKFLOW_DISPATCH_PROTOCOL_VERSION,
    taskId: marker.taskId,
    phase: marker.phase,
    revision: marker.revision,
    cwd: marker.cwd,
    ...(marker.runId ? { runId: marker.runId } : {}),
    ...(marker.specRevision ? { specRevision: marker.specRevision } : {}),
  })}`;
}

/** Returns null for ordinary prompts and throws for a malformed SnFlow marker. */
export function parseWorkflowDispatchMarker(text: unknown): WorkflowDispatchMarker | null {
  if (typeof text !== "string") return null;
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.startsWith(WORKFLOW_DISPATCH_MARKER_PREFIX)) return null;
  if (firstLine.length > 4096) {
    throw new WorkflowDispatchMarkerError("SnFlow dispatch marker exceeds 4096 characters");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(firstLine.slice(WORKFLOW_DISPATCH_MARKER_PREFIX.length));
  } catch {
    throw new WorkflowDispatchMarkerError("SnFlow dispatch marker is not valid JSON");
  }
  if (!isRecord(raw) || raw.v !== WORKFLOW_DISPATCH_PROTOCOL_VERSION) {
    throw new WorkflowDispatchMarkerError("Unsupported SnFlow dispatch marker version");
  }
  if (!isValidWorkflowTaskId(raw.taskId)) {
    throw new WorkflowDispatchMarkerError("Invalid SnFlow dispatch task id");
  }
  if (!isWorkflowRunPhase(raw.phase)) {
    throw new WorkflowDispatchMarkerError("Invalid SnFlow dispatch phase");
  }
  if (typeof raw.revision !== "string" || !/^[a-f0-9]{16}$/.test(raw.revision)) {
    throw new WorkflowDispatchMarkerError("Invalid SnFlow dispatch task revision");
  }
  if (typeof raw.cwd !== "string" || !raw.cwd.trim() || raw.cwd.length > 2048) {
    throw new WorkflowDispatchMarkerError("Invalid SnFlow dispatch cwd");
  }
  if (raw.runId !== undefined &&
    (typeof raw.runId !== "string" || !isValidWorkflowRunId(raw.runId))) {
    throw new WorkflowDispatchMarkerError("Invalid SnFlow dispatch run id");
  }
  if (raw.specRevision !== undefined &&
    (typeof raw.specRevision !== "string" || !/^[a-f0-9]{16}$/.test(raw.specRevision))) {
    throw new WorkflowDispatchMarkerError("Invalid SnFlow dispatch specification revision");
  }
  return {
    v: WORKFLOW_DISPATCH_PROTOCOL_VERSION,
    taskId: raw.taskId,
    phase: raw.phase,
    revision: raw.revision,
    cwd: raw.cwd,
    ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
    ...(typeof raw.specRevision === "string" ? { specRevision: raw.specRevision } : {}),
  };
}

function normalizeValidation(value: unknown): WorkflowValidationResult[] {
  if (!Array.isArray(value)) return [];
  const out: WorkflowValidationResult[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const summary = asString(item.summary) ?? asString(item.message);
    if (!summary) continue;
    out.push({
      command: asString(item.command),
      ok: item.ok === true || item.passed === true || item.success === true,
      summary,
    });
  }
  return out;
}

export function buildImplementPrompt(ctx: WorkflowPromptContext): string {
  return [
    `Implement SnFlow task ${ctx.taskId}: ${ctx.title}`,
    `Project cwd: ${ctx.cwd}`,
    `Dispatch state revision: ${ctx.taskRevision}`,
    ...(ctx.specRevision ? [`Approved specification revision: ${ctx.specRevision}`] : []),
    ctx.specRevision
      ? "After launch, resolve task.json activeRunId and verify the run record's taskRevision/specRevision. Read only the run-owned snapshot document paths below; the live task revision and documents may change without changing this run."
      : "Legacy dispatch: verify the active run record's taskRevision and use the explicit document paths below.",
    "",
    "Read:",
    `- ${ctx.pathLabels.taskJson}`,
    `- ${ctx.pathLabels.requirements}`,
    `- ${ctx.pathLabels.design}`,
    `- ${ctx.pathLabels.plan}`,
    "- .pi/snflows/spec/index.md and applicable layer indexes",
    "- project-root AGENTS.md",
    "",
    "Execute:",
    "1. Implement the approved requirements and design using existing project patterns.",
    "2. Keep the diff focused and report any task/spec conflict in residualRisks.",
    "3. Run practical focused validation for the changed area.",
    "4. Return a concise summary followed by this final fenced JSON result:",
    "```json",
    "{",
    '  "summary": "what changed",',
    '  "outcome": "changed" | "validated_no_change",',
    '  "acceptanceSatisfied": true,',
    '  "changedFiles": ["path/one.ts"],',
    '  "validation": [{"command": "npm run lint", "ok": true, "summary": "pass"}],',
    '  "residualRisks": ["optional risk"]',
    "}",
    "```",
  ].join("\n");
}

export function buildCheckPrompt(ctx: WorkflowPromptContext): string {
  return [
    `Review SnFlow task ${ctx.taskId}: ${ctx.title}`,
    `Project cwd: ${ctx.cwd}`,
    `Dispatch state revision: ${ctx.taskRevision}`,
    ...(ctx.specRevision ? [`Approved specification revision: ${ctx.specRevision}`] : []),
    ctx.specRevision
      ? "After launch, resolve task.json activeRunId and verify the run record's taskRevision/specRevision. Read only the run-owned snapshot document paths below; the live task revision and documents may change without changing this run."
      : "Legacy dispatch: verify the active run record's taskRevision and use the explicit document paths below.",
    "",
    "Read:",
    `- ${ctx.pathLabels.taskJson}`,
    `- ${ctx.pathLabels.requirements}`,
    `- ${ctx.pathLabels.design}`,
    `- ${ctx.pathLabels.plan}`,
    "- .pi/snflows/spec/index.md and applicable layer indexes",
    "- project-root AGENTS.md",
    "- the current diff and affected callers",
    "",
    ctx.implementSummary
      ? `Latest implementation summary:\n${ctx.implementSummary}`
      : "No implementation summary was provided; derive scope from the task documents and diff.",
    "",
    "Execute:",
    "1. Check the implementation against the acceptance criteria, design, project specs, and concrete regression risks without expanding the approved scope.",
    "2. Classify only must-fix issues as error: violated acceptance criteria, incorrect behavior, security/data-loss risk, concrete regressions, or required validation failures attributable to the implementation.",
    "3. Classify optional hardening, maintainability, style, extra tests, and out-of-scope improvements as warning or info.",
    "4. Return changes_requested only when at least one error finding exists. Warnings/info are advisory and must produce pass so the user can choose whether to address them.",
    "5. Run practical focused validation and cite concrete paths for findings.",
    "6. Return a concise review followed by this final fenced JSON result:",
    "```json",
    "{",
    '  "verdict": "pass" | "changes_requested",',
    '  "summary": "review summary",',
    '  "findings": [{"severity": "error|warning|info", "summary": "...", "path": "optional"}],',
    '  "validation": [{"command": "npm run lint", "ok": true, "summary": "pass"}]',
    "}",
    "```",
  ].join("\n");
}

export function buildPhasePrompt(ctx: WorkflowPromptContext): string {
  const marker = buildWorkflowDispatchMarker({
    taskId: ctx.taskId,
    phase: ctx.phase,
    revision: ctx.taskRevision,
    cwd: ctx.cwd,
    runId: ctx.runId,
    specRevision: ctx.specRevision,
  });
  const body = ctx.phase === "implement" ? buildImplementPrompt(ctx) : buildCheckPrompt(ctx);
  return `${marker}\n\n${body}`;
}

export function buildDirectSubagentInstruction(ctx: WorkflowPromptContext): string {
  const agent = agentNameForPhase(ctx.phase);
  return [
    `Call the current chat's native subagent tool once using project agent ${agent}.`,
    `agent: ${agent}`,
    "context: fresh",
    `cwd: ${ctx.cwd}`,
    "agentContract: { version: 1 }",
    "async: false (foreground; do not detach)",
    "clarify: false",
    "task must be exactly the following marked prompt:",
    "```text",
    buildPhasePrompt(ctx),
    "```",
    "Do not run scripts/snflow-task.ts implement, check, or wait.",
  ].join("\n");
}

export function agentNameForPhase(phase: WorkflowRunPhase): string {
  return phase === "implement" ? WORKFLOW_IMPLEMENT_AGENT : WORKFLOW_CHECK_AGENT;
}

function extractJsonCandidate(text: string): unknown | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim())
    .filter((block): block is string => Boolean(block))
    .reverse();
  for (const block of fenced) {
    try {
      return JSON.parse(block) as unknown;
    } catch {
      // Try the next fenced block.
    }
  }
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

export function normalizeImplementResult(text: string | null | undefined): WorkflowImplementResult | null {
  if (!text?.trim()) return null;
  const candidate = extractJsonCandidate(text);
  if (!isRecord(candidate)) {
    return {
      summary: text.trim().slice(0, 4000),
      changedFiles: [],
      validation: [],
      residualRisks: ["Structured implement result JSON was missing; used raw summary text."],
    };
  }
  const outcome = asString(candidate.outcome)?.toLowerCase();
  return {
    summary: asString(candidate.summary) ?? text.trim().slice(0, 2000),
    changedFiles: asStringArray(candidate.changedFiles ?? candidate.files),
    validation: normalizeValidation(candidate.validation),
    residualRisks: asStringArray(candidate.residualRisks ?? candidate.risks),
    ...(outcome === "changed" || outcome === "validated_no_change" ? { outcome } : {}),
    ...(typeof candidate.acceptanceSatisfied === "boolean"
      ? { acceptanceSatisfied: candidate.acceptanceSatisfied }
      : {}),
  };
}

function normalizeFindings(value: unknown): WorkflowCheckFinding[] {
  if (!Array.isArray(value)) return [];
  const out: WorkflowCheckFinding[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const summary = asString(item.summary) ?? asString(item.message);
    if (!summary) continue;
    const severityRaw = asString(item.severity)?.toLowerCase();
    const severity: WorkflowCheckFinding["severity"] =
      severityRaw === "error" || severityRaw === "warning" || severityRaw === "info"
        ? severityRaw
        : "warning";
    out.push({
      severity,
      summary,
      path: asString(item.path),
    });
  }
  return out;
}

export function normalizeCheckResult(text: string | null | undefined): WorkflowCheckResult | null {
  if (!text?.trim()) return null;
  const candidate = extractJsonCandidate(text);
  if (!isRecord(candidate)) {
    return {
      verdict: "changes_requested",
      summary: text.trim().slice(0, 4000),
      findings: [
        {
          severity: "warning",
          summary: "Structured check result JSON was missing; defaulting to changes_requested.",
        },
      ],
      validation: [],
    };
  }
  const rawVerdict = asString(candidate.verdict)?.toLowerCase();
  const findings = normalizeFindings(candidate.findings);
  const hasBlockingFinding = findings.some((finding) => finding.severity === "error");
  let verdict: WorkflowCheckVerdict = "changes_requested";
  if (!hasBlockingFinding && (rawVerdict === "pass" || rawVerdict === "passed")) {
    verdict = "pass";
  }
  if (rawVerdict === "changes_requested" && !hasBlockingFinding) {
    verdict = "pass";
    findings.push({
      severity: "info",
      summary: "Check returned only advisory findings; normalized verdict to pass for user choice.",
    });
  }
  return {
    verdict,
    summary: asString(candidate.summary) ?? text.trim().slice(0, 2000),
    findings,
    validation: normalizeValidation(candidate.validation),
  };
}
