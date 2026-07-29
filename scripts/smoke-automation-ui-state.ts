import {
  buildInboxFromRuns,
  canLeaveEditor,
  initialAutomationView,
  isSchedulerDegraded,
  markEditorDirty,
  markInboxRead,
  openEditor,
  openTask,
  riskDimensions,
  unreadInboxCount,
} from "../lib/automation-ui-state";
import {
  formatAuthoritySummaryLines,
  formatUnavailableReasonLabel,
  formatOmissionKindLabel,
  splitUnavailableReason,
} from "../lib/automation-locale-format";
import { automationZh, automationEn } from "../lib/i18n/messages/automation";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const view = initialAutomationView();
assert(view.kind === "list", "list");
const taskView = openTask(view, "t1");
assert(taskView.kind === "task" && taskView.taskId === "t1", "task");
const editor = openEditor(null, false);
assert(canLeaveEditor(editor), "clean leave");
const dirty = markEditorDirty(editor, true);
assert(!canLeaveEditor(dirty), "dirty block");

const inbox = buildInboxFromRuns([
  { id: "r1", taskId: "t1", status: "succeeded", summary: "ok", createdAt: "2026-01-01", completedAt: "2026-01-01" },
  { id: "r2", taskId: "t1", status: "blocked", createdAt: "2026-01-02", completedAt: "2026-01-02" },
  { id: "r3", taskId: "t1", status: "ambiguous", createdAt: "2026-01-03", completedAt: "2026-01-03" },
]);
assert(unreadInboxCount(inbox) === 3, "unread");
const read = markInboxRead(inbox, inbox[0]!.id);
assert(unreadInboxCount(read) === 2, "mark read");

assert(isSchedulerDegraded(null), "null degraded");
assert(isSchedulerDegraded({ available: false }), "unavailable");
assert(!isSchedulerDegraded({ available: true, globalDisabled: false, repairRequired: false }), "ok");

assert(riskDimensions({ risks: { networkEgress: true, blocked: true } }).includes("network"), "risks");

// Locale formatters: AppDialog confirmation + dispose_unconfirmed + omission kinds
{
  const mkT =
    (catalog: Record<string, string>) =>
    (key: string, params?: Record<string, string | number>) => {
      const bare = key.startsWith("automation.") ? key.slice("automation.".length) : key;
      const tpl = catalog[bare] ?? key;
      return tpl.replace(/\{(\w+)\}/g, (_, n: string) => String(params?.[n] ?? ""));
    };
  const tZh = mkT(automationZh as Record<string, string>);
  const tEn = mkT(automationEn as Record<string, string>);

  const split = splitUnavailableReason("dispose_unconfirmed:abort");
  assert(split.reason === "dispose_unconfirmed" && split.detail === "abort", "split dispose");
  const label = formatUnavailableReasonLabel("dispose_unconfirmed", "abort", tZh);
  assert(label.includes("释放未确认"), "zh dispose");
  assert(!label.startsWith("dispose_unconfirmed:"), "no compound primary");

  assert(formatOmissionKindLabel("dst_gap", tZh).includes("夏令时"), "omission zh");
  assert(formatOmissionKindLabel("misfire_aggregate", tEn).toLowerCase().includes("misfire"), "omission en");

  const lines = formatAuthoritySummaryLines(
    {
      action: "activate",
      name: "n",
      cron: "0 9 * * *",
      timezone: "UTC",
      cwd: "/tmp/x",
      cwdSource: "default",
      provider: "openai",
      modelId: "m",
      thinking: null,
      maxRuntimeMin: 30,
      promptHash: "abc",
      authority: {
        policyHash: "deadbeefcafebabe",
        approvalExpiresAt: null,
        budgets: { maxRunsPerDay: 1, maxTokensPerRun: 100, maxMonthlyCostUsd: 1 },
        tools: [],
        extensionCount: 0,
      },
    },
    ["Action: activate", "Cwd (default): /tmp/x"],
    tZh,
  );
  const text = lines.join("\n");
  assert(text.includes("默认工作区"), "cwd source localized in confirmation");
  assert(!text.includes("Cwd (default)"), "no english server summary");
  assert(text.includes("激活") || text.includes("操作"), "action localized");

  const omitted = buildInboxFromRuns(
    [],
    new Set(),
    [{ id: "o", taskId: "t", kind: "dst_gap", count: 1, createdAt: "2026-01-01T00:00:00.000Z" }],
    (key, vars) => {
      const bare = key.startsWith("automation.") ? key.slice("automation.".length) : key;
      const tpl = (automationZh as Record<string, string>)[bare] ?? key;
      return tpl.replace(/\{(\w+)\}/g, (_, n: string) => String(vars?.[n] ?? ""));
    },
  );
  assert(!omitted[0]!.title.includes("dst_gap"), "inbox omits raw kind");
  assert(omitted[0]!.title.includes("夏令时缺口"), "inbox uses localized kind");
}

console.log("smoke-automation-ui-state: ok");
