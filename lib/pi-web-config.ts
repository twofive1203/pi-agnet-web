import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface PiWebWorktreeConfig {
  baseRef: string;
  branchNameTemplate: string;
  baseDirTemplate: string;
  pathTemplate: string;
  sessionDisplay: "separate" | "tag";
}

export interface PiWebConfig {
  worktree: PiWebWorktreeConfig;
}

export const DEFAULT_PI_WEB_CONFIG: PiWebConfig = {
  worktree: {
    baseRef: "HEAD",
    branchNameTemplate: "pi/{yyyyMMdd-HHmmss}",
    baseDirTemplate: "{repoParent}/{repoName}.worktrees",
    pathTemplate: "{baseDir}/{branchSlug}",
    sessionDisplay: "separate",
  },
};

export function getPiWebConfigPath(): string {
  return join(getAgentDir(), "pi-web.json");
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function readSessionDisplay(value: unknown, fallback: "separate" | "tag"): "separate" | "tag" {
  return value === "separate" || value === "tag" ? value : fallback;
}

export function readPiWebConfig(): PiWebConfig {
  const defaults = DEFAULT_PI_WEB_CONFIG;
  const path = getPiWebConfigPath();
  if (!existsSync(path)) return defaults;

  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { worktree?: Record<string, unknown> };
    const worktree = raw.worktree ?? {};
    return {
      worktree: {
        baseRef: readString(worktree.baseRef, defaults.worktree.baseRef),
        branchNameTemplate: readString(worktree.branchNameTemplate, defaults.worktree.branchNameTemplate),
        baseDirTemplate: readString(worktree.baseDirTemplate, defaults.worktree.baseDirTemplate),
        pathTemplate: readString(worktree.pathTemplate, defaults.worktree.pathTemplate),
        sessionDisplay: readSessionDisplay(worktree.sessionDisplay, defaults.worktree.sessionDisplay),
      },
    };
  } catch {
    return defaults;
  }
}
