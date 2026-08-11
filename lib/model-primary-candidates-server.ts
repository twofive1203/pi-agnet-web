import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readPrimaryCandidateKeysFromModelsJson } from "./model-primary-candidates";

/** Resolve ~/.pi/agent without importing the ESM-only pi package entry. */
function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (typeof envDir === "string" && envDir.trim()) return envDir.trim();
  return join(homedir(), ".pi", "agent");
}

export function getModelsJsonPath(agentDir = getAgentDir()): string {
  return join(agentDir, "models.json");
}

let candidateCache:
  | {
      path: string;
      mtimeMs: number;
      size: number;
      keys: Set<string>;
    }
  | null = null;

/** Read primary-candidate keys from disk, reusing a small mtime/size cache. */
export function readPrimaryCandidateKeys(
  modelsJsonPath = getModelsJsonPath(),
): Set<string> {
  if (!existsSync(modelsJsonPath)) {
    candidateCache = null;
    return new Set();
  }

  let stats: { mtimeMs: number; size: number };
  try {
    const st = statSync(modelsJsonPath);
    stats = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    candidateCache = null;
    return new Set();
  }

  if (
    candidateCache
    && candidateCache.path === modelsJsonPath
    && candidateCache.mtimeMs === stats.mtimeMs
    && candidateCache.size === stats.size
  ) {
    return candidateCache.keys;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(modelsJsonPath, "utf8")) as unknown;
  } catch {
    candidateCache = null;
    return new Set();
  }

  const keys = readPrimaryCandidateKeysFromModelsJson(parsed);
  candidateCache = {
    path: modelsJsonPath,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    keys,
  };
  return keys;
}
