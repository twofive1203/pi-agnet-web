/**
 * Per-cwd "current SnFlow task" pointer.
 * Stored at <cwd>/.pi/snflows/current.json — never under .trellis/.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import path from "path";
import { canonicalizeCwd } from "./cwd";
import { isValidWorkflowTaskId } from "./workflow-types";
import { WORKFLOW_ROOT_SEGMENTS } from "./workflow-store";

export interface WorkflowCurrentPointer {
  taskId: string;
  updatedAt: string;
  source?: "create" | "select" | "session" | "cli" | "agent";
  sessionId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointerPath(cwd: string): string {
  const root = canonicalizeCwd(cwd);
  return path.join(root, ...WORKFLOW_ROOT_SEGMENTS, "current.json");
}

export function getWorkflowCurrentTaskId(cwd: string): string | null {
  const file = pointerPath(cwd);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!isRecord(raw) || !isValidWorkflowTaskId(raw.taskId)) return null;
    return raw.taskId;
  } catch {
    return null;
  }
}

export function getWorkflowCurrentPointer(cwd: string): WorkflowCurrentPointer | null {
  const file = pointerPath(cwd);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!isRecord(raw) || !isValidWorkflowTaskId(raw.taskId)) return null;
    if (typeof raw.updatedAt !== "string") return null;
    return {
      taskId: raw.taskId,
      updatedAt: raw.updatedAt,
      ...(typeof raw.source === "string" ? { source: raw.source as WorkflowCurrentPointer["source"] } : {}),
      ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
    };
  } catch {
    return null;
  }
}

export function setWorkflowCurrentTask(
  cwd: string,
  taskId: string,
  options?: { source?: WorkflowCurrentPointer["source"]; sessionId?: string },
): WorkflowCurrentPointer {
  if (!isValidWorkflowTaskId(taskId)) {
    throw new Error(`Invalid SnFlow task id: ${taskId}`);
  }
  const root = canonicalizeCwd(cwd);
  const dir = path.join(root, ...WORKFLOW_ROOT_SEGMENTS);
  mkdirSync(dir, { recursive: true });
  const pointer: WorkflowCurrentPointer = {
    taskId,
    updatedAt: new Date().toISOString(),
    ...(options?.source ? { source: options.source } : {}),
    ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
  };
  const file = path.join(dir, "current.json");
  const tmp = path.join(dir, `.tmp-current-${process.pid}-${randomBytes(3).toString("hex")}`);
  writeFileSync(tmp, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return pointer;
}

export function clearWorkflowCurrentTask(cwd: string): void {
  const file = pointerPath(cwd);
  if (existsSync(file)) {
    try {
      rmSync(file, { force: true });
    } catch {
      // best-effort
    }
  }
}
