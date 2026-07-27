import type { ProjectSummary, WorktreeInfo } from "@/lib/types";
import type { MessageParams } from "@/lib/i18n";

export const EXPLORER_HEIGHT_STORAGE_KEY = "pi-web-explorer-height-v1";
export const DEFAULT_EXPLORER_HEIGHT = 240;
export const MIN_EXPLORER_HEIGHT = 120;
export const MIN_SESSION_LIST_HEIGHT = 80;
export const EXPLORER_RESIZE_STEP = 10;
export const EXPLORER_RESIZE_STEP_LARGE = 40;

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function readStoredExplorerHeight(): number {
  try {
    const raw = window.localStorage.getItem(EXPLORER_HEIGHT_STORAGE_KEY);
    if (raw == null) return DEFAULT_EXPLORER_HEIGHT;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : DEFAULT_EXPLORER_HEIGHT;
  } catch {
    return DEFAULT_EXPLORER_HEIGHT;
  }
}

export function writeStoredExplorerHeight(height: number): void {
  try {
    window.localStorage.setItem(EXPLORER_HEIGHT_STORAGE_KEY, String(height));
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export function formatRelativeTime(
  dateStr: string,
  t: (key: string, params?: MessageParams) => string
): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return t("sidebar.justNow");
  if (mins < 60) return t("sidebar.minutesAgo", { n: mins });
  if (hours < 24) return t("sidebar.hoursAgo", { n: hours });
  if (days < 7) return t("sidebar.daysAgo", { n: days });
  return date.toLocaleDateString();
}

/** Return project cwds ordered by latest activity, keeping pinned entries first. */
export function getOrderedCwds(projects: ProjectSummary[], extraCwds: string[] = []): string[] {
  const recent = [...projects]
    .sort((a, b) => b.latestModified.localeCompare(a.latestModified))
    .map((p) => p.cwd)
    .filter(Boolean);
  return [...extraCwds, ...recent.filter((cwd) => !extraCwds.includes(cwd))];
}

export function shortenCwd(cwd: string, homeDir?: string): string {
  const path = homeDir && cwd.startsWith(homeDir) ? "~" + cwd.slice(homeDir.length) : cwd;
  const sep = path.includes("/") ? "/" : "\\";
  const parts = path.split(sep).filter(Boolean);
  if (parts.length <= 2) return path;
  return "…/" + parts.slice(-2).join(sep);
}

export function makeTempSessionId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export interface CwdPickerRow {
  kind: "project" | "worktree";
  cwd: string;
  worktree?: WorktreeInfo;
  syntheticParent?: boolean;
}

export function buildCwdPickerRows(
  orderedCwds: string[],
  worktreeByCwd: Map<string, WorktreeInfo>
): CwdPickerRow[] {
  const projectOrder: string[] = [];
  const syntheticParents = new Set<string>();
  const worktreesByParent = new Map<string, Array<{ cwd: string; worktree: WorktreeInfo }>>();
  const seenProjects = new Set<string>();
  const seenWorktrees = new Set<string>();
  const orderedCwdSet = new Set(orderedCwds);

  const pushProject = (cwd: string, syntheticParent = false) => {
    if (seenProjects.has(cwd)) {
      if (syntheticParent) syntheticParents.add(cwd);
      return;
    }
    seenProjects.add(cwd);
    projectOrder.push(cwd);
    if (syntheticParent) syntheticParents.add(cwd);
  };

  const pushWorktree = (parentCwd: string, cwd: string, worktree: WorktreeInfo) => {
    if (seenWorktrees.has(cwd)) return;
    seenWorktrees.add(cwd);
    const group = worktreesByParent.get(parentCwd) ?? [];
    group.push({ cwd, worktree });
    worktreesByParent.set(parentCwd, group);
  };

  for (const cwd of orderedCwds) {
    const worktree = worktreeByCwd.get(cwd);
    const parentCwd =
      worktree?.mainWorktreePath && worktree.mainWorktreePath !== cwd
        ? worktree.mainWorktreePath
        : null;

    if (worktree && parentCwd) {
      pushProject(parentCwd, !orderedCwdSet.has(parentCwd));
      pushWorktree(parentCwd, cwd, worktree);
    } else {
      pushProject(cwd);
    }
  }

  return projectOrder.flatMap((cwd) => [
    { kind: "project" as const, cwd, syntheticParent: syntheticParents.has(cwd) },
    ...(worktreesByParent.get(cwd) ?? []).map((entry) => ({ kind: "worktree" as const, ...entry })),
  ]);
}

export function groupCwdPickerRows(rows: CwdPickerRow[]): CwdPickerRow[][] {
  const groups: CwdPickerRow[][] = [];
  for (const row of rows) {
    if (row.kind === "project") {
      groups.push([row]);
    } else {
      groups[groups.length - 1]?.push(row);
    }
  }
  return groups;
}

export function filterCwdPickerGroups(groups: CwdPickerRow[][], query: string): CwdPickerRow[][] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return groups;

  return groups.flatMap((group) => {
    const [project, ...worktrees] = group;
    if (!project) return [];
    if (project.cwd.toLowerCase().includes(normalizedQuery)) return [group];
    const matchingWorktrees = worktrees.filter((row) =>
      row.cwd.toLowerCase().includes(normalizedQuery)
    );
    return matchingWorktrees.length > 0 ? [[project, ...matchingWorktrees]] : [];
  });
}

export interface WorktreeCreateResponse {
  cwd?: string;
  error?: string;
  worktree?: WorktreeInfo;
  branchName?: string;
  mainWorktreePath?: string;
  mainWorktreeBranch?: string;
}

export interface WorktreeActionResponse {
  success?: boolean;
  error?: string;
  cwd?: string;
  fallbackCwd?: string;
  deletedSessionIds?: string[];
  status?: {
    dirty?: boolean;
    dirtySummary?: string[];
  };
}

export interface WorktreeContextMenuState {
  x: number;
  y: number;
  cwd: string;
  worktree: WorktreeInfo;
}

export interface SessionContextMenuState {
  x: number;
  y: number;
  session: import("@/lib/types").SessionInfo;
}

export interface WorktreeActionState {
  kind: "delete" | "archive";
  cwd: string;
  worktree: WorktreeInfo;
  force: boolean;
  busy: boolean;
  error: string | null;
  dirtySummary?: string[];
}
