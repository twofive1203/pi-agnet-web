/**
 * Session-scoped SnFlow task resolution.
 * Session-scoped SnFlow task association resolver for the floating widget.
 *
 * Two evidence modes (high confidence only):
 * 1. Exact pointer.sessionId matches the active session.
 * 2. Session transcript contains explicit "Active SnFlow task" breadcrumb
 *    mentioning .pi/snflows/tasks/<id>.
 *
 * A blank/new session with no evidence shows no widget.
 * CLI pointers without a sessionId are visible only when there is
 * transcript evidence.
 */

import { getWorkflowCurrentPointer } from "./workflow-current";
import { getWorkflowTaskDetail } from "./workflow-store";
import { workflowPhaseForStatus, type WorkflowPhaseLabel } from "./workflow-guidance";
import { isValidWorkflowTaskId, type WorkflowTaskDetail } from "./workflow-types";
import type { SessionEntry } from "./types";

export interface WorkflowSessionTaskLinkResult {
  task: (Pick<WorkflowTaskDetail, "id" | "title" | "status" | "activeRunId">) | null;
  phase: WorkflowPhaseLabel;
  source?: "pointer" | "transcript";
  reason?: "no-evidence" | "task-not-found";
}

/** Match Active SnFlow task: .pi/snflows/tasks/<id> in session transcripts. */
const SNFLOW_ACTIVE_TASK_RE = /Active SnFlow task:\s*(?:\.\/)?(?:\.pi\/)?snflows\/tasks\/([a-z0-9-]{1,80})/gi;

/** Match .pi/snflows/tasks/<id> as a path reference. */
const SNFLOW_TASK_PATH_RE = /(?:^|[\s"'`/])\.pi\/snflows\/tasks\/([a-z0-9-]{1,80})(?=[\s"'`/]|$)/g;

/** Match explicit task creation output when emitted by a compatible client. */
const SNFLOW_CREATED_TASK_RE = /Created SnFlow task:\s*([a-z0-9-]{1,80})/gi;

/**
 * Collect all SnFlow task references from session transcript entries.
 * Returns task ids in reverse order (most recent first).
 */
function collectTranscriptEvidence(entries: SessionEntry[]): string[] {
  const foundIds: string[] = [];
  const seenIds = new Set<string>();

  // Walk entries in reverse (most recent first) so the last reference wins.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const texts = collectEntryTexts(entry);
    for (const text of texts) {
      // Active SnFlow task breadcrumbs
      for (const match of text.matchAll(SNFLOW_ACTIVE_TASK_RE)) {
        const id = (match[1] ?? "").trim();
        if (isValidWorkflowTaskId(id) && !seenIds.has(id)) {
          seenIds.add(id);
          foundIds.push(id);
        }
      }
      // Created SnFlow task
      for (const match of text.matchAll(SNFLOW_CREATED_TASK_RE)) {
        const id = (match[1] ?? "").trim();
        if (isValidWorkflowTaskId(id) && !seenIds.has(id)) {
          seenIds.add(id);
          foundIds.push(id);
        }
      }
      // Path references
      for (const match of text.matchAll(SNFLOW_TASK_PATH_RE)) {
        const id = (match[1] ?? "").trim();
        if (isValidWorkflowTaskId(id) && !seenIds.has(id)) {
          seenIds.add(id);
          foundIds.push(id);
        }
      }
    }
  }

  return foundIds;
}

function collectEntryTexts(entry: SessionEntry): string[] {
  const texts: string[] = [];
  if (entry.type === "message") {
    const msg = (entry as { message?: { content?: unknown } }).message;
    if (msg?.content) collectStrings(msg.content, texts);
  } else if (entry.type === "custom_message") {
    const cm = entry as { content?: unknown; details?: unknown };
    if (cm.content) collectStrings(cm.content, texts);
    if (cm.details) collectStrings(cm.details, texts);
  } else if (entry.type === "custom") {
    const c = entry as { data?: unknown };
    if (c.data) collectStrings(c.data, texts);
  }
  return texts;
}

function collectStrings(value: unknown, output: string[], depth = 0): void {
  if (depth > 4 || value == null) return;
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "content", "command", "message", "task", "prompt", "arguments", "input"]) {
      if (key in record) collectStrings(record[key], output, depth + 1);
    }
  }
}

/** Verify a task id exists in the SnFlow task store. */
function taskExists(cwd: string, taskId: string): boolean {
  try {
    const detail = getWorkflowTaskDetail(cwd, taskId);
    return !detail.archived;
  } catch {
    return false;
  }
}

/**
 * Resolve the SnFlow task for a specific session.
 *
 * Resolution order:
 * 1. If the cwd current pointer has an explicit `sessionId` matching the
 *    active session, return that task.
 * 2. Otherwise, scan session transcript for explicit "Active SnFlow task"
 *    breadcrumbs. If a matching non-archived task is found and confirmed
 *    to exist, return it.
 * 3. If nothing matches, return null.
 */
export function resolveWorkflowTaskForSession(
  cwd: string,
  sessionId: string,
  entries: SessionEntry[],
): WorkflowSessionTaskLinkResult {
  // Step 1: Check exact pointer.sessionId match
  const pointer = getWorkflowCurrentPointer(cwd);
  if (pointer?.sessionId === sessionId) {
    try {
      const task = getWorkflowTaskDetail(cwd, pointer.taskId);
      if (!task.archived) {
        return {
          task: { id: task.id, title: task.title, status: task.status, activeRunId: task.activeRunId },
          phase: workflowPhaseForStatus(task.status),
          source: "pointer",
        };
      }
    } catch {
      // pointer points at a missing task; fall through to transcript evidence
    }
  }

  // Step 2: Collect transcript evidence
  const evidenceIds = collectTranscriptEvidence(entries);

  // Step 3: Try each evidence id in order (most recent first)
  for (const id of evidenceIds) {
    if (taskExists(cwd, id)) {
      try {
        const task = getWorkflowTaskDetail(cwd, id);
        if (!task.archived) {
          return {
            task: { id: task.id, title: task.title, status: task.status, activeRunId: task.activeRunId },
            phase: workflowPhaseForStatus(task.status),
            source: "transcript",
          };
        }
      } catch {
        // skip unreadable tasks
      }
    }
  }

  // Step 4: No match
  if (evidenceIds.length > 0) {
    return { task: null, phase: "idle", reason: "task-not-found" };
  }
  return { task: null, phase: "idle", reason: "no-evidence" };
}
