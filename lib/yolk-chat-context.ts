import type { YolkTaskDetail, YolkTaskDocumentName } from "./yolk-types";

export interface YolkTaskChatContextDocument {
  fileName: YolkTaskDocumentName;
  content: string;
  truncated: boolean;
}

export interface YolkTaskChatContext {
  key: string;
  title: string;
  status: string;
  priority?: string;
  assignee?: string;
  pathLabel: string;
  documents: YolkTaskChatContextDocument[];
}

const DOCUMENT_CONTEXT_MAX_CHARS = 5000;

function clipContent(content: string): string {
  if (content.length <= DOCUMENT_CONTEXT_MAX_CHARS) return content;
  return `${content.slice(0, DOCUMENT_CONTEXT_MAX_CHARS)}\n[truncated]`;
}

export function yolkTaskDetailToChatContext(task: YolkTaskDetail): YolkTaskChatContext {
  const documents = Object.values(task.documents)
    .filter((document): document is NonNullable<typeof document> => !!document)
    .map((document) => ({
      fileName: document.fileName,
      content: clipContent(document.content),
      truncated: document.truncated || document.content.length > DOCUMENT_CONTEXT_MAX_CHARS,
    }));
  return {
    key: task.key,
    title: task.title,
    status: task.status,
    priority: task.priority,
    assignee: task.assignee,
    pathLabel: task.pathLabel,
    documents,
  };
}

export function buildYolkTaskResumePrompt(context: YolkTaskChatContext): string {
  const path = `.yolk/tasks/${context.key}`;
  const lines = [
    "Continue Yolk workflow task:",
    "",
    `Active yolk task: ${path}`,
    "",
    `Title: ${context.title}`,
    `Status: ${context.status}`,
    context.priority ? `Priority: ${context.priority}` : "",
    context.assignee ? `Assignee: ${context.assignee}` : "",
    `Task directory: ${path}`,
    "",
    "Use the project-local yolk workflow. Do not call Trellis CLI or use .trellis task state for this task.",
  ].filter(Boolean);

  if (context.documents.length > 0) {
    lines.push("", "Task artifacts:");
    for (const document of context.documents) {
      lines.push("", `## ${path}/${document.fileName}`, document.truncated ? "[preview truncated]" : "", document.content);
    }
  } else {
    lines.push("", "Task artifacts are not loaded in the chip. Read the task directory before making changes.");
  }

  lines.push("", "Please restore task context, confirm the current stage, and proceed only according to the user's next instruction.");
  return lines.join("\n");
}
