/**
 * Project-level SnFlow detection and initialization.
 * A project is "initialized" when <cwd>/.pi/snflows/tasks/ exists; only
 * initialized projects get SnFlow chat guidance injected at session start.
 */

import { existsSync, mkdirSync, statSync } from "fs";
import path from "path";
import { canonicalizeCwd } from "./cwd";
import {
  WORKFLOW_ROOT_SEGMENTS,
  WORKFLOW_TASKS_DIR,
  createStoreContext,
} from "./workflow-store";

export interface WorkflowSetupStatus {
  cwd: string;
  initialized: boolean;
  hasSnflowsDir: boolean;
  hasTasksDir: boolean;
  hasArchivedDir: boolean;
  /** Workspace-relative store root, e.g. ".pi/snflows". */
  pathLabel: string;
}

export interface WorkflowSetupInitResult {
  success: boolean;
  /** false when the project was already initialized (idempotent init). */
  created: boolean;
  status: WorkflowSetupStatus;
}

function isDirectory(target: string): boolean {
  try {
    return existsSync(target) && statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Lightweight never-throw check used by session-start guidance injection. */
export function isWorkflowProjectInitialized(cwd: string): boolean {
  try {
    const root = canonicalizeCwd(cwd);
    return isDirectory(path.join(root, ...WORKFLOW_ROOT_SEGMENTS, WORKFLOW_TASKS_DIR));
  } catch {
    return false;
  }
}

export function getWorkflowSetupStatus(cwd: string): WorkflowSetupStatus {
  const ctx = createStoreContext(cwd);
  const hasTasksDir = isDirectory(ctx.tasksRoot);
  return {
    cwd: ctx.workspaceRoot,
    initialized: hasTasksDir,
    hasSnflowsDir: isDirectory(ctx.workflowsRoot),
    hasTasksDir,
    hasArchivedDir: isDirectory(ctx.archiveRoot),
    pathLabel: WORKFLOW_ROOT_SEGMENTS.join("/"),
  };
}

export function initializeWorkflowProject(cwd: string): WorkflowSetupInitResult {
  const ctx = createStoreContext(cwd);
  const created = !isDirectory(ctx.tasksRoot);
  mkdirSync(ctx.tasksRoot, { recursive: true });
  mkdirSync(ctx.archiveRoot, { recursive: true });
  return { success: true, created, status: getWorkflowSetupStatus(ctx.workspaceRoot) };
}
