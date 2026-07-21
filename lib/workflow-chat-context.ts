import type { WorkflowTaskDetail, WorkflowTaskSummary } from "./workflow-types";

export interface WorkflowTaskChatContext {
  taskId: string;
  title: string;
  status: string;
  pathLabel: string;
}

export function workflowTaskToChatContext(
  task: Pick<WorkflowTaskSummary | WorkflowTaskDetail, "id" | "title" | "status" | "pathLabel">,
): WorkflowTaskChatContext {
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    pathLabel: task.pathLabel,
  };
}

/**
 * Injected into chat so the main agent behaves like Trellis after task create:
 * bind to the task, read docs, continue planning — do not wait for the user to
 * open the panel and click "+".
 */
export function buildWorkflowTaskResumePrompt(context: WorkflowTaskChatContext): string {
  const base = `.pi/workflows/tasks/${context.taskId}`;
  return [
    "继续 WebUI Workflow 任务（不是 Trellis）：",
    "",
    `Active workflow task: ${base}`,
    "",
    `任务标题：${context.title}`,
    `当前状态：${context.status}`,
    `任务目录：${base}`,
    "",
    "任务文件契约：",
    "- 这个工作流只认 `task.json` 作为任务主记录。不要把 `task.md` 当成主文件。",
    "- 正确目录结构必须是：",
    `  - ${base}/task.json`,
    `  - ${base}/requirements.md`,
    `  - ${base}/design.md`,
    `  - ${base}/plan.md`,
    "- 如果目录里还没有 `task.json`，必须先补齐它，再继续执行。",
    "- 如果 `npx tsx scripts/workflow-task.ts` 因 Node/ESM/runtime 问题不可用，允许手工创建/修复文件，不要卡住。",
    "- 手工创建时，`task.json` 至少包含：schemaVersion:1、id、title、description、status、priority、createdAt、updatedAt、completedAt:null、revision、activeRunId:null、latestImplementRunId:null、latestCheckRunId:null、commit:null、archived:false。",
    "- 如果生成器只能输出 markdown，请把它视为草稿；最终产物必须落成 `task.json` + 三份 markdown 文档。",
    "",
    "请先读取并维护这些文件：",
    `- ${base}/task.json`,
    `- ${base}/requirements.md`,
    `- ${base}/design.md`,
    `- ${base}/plan.md`,
    "",
    "行为约定：",
    "- 这是 Snail Pi Web 自有 Workflow，不要写 .trellis/，也不要跑 trellis task.py。",
    "- 用户已经有任务了，不要再让用户去面板里手动点“创建任务”。",
    "- 先完善 requirements/design/plan；用户明确要求实现前，不要直接大改代码。",
    "- 需要派发实现/检查时，优先提示用户在 Workflow 面板点“运行实现/运行检查”，或使用项目内 `npx tsx scripts/workflow-task.ts`（若可用）。",
    "- 创建/修复任务后，必须自检：W 面板能列出任务；如果 CLI 可用，再用 `npx tsx scripts/workflow-task.ts show <taskId>` 验证。",
    "- 如果生成器输出了 task.md，请把它当作草稿或兼容文件，不要让它替代 task.json。",
    "- 不要 git commit/push/PR，除非用户明确要求。",
    "",
    "我接下来会补充要求。请先恢复任务背景并给出下一步。",
  ].join("\n");
}

export function buildWorkflowTaskSeedRequirements(options: {
  title: string;
  userGoal: string;
  extraNotes?: string;
}): string {
  const goal = options.userGoal.trim() || options.title;
  const notes = options.extraNotes?.trim();
  return [
    `# Requirements`,
    ``,
    `## Goal`,
    ``,
    goal,
    ``,
    `## Requirements`,
    ``,
    `- 根据上述目标完成实现`,
    notes ? `- 补充说明：${notes}` : `- （待补充）`,
    ``,
    `## Acceptance Criteria`,
    ``,
    `- 行为符合目标描述`,
    `- 通过可用的 lint/typecheck 或相关校验`,
    ``,
    `## Out Of Scope`,
    ``,
    `- 未提及的重构与范围外功能`,
    ``,
  ].join("\n");
}
