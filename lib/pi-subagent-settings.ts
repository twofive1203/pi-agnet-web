import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { createHash } from "crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { canonicalizeCwd } from "./cwd";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PiSubagentThinkingValue = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface PiSubagentOverridePatch {
  model?: string | null;
  thinking?: PiSubagentThinkingValue | null;
  fallbackModels?: string[] | null;
}

export interface PiSubagentManagedProjection {
  defaultModel?: string;
  agentOverrides: Record<string, {
    model?: string | false;
    thinking?: string | false;
    fallbackModels?: string[] | false;
  }>;
}

export interface PiSubagentSettingsFileResult {
  path: string;
  exists: boolean;
  revision: string;
  managed: PiSubagentManagedProjection;
  parseError?: string;
  validationError?: string;
}

export interface PiSubagentSettingsPatch {
  expectedRevision: string;
  defaultModel?: string | null;
  agentOverrides?: Record<string, PiSubagentOverridePatch>;
}

export interface PiSubagentSettingsWriteResult {
  success: boolean;
  result?: PiSubagentSettingsFileResult;
  error?: string;
  status: number;
}

// ---------------------------------------------------------------------------
// Revision helpers
// ---------------------------------------------------------------------------

function computeRevision(path: string, raw: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${path}::${JSON.stringify(raw)}`)
    .digest("hex")
    .slice(0, 12);
}

function revisionFromPath(path: string): string {
  if (!existsSync(path)) {
    return computeRevision(path, {});
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (isRecord(parsed)) {
      return computeRevision(path, parsed);
    }
    return computeRevision(path, { _parseError: true });
  } catch {
    return computeRevision(path, { _parseError: true });
  }
}

// ---------------------------------------------------------------------------
// Scope path resolution
// ---------------------------------------------------------------------------

export function getUserSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

export function getProjectSettingsPath(cwd: string): string | null {
  const canonical = canonicalizeCwd(cwd);
  if (!canonical) return null;
  return join(canonical, ".pi", "settings.json");
}

// ---------------------------------------------------------------------------
// Strict read
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const THINKING_VALUES = new Set<PiSubagentThinkingValue>(["off", "minimal", "low", "medium", "high", "xhigh"]);
const QUALIFIED_MODEL_RE = /^[^/\s]+\/\S+$/;

function validateAgentName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (!/^[\w.-]+$/.test(trimmed)) return null;
  return trimmed;
}

function addValidationError(errors: string[], path: string, message: string): void {
  errors.push(`${path}: ${message}`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function extractManagedProjection(subagents: unknown, errors: string[]): PiSubagentManagedProjection {
  const managed: PiSubagentManagedProjection = { agentOverrides: {} };

  if (subagents === undefined) return managed;
  if (!isRecord(subagents)) {
    addValidationError(errors, "subagents", "must be a JSON object when present");
    return managed;
  }

  if (Object.prototype.hasOwnProperty.call(subagents, "defaultModel")) {
    if (isNonEmptyString(subagents.defaultModel)) {
      managed.defaultModel = subagents.defaultModel;
    } else {
      addValidationError(errors, "subagents.defaultModel", "must be a non-empty model id string");
    }
  }

  if (!Object.prototype.hasOwnProperty.call(subagents, "agentOverrides")) return managed;
  if (!isRecord(subagents.agentOverrides)) {
    addValidationError(errors, "subagents.agentOverrides", "must be a JSON object when present");
    return managed;
  }

  for (const [name, raw] of Object.entries(subagents.agentOverrides)) {
    if (!validateAgentName(name)) {
      addValidationError(errors, `subagents.agentOverrides.${name}`, "agent name is invalid");
      continue;
    }
    if (!isRecord(raw)) {
      addValidationError(errors, `subagents.agentOverrides.${name}`, "override must be a JSON object");
      continue;
    }

    const agentOverride: {
      model?: string | false;
      thinking?: string | false;
      fallbackModels?: string[] | false;
    } = {};

    if (Object.prototype.hasOwnProperty.call(raw, "model")) {
      if (isNonEmptyString(raw.model)) {
        agentOverride.model = raw.model;
      } else if (raw.model === false) {
        agentOverride.model = false;
      } else {
        addValidationError(errors, `subagents.agentOverrides.${name}.model`, "must be a non-empty string or false");
      }
    }

    if (Object.prototype.hasOwnProperty.call(raw, "thinking")) {
      if (typeof raw.thinking === "string" && THINKING_VALUES.has(raw.thinking as PiSubagentThinkingValue)) {
        agentOverride.thinking = raw.thinking;
      } else if (raw.thinking === false) {
        agentOverride.thinking = false;
      } else {
        addValidationError(errors, `subagents.agentOverrides.${name}.thinking`, "must be off/minimal/low/medium/high/xhigh or false");
      }
    }

    if (Object.prototype.hasOwnProperty.call(raw, "fallbackModels")) {
      if (raw.fallbackModels === false) {
        agentOverride.fallbackModels = false;
      } else if (Array.isArray(raw.fallbackModels)) {
        const seen = new Set<string>();
        const values: string[] = [];
        raw.fallbackModels.forEach((item, index) => {
          if (!isNonEmptyString(item)) {
            addValidationError(errors, `subagents.agentOverrides.${name}.fallbackModels[${index}]`, "must be a non-empty string");
            return;
          }
          if (seen.has(item)) {
            addValidationError(errors, `subagents.agentOverrides.${name}.fallbackModels`, `contains duplicate model ${item}`);
            return;
          }
          seen.add(item);
          values.push(item);
        });
        if (values.length === 0) {
          addValidationError(errors, `subagents.agentOverrides.${name}.fallbackModels`, "must not be an empty list; delete the field to inherit");
        } else {
          agentOverride.fallbackModels = values;
        }
      } else {
        addValidationError(errors, `subagents.agentOverrides.${name}.fallbackModels`, "must be a non-empty string array or false");
      }
    }

    if (Object.keys(agentOverride).length > 0) {
      managed.agentOverrides[name] = agentOverride;
    }
  }

  return managed;
}

export function readPiSubagentSettings(path: string): PiSubagentSettingsFileResult {
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      revision: revisionFromPath(path),
      managed: { agentOverrides: {} },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      path,
      exists: true,
      revision: revisionFromPath(path),
      managed: { agentOverrides: {} },
      parseError: error instanceof Error ? error.message : String(error),
    };
  }

  if (!isRecord(parsed)) {
    return {
      path,
      exists: true,
      revision: revisionFromPath(path),
      managed: { agentOverrides: {} },
      validationError: "Settings file root must be a JSON object",
    };
  }

  const errors: string[] = [];
  const managed = extractManagedProjection(parsed.subagents, errors);
  return {
    path,
    exists: true,
    revision: revisionFromPath(path),
    managed,
    validationError: errors.length > 0 ? errors.join("; ") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Patch validation and merge
// ---------------------------------------------------------------------------

function validateModelValue(value: unknown, knownModelIds: Set<string>, label: string): { value?: string | null; error?: string } {
  if (value === undefined) return { value: undefined };
  if (value === null) return { value: null };
  if (!isNonEmptyString(value)) return { error: `${label} must be a non-empty model id string or null` };
  if (!QUALIFIED_MODEL_RE.test(value)) return { error: `${label} must be an exact qualified provider/id model id` };
  if (!knownModelIds.has(value)) return { error: `${label} is not available in Pi's model registry: ${value}` };
  return { value };
}

