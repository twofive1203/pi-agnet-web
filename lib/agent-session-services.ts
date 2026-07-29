/**
 * Shared target-cwd AgentSession services helpers.
 * Interactive and automation adapters must not share default tools/UI policy.
 */

import { preparePiRuntimeEnvironment } from "./pi-runtime-resolver";

export type TargetCwdServicesOptions = {
  cwd: string;
  agentDir?: string;
  /** Optional resource loader factory hook applied before reload. */
  createResourceLoader?: (sdk: PiSdkSubset, ctx: { cwd: string; agentDir: string }) => Promise<unknown> | unknown;
};

export type PiSdkSubset = {
  getAgentDir: () => string;
  SettingsManager: { create: (cwd: string, agentDir: string) => unknown };
  DefaultResourceLoader: new (opts: Record<string, unknown>) => {
    reload: () => Promise<void>;
    getExtensions: () => { extensions: Array<{ path: string }>; errors?: unknown[] };
    getSkills?: () => unknown;
  };
  SessionManager: {
    create: (cwd: string, sessionDir?: string) => unknown;
    open: (sessionFile: string, sessionDir?: string) => unknown;
    inMemory: (cwd: string, opts?: { id?: string }) => unknown;
  };
  createAgentSession: (opts: Record<string, unknown>) => Promise<{
    session: AgentSessionLike;
    extensionsResult: { errors?: Array<{ path: string; error: string }> };
  }>;
};

export type AgentSessionLike = {
  sessionId: string;
  sessionFile?: string;
  prompt: (text: string) => Promise<unknown>;
  abort?: () => void;
  dispose?: () => void;
  bindExtensions?: (opts?: Record<string, unknown>) => Promise<void>;
  setActiveToolsByName?: (names: string[]) => void;
  setModel?: (model: unknown) => Promise<void>;
  setThinkingLevel?: (level: string) => void | Promise<void>;
  modelRuntime?: { getModel?: (provider: string, modelId: string) => unknown };
  model?: { id?: string; provider?: string } | null;
  thinkingLevel?: string;
  getAllTools?: () => Array<{ name: string; description?: string; sourceInfo?: { path?: string } }>;
  subscribe?: (fn: (event: unknown) => void) => () => void;
  extensionRunner?: unknown;
};

async function loadPiSdk(): Promise<PiSdkSubset> {
  return (await import("@earendil-works/pi-coding-agent")) as unknown as PiSdkSubset;
}

export async function createTargetCwdRuntime(options: TargetCwdServicesOptions): Promise<{
  sdk: PiSdkSubset;
  cwd: string;
  agentDir: string;
  settingsManager: unknown;
  resourceLoader: unknown | undefined;
}> {
  const sdk = await loadPiSdk();
  const agentDir = options.agentDir ?? sdk.getAgentDir();
  preparePiRuntimeEnvironment({ cwd: options.cwd, agentDir });
  const settingsManager = sdk.SettingsManager.create(options.cwd, agentDir);
  let resourceLoader: unknown | undefined;
  if (options.createResourceLoader) {
    resourceLoader = await options.createResourceLoader(sdk, { cwd: options.cwd, agentDir });
    const loader = resourceLoader as { reload?: () => Promise<void> } | undefined;
    if (loader?.reload) await loader.reload();
  }
  return { sdk, cwd: options.cwd, agentDir, settingsManager, resourceLoader };
}

export async function createAgentSessionWithServices(input: {
  cwd: string;
  agentDir?: string;
  sessionManager: unknown;
  resourceLoader?: unknown;
  customTools?: unknown[];
  tools?: unknown;
  settingsManager?: unknown;
}): Promise<{
  session: AgentSessionLike;
  extensionsResult: { errors?: Array<{ path: string; error: string }> };
  sdk: PiSdkSubset;
}> {
  const runtime = await createTargetCwdRuntime({
    cwd: input.cwd,
    agentDir: input.agentDir,
  });
  const { session, extensionsResult } = await runtime.sdk.createAgentSession({
    cwd: input.cwd,
    agentDir: runtime.agentDir,
    sessionManager: input.sessionManager,
    ...(input.resourceLoader ? { resourceLoader: input.resourceLoader } : {}),
    ...(input.customTools ? { customTools: input.customTools } : {}),
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.settingsManager || runtime.settingsManager
      ? { settingsManager: input.settingsManager ?? runtime.settingsManager }
      : {}),
  });
  return { session, extensionsResult, sdk: runtime.sdk };
}
