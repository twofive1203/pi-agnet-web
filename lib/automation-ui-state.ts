/**
 * Pure UI state helpers for Automation drawer (testable without React).
 */

export type AutomationView =
  | { kind: "list" }
  | { kind: "task"; taskId: string; tab: "overview" | "config" | "runs" }
  | { kind: "run"; taskId: string; runId: string }
  | { kind: "editor"; taskId: string | null; dirty: boolean };

export type InboxItem = {
  id: string;
  kind: "succeeded" | "blocked" | "ambiguous" | "missed";
  taskId: string;
  runId?: string;
  title: string;
  read: boolean;
  at: string;
};

export function initialAutomationView(): AutomationView {
  return { kind: "list" };
}

export function openTask(view: AutomationView, taskId: string): AutomationView {
  void view;
  return { kind: "task", taskId, tab: "overview" };
}

export function openRun(taskId: string, runId: string): AutomationView {
  return { kind: "run", taskId, runId };
}

export function openEditor(taskId: string | null, dirty = false): AutomationView {
  return { kind: "editor", taskId, dirty };
}

export function markEditorDirty(view: AutomationView, dirty: boolean): AutomationView {
  if (view.kind !== "editor") return view;
  return { ...view, dirty };
}

export function canLeaveEditor(view: AutomationView): boolean {
  return view.kind !== "editor" || !view.dirty;
}

export function unreadInboxCount(items: InboxItem[]): number {
  return items.filter((i) => !i.read).length;
}

export function markInboxRead(items: InboxItem[], id: string): InboxItem[] {
  return items.map((i) => (i.id === id ? { ...i, read: true } : i));
}

export function buildInboxFromRuns(
  runs: Array<{
    id: string;
    taskId: string;
    status: string;
    summary?: string | null;
    completedAt?: string | null;
    createdAt: string;
  }>,
  readIds: Set<string> = new Set(),
  omissions: Array<{
    id: string;
    taskId: string;
    kind: string;
    reason?: string | null;
    count?: number | null;
    firstLocal?: string | null;
    lastLocal?: string | null;
    createdAt?: string | null;
  }> = [],
  /** Optional i18n title resolver: (key, vars?) => localized string. */
  t?: (key: string, vars?: Record<string, string | number>) => string,
): InboxItem[] {
  const tr =
    t ??
    ((key: string, vars?: Record<string, string | number>) => {
      // Stable machine keys when no translator is provided (tests / SSR).
      if (key === "inboxTitleSucceeded") return String(vars?.summary || "inbox:succeeded");
      if (key === "inboxTitleBlocked") return String(vars?.summary || "inbox:blocked");
      if (key === "inboxTitleAmbiguous") return "inbox:ambiguous";
      if (key === "inboxTitleMissed") {
        return `inbox:missed:${vars?.kind ?? ""}x${vars?.count ?? 1}`;
      }
      return key;
    });
  const items: InboxItem[] = [];
  for (const run of runs) {
    if (run.status === "succeeded") {
      items.push({
        id: `run-${run.id}`,
        kind: "succeeded",
        taskId: run.taskId,
        runId: run.id,
        title: tr("inboxTitleSucceeded", { summary: run.summary || "" }),
        read: readIds.has(`run-${run.id}`),
        at: run.completedAt || run.createdAt,
      });
    } else if (run.status === "blocked" || run.status === "failed") {
      items.push({
        id: `run-${run.id}`,
        kind: "blocked",
        taskId: run.taskId,
        runId: run.id,
        title: tr("inboxTitleBlocked", { summary: run.summary || "" }),
        read: readIds.has(`run-${run.id}`),
        at: run.completedAt || run.createdAt,
      });
    } else if (run.status === "ambiguous") {
      items.push({
        id: `run-${run.id}`,
        kind: "ambiguous",
        taskId: run.taskId,
        runId: run.id,
        title: tr("inboxTitleAmbiguous"),
        read: readIds.has(`run-${run.id}`),
        at: run.completedAt || run.createdAt,
      });
    }
  }
  // Aggregate missed-DST / misfire omission records from dedicated API (not only runs page).
  for (const o of omissions) {
    const id = `omit-${o.id}`;
    const range =
      o.firstLocal
        ? `${o.firstLocal}${o.lastLocal && o.lastLocal !== o.firstLocal ? `…${o.lastLocal}` : ""}`
        : "";
    // Prefer localized omission kind when a real translator is supplied; keep machine key otherwise.
    const kindLabel = t
      ? tr(`omissionKind_${o.kind}`, { kind: o.kind }) === `omissionKind_${o.kind}`
        ? o.kind
        : tr(`omissionKind_${o.kind}`, { kind: o.kind })
      : o.kind;
    items.push({
      id,
      kind: "missed",
      taskId: o.taskId,
      title: tr("inboxTitleMissed", {
        kind: kindLabel,
        count: o.count ?? 1,
        range,
        reason: o.reason || "",
      }),
      read: readIds.has(id),
      at: o.createdAt || new Date(0).toISOString(),
    });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

const INBOX_READ_STORAGE_KEY = "automation.inbox.readIds";

/** Persist inbox read ids (browser localStorage). */
export function loadPersistedInboxReadIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(INBOX_READ_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function persistInboxReadIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(INBOX_READ_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore quota
  }
}

export function addPersistedInboxReadId(id: string): Set<string> {
  const ids = loadPersistedInboxReadIds();
  ids.add(id);
  persistInboxReadIds(ids);
  return ids;
}

export function formatTaskStatus(status: string): string {
  return status;
}

export function isSchedulerDegraded(scheduler: {
  available?: boolean;
  repairRequired?: boolean;
  globalDisabled?: boolean;
} | null | undefined): boolean {
  if (!scheduler) return true;
  if (scheduler.repairRequired) return true;
  if (scheduler.globalDisabled) return true;
  return scheduler.available === false;
}

export function riskDimensions(tool: {
  risks?: {
    headlessCompatible?: boolean;
    localMutation?: boolean;
    networkEgress?: boolean;
    credentialUse?: boolean;
    interactionRequired?: boolean;
    blocked?: boolean;
  };
}): string[] {
  const r = tool.risks ?? {};
  const dims: string[] = [];
  if (r.blocked) dims.push("blocked");
  if (r.networkEgress) dims.push("network");
  if (r.localMutation) dims.push("filesystem");
  if (r.credentialUse) dims.push("credentials");
  if (r.interactionRequired) dims.push("interactive");
  if (r.headlessCompatible === false) dims.push("not-headless");
  return dims;
}
