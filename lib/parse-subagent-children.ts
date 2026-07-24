import { readFileSync } from "fs";
import { normalizeToolCalls } from "./normalize";
import { parsePersistedSubagentRuns, type SubagentRun } from "./subagent-runs";
import type { AgentMessage } from "./types";

/** Parse a subagent session JSONL file and project its own nested subagent calls. */
export function parseSubagentChildren(sessionFile: string): SubagentRun[] {
  let content: string;
  try {
    content = readFileSync(sessionFile, "utf-8");
  } catch {
    return [];
  }

  const messages: AgentMessage[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; message?: AgentMessage };
      if (entry.type === "message" && entry.message) {
        messages.push(normalizeToolCalls(entry.message));
      }
    } catch {
      // Ignore malformed/truncated JSONL records and retain valid history.
    }
  }

  return parsePersistedSubagentRuns(messages).map((run) => ({
    ...run,
    depth: 1,
    parentId: undefined,
  }));
}
