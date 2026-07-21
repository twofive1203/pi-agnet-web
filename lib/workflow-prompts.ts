/**
 * Prompt builders and structured-output normalizers for Workflow implement/check phases.
 */

import type {
  WorkflowCheckFinding,
  WorkflowCheckResult,
  WorkflowCheckVerdict,
  WorkflowImplementResult,
  WorkflowRunPhase,
  WorkflowValidationResult,
} from "./workflow-types";

export const WORKFLOW_IMPLEMENT_AGENT = "worker";
export const WORKFLOW_CHECK_AGENT = "reviewer";

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
    "You are the Workflow implementation agent for Snail Pi Web.",
    "You are a child worker, not an orchestrator. Do not spawn subagents, do not call the subagent tool, and do not start other Workflow phases.",
    "",
    `Project cwd (must remain your working directory): ${ctx.cwd}`,
    `Task id: ${ctx.taskId}`,
    `Task title: ${ctx.title}`,
    `Task revision: ${ctx.taskRevision}`,
    "",
    "Read these project-relative task documents before editing code:",
    `- ${ctx.pathLabels.taskJson}`,
    `- ${ctx.pathLabels.requirements}`,
    `- ${ctx.pathLabels.design}`,
    `- ${ctx.pathLabels.plan}`,
    "",
    "Implementation contract:",
    "- Implement only what the requirements/design/plan require for this task.",
    "- Prefer focused, reviewable changes. Do not drive-by refactor unrelated code.",
    "- Never git commit, push, merge, tag, or open a PR.",
    "- Never modify .trellis/ task metadata as part of this Workflow.",
    "- Never treat task.md as the task source of truth; task.json is mandatory.",
    "- Run focused validation that is practical for the change (lint/typecheck/tests as appropriate).",
    "- If task.json is missing or malformed, stop and report it instead of inventing a markdown-only task.",
    "- When finished, respond with a concise human summary AND a final fenced JSON block with this exact shape:",
    "```json",
    "{",
    '  "summary": "what changed",',
    '  "changedFiles": ["path/one.ts"],',
    '  "validation": [{"command": "npm run lint", "ok": true, "summary": "pass"}],',
    '  "residualRisks": ["optional risk"]',
    "}",
    "```",
  ].join("\n");
}

export function buildCheckPrompt(ctx: WorkflowPromptContext): string {
  return [
    "You are the Workflow check/review agent for Snail Pi Web.",
    "You are an independent reviewer, not an implementer and not an orchestrator.",
    "Do not spawn subagents, do not call the subagent tool, and do not edit project files unless a tiny read-only note is absolutely required (prefer zero writes).",
    "",
    `Project cwd (must remain your working directory): ${ctx.cwd}`,
    `Task id: ${ctx.taskId}`,
    `Task title: ${ctx.title}`,
    `Task revision under review: ${ctx.taskRevision}`,
    "",
    "Review against these project-relative documents:",
    `- ${ctx.pathLabels.taskJson}`,
    `- ${ctx.pathLabels.requirements}`,
    `- ${ctx.pathLabels.design}`,
    `- ${ctx.pathLabels.plan}`,
    "",
    ctx.implementSummary
      ? `Latest implementation summary:\n${ctx.implementSummary}`
      : "No implementation summary was provided; inspect the working tree and task documents directly.",
    "",
    "Review contract:",
    "- Verify the implementation matches requirements/design/plan.",
    "- Prefer concrete findings with paths when possible.",
    "- Never git commit, push, merge, tag, or open a PR.",
    "- Never dispatch implement/check Workflow agents or other subagents.",
    "- Never treat task.md as the source of truth; if task.json is missing or invalid, report that explicitly.",
    "- When finished, respond with a concise human summary AND a final fenced JSON block with this exact shape:",
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
  return ctx.phase === "implement" ? buildImplementPrompt(ctx) : buildCheckPrompt(ctx);
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
      // try next
    }
  }
  // Fallback: last {...} object in the text.
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
  return {
    summary: asString(candidate.summary) ?? text.trim().slice(0, 2000),
    changedFiles: asStringArray(candidate.changedFiles ?? candidate.files),
    validation: normalizeValidation(candidate.validation),
    residualRisks: asStringArray(candidate.residualRisks ?? candidate.risks),
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

  const verdictRaw = asString(candidate.verdict)?.toLowerCase();
  let verdict: WorkflowCheckVerdict = "changes_requested";
  if (verdictRaw === "pass" || verdictRaw === "passed" || verdictRaw === "ok") verdict = "pass";
  if (verdictRaw === "changes_requested" || verdictRaw === "fail" || verdictRaw === "failed") {
    verdict = "changes_requested";
  }

  return {
    verdict,
    summary: asString(candidate.summary) ?? text.trim().slice(0, 2000),
    findings: normalizeFindings(candidate.findings),
    validation: normalizeValidation(candidate.validation),
  };
}
