/**
 * Seed a SnFlow task title/goal from an existing chat session transcript.
 */

import { getSessionEntries, resolveSessionPath } from "./session-reader";
import { projectSessionTranscript } from "./session-transcript";

function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && "text" in block && typeof (block as { text: unknown }).text === "string") {
        return (block as { text: string }).text;
      }
      return "";
    })
    .join("\n")
    .trim();
}

export async function extractWorkflowSeedFromSession(sessionId: string): Promise<{
  title: string;
  seedText: string;
  userMessageCount: number;
} | null> {
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return null;
  const entries = getSessionEntries(filePath);
  const transcript = projectSessionTranscript(entries);
  const userTexts: string[] = [];
  for (const row of transcript.rows) {
    const msg = row.message;
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "user") continue;
    const text = messageText(msg.content);
    if (!text) continue;
    // Skip injected system-ish resume prompts.
    if (
      text.startsWith("继续 Trellis 任务") ||
      text.startsWith("继续 WebUI Workflow 任务") ||
      text.startsWith("继续 SnFlow 任务")
    ) continue;
    userTexts.push(text);
  }
  if (userTexts.length === 0) return null;

  const latest = userTexts[userTexts.length - 1] ?? "";
  const recent = userTexts.slice(-3).join("\n\n---\n\n");
  const titleLine = latest
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "Chat task";
  const title = titleLine.replace(/^[#>*\-\s]+/, "").slice(0, 80) || "Chat task";

  return {
    title,
    seedText: recent || latest,
    userMessageCount: userTexts.length,
  };
}