function validateThinkingValue(value: unknown): PiSubagentThinkingValue | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" && THINKING_VALUES.has(value as PiSubagentThinkingValue)) {
    return value as PiSubagentThinkingValue;
  }
  return undefined;
}

function validateFallbackModels(value: unknown, knownModelIds: Set<string>, label: string): { value?: string[] | null; error?: string } {
  if (value === undefined) return { value: undefined };
  if (value === null) return { value: null };
  if (!Array.isArray(value)) return { error: `${label} must be a model id array or null` };
  if (value.length === 0) return { error: `${label} must not be empty; use null to clear fallback models` };

  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of value) {
    if (!isNonEmptyString(item)) return { error: `${label} contains an empty model id` };
    if (!QUALIFIED_MODEL_RE.test(item)) return { error: `${label} entry must be an exact qualified provider/id model id: ${item}` };
    if (!knownModelIds.has(item)) return { error: `${label} entry is not available in Pi's model registry: ${item}` };
    if (seen.has(item)) return { error: `${label} contains duplicate model id: ${item}` };
    seen.add(item);
    models.push(item);
  }
  return { value: models };
}

function deepDeleteEmptyParent(obj: Record<string, unknown>, key: string): void {
  delete obj[key];
}

function cleanupEmptySubagents(raw: Record<string, unknown>): void {
  const subagents = isRecord(raw.subagents) ? (raw.subagents as Record<string, unknown>) : undefined;
  if (!subagents) return;

  const overrides = isRecord(subagents.agentOverrides) ? (subagents.agentOverrides as Record<string, unknown>) : undefined;
  if (overrides) {
    for (const [name, override] of Object.entries(overrides)) {
      if (isRecord(override) && Object.keys(override).length === 0) {
        deepDeleteEmptyParent(overrides, name);
      }
    }
    if (Object.keys(overrides).length === 0) {
      deepDeleteEmptyParent(subagents, "agentOverrides");
    }
  }

  if (Object.keys(subagents).length === 0) {
    deepDeleteEmptyParent(raw, "subagents");
  }
}

