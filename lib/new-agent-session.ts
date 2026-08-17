/**
 * Shared new-session start used by the browser `/api/agent/new` route and the
 * desktop quick-session control path. One AgentSession wrapper / start lock
 * still lives in rpc-manager; this module only sequences cwd checks, tool
 * selection, model/thinking apply, and fire-and-forget first Prompt dispatch.
 */

import { statSync } from "fs";
import { registerAllowedRoot } from "./allowed-roots";
import { canonicalizeCwd } from "./cwd";

export type NewAgentSessionToolPreset = "all" | "read-only" | "none";

export type NewAgentSessionCommand = {
  type?: string;
  message?: unknown;
  images?: unknown;
  provider?: unknown;
  modelId?: unknown;
  toolNames?: unknown;
  toolPreset?: unknown;
  thinkingLevel?: unknown;
  [key: string]: unknown;
};

export type NewAgentSessionInput = {
  cwd: string;
  command: NewAgentSessionCommand;
};

export type NewAgentSessionSuccess = {
  success: true;
  sessionId: string;
  data: unknown;
};

export type NewAgentSessionFailure = {
  success: false;
  status: 400 | 500;
  error: string;
};

export type NewAgentSessionResult = NewAgentSessionSuccess | NewAgentSessionFailure;

export type NewAgentSessionRuntime = {
  canonicalizeCwd?: (cwd: string) => string;
  directoryExists?: (cwd: string) => boolean;
  startRpcSession?: (
    sessionId: string,
    sessionFile: string,
    cwd: string,
    toolSelection?: { preset?: NewAgentSessionToolPreset; names?: string[] },
  ) => Promise<{ session: { send: (payload: unknown) => Promise<unknown> }; realSessionId: string }>;
  registerAllowedRoot?: (cwd: string) => void;
  now?: () => number;
};

function inspectCwd(cwd: string, original: string): NewAgentSessionFailure | { ok: true } {
  try {
    if (!statSync(cwd).isDirectory()) {
      return { success: false, status: 400, error: `Path is not a directory: ${original}` };
    }
    return { ok: true };
  } catch {
    return { success: false, status: 400, error: `Directory does not exist: ${original}` };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return names.length > 0 ? names : undefined;
}

function asToolPreset(value: unknown): NewAgentSessionToolPreset | undefined {
  return value === "all" || value === "read-only" || value === "none" ? value : undefined;
}

export async function startNewAgentSession(
  input: NewAgentSessionInput,
  runtime: NewAgentSessionRuntime = {},
): Promise<NewAgentSessionResult> {
  const cwdRaw = typeof input.cwd === "string" ? input.cwd : "";
  if (!cwdRaw.trim()) {
    return { success: false, status: 400, error: "cwd is required" };
  }

  const canonicalize = runtime.canonicalizeCwd ?? canonicalizeCwd;
  const canonicalCwd = canonicalize(cwdRaw);
  if (runtime.directoryExists) {
    if (!runtime.directoryExists(canonicalCwd)) {
      return { success: false, status: 400, error: `Directory does not exist: ${cwdRaw}` };
    }
  } else {
    const inspected = inspectCwd(canonicalCwd, cwdRaw);
    if (!("ok" in inspected)) return inspected;
  }

  const command = input.command ?? {};
  const provider = asString(command.provider);
  const modelId = asString(command.modelId);
  const toolNames = asToolNames(command.toolNames);
  const toolPreset = asToolPreset(command.toolPreset);
  const thinkingLevel = asString(command.thinkingLevel);
  const promptCommand: Record<string, unknown> = { ...command };
  delete promptCommand.provider;
  delete promptCommand.modelId;
  delete promptCommand.toolNames;
  delete promptCommand.toolPreset;
  delete promptCommand.thinkingLevel;

  const now = runtime.now ?? Date.now;
  const tempKey = `__new__${now()}`;
  const start =
    runtime.startRpcSession
    ?? (await import("./rpc-manager")).startRpcSession;
  const registerRoot = runtime.registerAllowedRoot ?? registerAllowedRoot;

  try {
    const { session, realSessionId } = await start(tempKey, "", canonicalCwd, {
      preset: toolPreset,
      names: toolNames,
    });

    // Keep allowed workspace roots in sync so brand-new cwd file/SnFlow
    // requests do not have to wait for a session-list cache refresh.
    registerRoot(canonicalCwd);

    if (provider && modelId) {
      await session.send({ type: "set_model", provider, modelId });
    }
    if (thinkingLevel) {
      await session.send({ type: "set_thinking_level", level: thinkingLevel });
    }

    const result = await session.send(promptCommand);
    return { success: true, sessionId: realSessionId, data: result };
  } catch (error) {
    return { success: false, status: 500, error: String(error) };
  }
}
