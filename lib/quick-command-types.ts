/**
 * Project quick-command domain types.
 *
 * One-shot non-interactive project tasks, independent of Web Terminal PTY
 * sessions and chat/agent lifecycle.
 */

export const QUICK_COMMAND_SCHEMA_VERSION = 1 as const;

export const QUICK_COMMAND_MAX_NAME_CHARS = 80;
export const QUICK_COMMAND_MAX_DESCRIPTION_CHARS = 400;
export const QUICK_COMMAND_MAX_COMMAND_CHARS = 4_000;
export const QUICK_COMMAND_MAX_CWD_CHARS = 500;
export const QUICK_COMMAND_MAX_ENV_ENTRIES = 40;
export const QUICK_COMMAND_MAX_ENV_KEY_CHARS = 128;
export const QUICK_COMMAND_MAX_ENV_VALUE_CHARS = 4_000;
export const QUICK_COMMAND_MAX_COMMANDS = 40;
export const QUICK_COMMAND_MAX_OUTPUT_BYTES = 512 * 1024;
export const QUICK_COMMAND_MAX_OUTPUT_CHUNKS = 2_000;
export const QUICK_COMMAND_MAX_GLOBAL_CONCURRENT = 6;
export const QUICK_COMMAND_DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
export const QUICK_COMMAND_RECENT_RUNS = 24;

export type QuickCommandRunStatus =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export const QUICK_COMMAND_TERMINAL_STATUSES: ReadonlySet<QuickCommandRunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

export function isQuickCommandTerminalStatus(status: QuickCommandRunStatus): boolean {
  return QUICK_COMMAND_TERMINAL_STATUSES.has(status);
}

export function isQuickCommandActiveStatus(status: QuickCommandRunStatus): boolean {
  return status === "starting" || status === "running";
}

export interface QuickCommandDefinition {
  id: string;
  name: string;
  command: string;
  description: string;
  /** Project-relative working directory; empty means project root. */
  cwd: string;
  env: Record<string, string>;
  confirmBeforeRun: boolean;
  autoExpandOutput: boolean;
  enabled: boolean;
  order: number;
}

export interface QuickCommandProjectConfig {
  schemaVersion: typeof QUICK_COMMAND_SCHEMA_VERSION;
  revision: string;
  commands: QuickCommandDefinition[];
}

export interface QuickCommandTrustPreview {
  commandId: string;
  name: string;
  command: string;
  resolvedCwd: string;
  envKeys: string[];
  digest: string;
  reason: "first_run" | "changed" | "always_confirm";
}

export interface QuickCommandRunSummary {
  id: string;
  cwd: string;
  commandId: string;
  name: string;
  command: string;
  resolvedCwd: string;
  status: QuickCommandRunStatus;
  exitCode: number | null;
  exitReason: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  truncated: boolean;
  outputBytes: number;
  autoExpandOutput: boolean;
}

export interface QuickCommandRunDetail extends QuickCommandRunSummary {
  /** Recent bounded merged stdout/stderr text for reconnect. */
  outputText: string;
}

export interface QuickCommandListItem {
  id: string;
  name: string;
  description: string;
  command: string;
  cwd: string;
  confirmBeforeRun: boolean;
  autoExpandOutput: boolean;
  enabled: boolean;
  order: number;
  activeRunId: string | null;
  activeStatus: QuickCommandRunStatus | null;
}

export type QuickCommandStartResult =
  | {
      ok: true;
      run: QuickCommandRunSummary;
      alreadyRunning?: boolean;
    }
  | {
      ok: false;
      code: "trust_required" | "busy" | "limit" | "not_found" | "disabled" | "invalid" | "forbidden";
      error: string;
      trust?: QuickCommandTrustPreview;
      run?: QuickCommandRunSummary;
    };
