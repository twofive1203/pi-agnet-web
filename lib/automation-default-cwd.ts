/**
 * Stable default Automation workspace root (~/pi-automation-cwd).
 * Canonical absolute path is persisted once; HOME/account drift blocks and
 * requires migration rather than creating a second default directory.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import { canonicalizeCwd, expandCwd } from "./cwd";
import {
  getAutomationConfigPath,
  getAutomationRoot,
  getDefaultAutomationCwdCandidate,
} from "./automation-paths";
import { AUTOMATION_SCHEMA_VERSION } from "./automation-types";


export class AutomationDefaultCwdError extends Error {
  readonly code: "cwd_unavailable" | "cwd_drift" | "cwd_invalid";

  constructor(message: string, code: AutomationDefaultCwdError["code"]) {
    super(message);
    this.name = "AutomationDefaultCwdError";
    this.code = code;
  }
}

interface AutomationConfigFile {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION;
  defaultCwdCanonical: string | null;
  defaultCwdDisplay: string;
  defaultCwdInitializedAt: string | null;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Date.now()}-${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function emptyConfig(): AutomationConfigFile {
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    defaultCwdCanonical: null,
    defaultCwdDisplay: "~/pi-automation-cwd",
    defaultCwdInitializedAt: null,
    updatedAt: nowIso(),
  };
}

function readConfig(agentDir?: string): AutomationConfigFile {
  const path = getAutomationConfigPath(agentDir);
  if (!existsSync(path)) return emptyConfig();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as AutomationConfigFile;
    if (raw?.schemaVersion !== AUTOMATION_SCHEMA_VERSION) return emptyConfig();
    return {
      ...emptyConfig(),
      ...raw,
    };
  } catch {
    throw new AutomationDefaultCwdError("Automation config is corrupt", "cwd_invalid");
  }
}

function writeConfig(config: AutomationConfigFile, agentDir?: string): void {
  writeJsonAtomic(getAutomationConfigPath(agentDir), {
    ...config,
    updatedAt: nowIso(),
  });
}

function ensureOwnerOnlyDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  try {
    // Best-effort on Windows; meaningful on POSIX.
    chmodSync(dir, 0o700);
  } catch {
    // ignore
  }
}

function registerRoots(cwd: string): void {
  // Lazy import avoids pulling session-reader/pi SDK into pure store smokes.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerAllowedRoot } = require("./allowed-roots") as typeof import("./allowed-roots");
    registerAllowedRoot(cwd);
  } catch {
    // optional in unit smokes
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { allowFileRoot } = require("./file-access") as typeof import("./file-access");
    allowFileRoot(cwd);
  } catch {
    // optional in unit smokes
  }
}

/**
 * Returns the persisted canonical default cwd, initializing once if needed.
 * Does not fall back to process.cwd().
 */
export function ensureAutomationDefaultCwd(agentDir?: string): {
  canonical: string;
  display: string;
  initialized: boolean;
} {
  mkdirSync(getAutomationRoot(agentDir), { recursive: true });
  const config = readConfig(agentDir);

  if (config.defaultCwdCanonical) {
    const persisted = config.defaultCwdCanonical;
    if (!existsSync(persisted)) {
      throw new AutomationDefaultCwdError(
        `Persisted Automation default cwd is missing: ${persisted}. Migrate or restore it before running automations.`,
        "cwd_unavailable",
      );
    }
    let st;
    try {
      st = statSync(persisted);
    } catch {
      throw new AutomationDefaultCwdError(
        `Persisted Automation default cwd is unreadable: ${persisted}`,
        "cwd_unavailable",
      );
    }
    if (!st.isDirectory()) {
      throw new AutomationDefaultCwdError(
        `Persisted Automation default cwd is not a directory: ${persisted}`,
        "cwd_invalid",
      );
    }

    // HOME/account drift must block and require explicit migration — never
    // silently fall back to a new HOME-derived path while the old one exists.
    let candidateNow: string;
    try {
      candidateNow = canonicalizeCwd(getDefaultAutomationCwdCandidate());
    } catch {
      candidateNow = getDefaultAutomationCwdCandidate();
    }
    if (candidateNow && candidateNow !== persisted) {
      throw new AutomationDefaultCwdError(
        `Persisted Automation default cwd drifted from current HOME/account candidate. ` +
          `Persisted=${persisted}; current=${candidateNow}. ` +
          `Migrate explicitly (update automations config) before running automations.`,
        "cwd_drift",
      );
    }

    const canonical = canonicalizeCwd(persisted);
    registerRoots(canonical);
    return {
      canonical,
      display: config.defaultCwdDisplay,
      initialized: false,
    };
  }

  const candidate = expandCwd(getDefaultAutomationCwdCandidate());
  if (existsSync(candidate)) {
    const st = statSync(candidate);
    if (!st.isDirectory()) {
      throw new AutomationDefaultCwdError(
        `Default Automation cwd path exists and is not a directory: ${candidate}`,
        "cwd_invalid",
      );
    }
  } else {
    ensureOwnerOnlyDir(candidate);
  }

  const canonical = canonicalizeCwd(candidate);
  ensureOwnerOnlyDir(canonical);
  registerRoots(canonical);

  writeConfig(
    {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      defaultCwdCanonical: canonical,
      defaultCwdDisplay: "~/pi-automation-cwd",
      defaultCwdInitializedAt: nowIso(),
      updatedAt: nowIso(),
    },
    agentDir,
  );

  return {
    canonical,
    display: "~/pi-automation-cwd",
    initialized: true,
  };
}

export function getAutomationDefaultCwdIfInitialized(agentDir?: string): string | null {
  try {
    const config = readConfig(agentDir);
    if (!config.defaultCwdCanonical) return null;
    if (!existsSync(config.defaultCwdCanonical)) return null;
    return canonicalizeCwd(config.defaultCwdCanonical);
  } catch {
    return null;
  }
}

export function resolveAutomationTargetCwd(input: {
  cwd?: string | null;
  cwdSource?: "project" | "default";
  agentDir?: string;
}): { cwd: string; cwdSource: "project" | "default"; display: string } {
  if (input.cwdSource === "default" || !input.cwd) {
    const def = ensureAutomationDefaultCwd(input.agentDir);
    return { cwd: def.canonical, cwdSource: "default", display: def.display };
  }
  const expanded = expandCwd(input.cwd);
  if (!existsSync(expanded)) {
    throw new AutomationDefaultCwdError(`Project cwd does not exist: ${input.cwd}`, "cwd_unavailable");
  }
  const st = statSync(expanded);
  if (!st.isDirectory()) {
    throw new AutomationDefaultCwdError(`Project cwd is not a directory: ${input.cwd}`, "cwd_invalid");
  }
  const canonical = canonicalizeCwd(expanded);
  registerRoots(canonical);
  return { cwd: canonical, cwdSource: "project", display: canonical };
}
