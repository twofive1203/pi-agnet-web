import { existsSync, realpathSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { MAX_SUBAGENT_DETAIL_DEPTH } from "./parse-subagent-children";

export class SubagentDetailRequestError extends Error {
  constructor(message: string, public readonly status: 400 | 403 | 404) {
    super(message);
    this.name = "SubagentDetailRequestError";
  }
}

export function parseSubagentDetailDepth(raw: string | null): number {
  const depth = Number(raw ?? "1");
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_SUBAGENT_DETAIL_DEPTH) {
    throw new SubagentDetailRequestError(`depth must be between 1 and ${MAX_SUBAGENT_DETAIL_DEPTH}`, 400);
  }
  return depth;
}

export function resolveSubagentArtifactPath(sessionFile: string, sessionsDir: string): string {
  if (!existsSync(sessionsDir)) throw new SubagentDetailRequestError("Sessions directory not found", 404);
  if (!existsSync(sessionFile)) throw new SubagentDetailRequestError("Session file not found", 404);

  let root: string;
  let target: string;
  try {
    root = realpathSync(resolve(sessionsDir));
    target = realpathSync(resolve(sessionFile));
  } catch {
    throw new SubagentDetailRequestError("Invalid session file path", 400);
  }
  if (!target.startsWith(root + sep)) {
    throw new SubagentDetailRequestError("Session file must be within the agent sessions directory", 403);
  }
  if (basename(target) !== "session.jsonl") {
    throw new SubagentDetailRequestError("Only native subagent session artifacts are supported", 403);
  }
  return target;
}