export function applySubagentsPatch(
  path: string,
  patch: PiSubagentSettingsPatch,
  knownModelIds: Set<string>,
): PiSubagentSettingsWriteResult {
  const current = readPiSubagentSettings(path);

  if (current.parseError) {
    return {
      success: false,
      status: 409,
      error: `Settings file contains invalid JSON and cannot be safely modified: ${current.parseError}`,
    };
  }
  if (current.validationError) {
    return {
      success: false,
      status: 409,
      error: `Settings file content is invalid: ${current.validationError}`,
    };
  }

  if (current.revision !== patch.expectedRevision) {
    return {
      success: false,
      status: 409,
      error: `Revision mismatch: expected ${patch.expectedRevision} but current file has ${current.revision}. The file was modified externally. Please reload and try again.`,
    };
  }

  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (isRecord(parsed)) raw = parsed;
  }

  const subagents = isRecord(raw.subagents) ? { ...(raw.subagents as Record<string, unknown>) } : {} as Record<string, unknown>;

  if (Object.prototype.hasOwnProperty.call(patch, "defaultModel")) {
    const validated = validateModelValue(patch.defaultModel, knownModelIds, "defaultModel");
    if (validated.error) return { success: false, status: 400, error: validated.error };
    if (validated.value === null) {
      deepDeleteEmptyParent(subagents, "defaultModel");
    } else if (validated.value !== undefined) {
      subagents.defaultModel = validated.value;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "agentOverrides")) {
    if (patch.agentOverrides === null || !isRecord(patch.agentOverrides)) {
      return { success: false, status: 400, error: "agentOverrides must be an object when present" };
    }

    const overrides: Record<string, Record<string, unknown>> = {};
    const existingOverrides = isRecord(subagents.agentOverrides) ? { ...(subagents.agentOverrides as Record<string, unknown>) } : {};

    for (const [name, existing] of Object.entries(existingOverrides)) {
      if (isRecord(existing)) {
        overrides[name] = { ...existing };
      }
    }

    for (const [name, override] of Object.entries(patch.agentOverrides)) {
      const cleanName = validateAgentName(name);
      if (!cleanName) {
        return { success: false, status: 400, error: `Invalid agent name: ${name}` };
      }
      if (!isRecord(override)) {
        return { success: false, status: 400, error: `Invalid override for agent "${cleanName}"` };
      }

      const target = overrides[cleanName] ?? {};

      if (Object.prototype.hasOwnProperty.call(override, "model")) {
        const validated = validateModelValue(override.model, knownModelIds, `model for agent "${cleanName}"`);
        if (validated.error) return { success: false, status: 400, error: validated.error };
        if (validated.value === null) {
          deepDeleteEmptyParent(target, "model");
        } else if (validated.value !== undefined) {
          target.model = validated.value;
        }
      }

      if (Object.prototype.hasOwnProperty.call(override, "thinking")) {
        const validated = validateThinkingValue(override.thinking);
        if (validated === undefined) {
          return { success: false, status: 400, error: `Invalid thinking value for agent "${cleanName}"` };
        }
        if (validated === null) {
          deepDeleteEmptyParent(target, "thinking");
        } else {
          target.thinking = validated;
        }
      }

      if (Object.prototype.hasOwnProperty.call(override, "fallbackModels")) {
        const validated = validateFallbackModels(override.fallbackModels, knownModelIds, `fallbackModels for agent "${cleanName}"`);
        if (validated.error) return { success: false, status: 400, error: validated.error };
        if (validated.value === null) {
          deepDeleteEmptyParent(target, "fallbackModels");
        } else if (validated.value !== undefined) {
          target.fallbackModels = validated.value;
        }
      }

      if (Object.keys(target).length === 0) {
        deepDeleteEmptyParent(overrides, cleanName);
      } else {
        overrides[cleanName] = target;
      }
    }

    if (Object.keys(overrides).length === 0) {
      deepDeleteEmptyParent(subagents, "agentOverrides");
    } else {
      subagents.agentOverrides = overrides;
    }
  }

  raw.subagents = subagents;
  cleanupEmptySubagents(raw);

  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    renameSync(tmpPath, path);
  } catch (error) {
    return {
      success: false,
      status: 500,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    success: true,
    status: 200,
    result: readPiSubagentSettings(path),
  };
}
