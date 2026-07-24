import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { statSync } from "fs";
import path from "path";
import { cacheSessionPath } from "./session-reader";
import { recordSessionFileChangeEvent } from "./session-file-changes";
import { canonicalizeCwd } from "./cwd";
import { preparePiRuntimeEnvironment } from "./pi-runtime-resolver";
import { ExtensionWebUiBridge } from "./extension-web-ui";
import type { AgentSessionLike, ToolInfo } from "./pi-types";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

export type ToolPresetMode = "all" | "read-only" | "none";

interface ToolSelection {
  preset?: ToolPresetMode;
  names?: string[];
}

const READ_ONLY_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
const SNFLOW_CHAT_LIFECYCLE_EXTENSION_PATH = "<inline:snflow-chat-lifecycle>";

interface ExtensionLoadProjection {
  extensions: Array<{ path: string }>;
  errors: Array<{ path: string; error: string }>;
}

export function isSnflowLifecycleRequired(cwd: string): boolean {
  try {
    return statSync(path.join(canonicalizeCwd(cwd), ".pi", "snflows", "tasks")).isDirectory();
  } catch {
    return false;
  }
}

export function getSnflowChatLifecycleLoadDiagnostic(result: ExtensionLoadProjection): string | null {
  const matchingErrors = result.errors
    .filter((error) => error.path === SNFLOW_CHAT_LIFECYCLE_EXTENSION_PATH)
    .map((error) => error.error);
  if (matchingErrors.length > 0) {
    return `${SNFLOW_CHAT_LIFECYCLE_EXTENSION_PATH} failed to load: ${matchingErrors.join("; ")}`;
  }
  if (!result.extensions.some((extension) => extension.path === SNFLOW_CHAT_LIFECYCLE_EXTENSION_PATH)) {
    return `${SNFLOW_CHAT_LIFECYCLE_EXTENSION_PATH} was not loaded`;
  }
  return null;
}

function isToolPresetMode(value: unknown): value is ToolPresetMode {
  return value === "all" || value === "read-only" || value === "none";
}

function getToolNamesForPreset(session: AgentSessionLike, preset: ToolPresetMode): string[] {
  if (preset === "none") return [];

  const allToolNames = session.getAllTools().map((tool) => tool.name);
  if (preset === "all") return allToolNames;
  return allToolNames.filter((name) => READ_ONLY_TOOL_NAMES.has(name));
}

function applyActiveTools(session: AgentSessionLike, names: string[]): void {
  session.setActiveToolsByName(names);
  // pi's buildSystemPrompt can remain non-empty with no tools; clear it so Off
  // is a true no-tool mode in the web UI.
  if (names.length === 0 && session.agent.state) {
    session.agent.state.systemPrompt = "";
  }
}

function applyToolSelection(session: AgentSessionLike, selection?: ToolSelection): void {
  if (selection?.preset) {
    applyActiveTools(session, getToolNamesForPreset(session, selection.preset));
    return;
  }

  if (selection?.names) {
    applyActiveTools(session, selection.names);
    return;
  }

  applyActiveTools(session, getToolNamesForPreset(session, "all"));
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

const MAX_BUFFERED_EVENTS = 200;

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private eventBuffer: AgentEvent[] = [];
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private extensionUiBridge: ExtensionWebUiBridge;
  private activeToolCallIds = new Set<string>();
  private _alive = true;

  constructor(public readonly inner: AgentSessionLike, public readonly cwd: string) {
    this.extensionUiBridge = new ExtensionWebUiBridge(
      (event) => this.emitEvent(event),
      () => this.listeners.length > 0,
    );
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  isAlive(): boolean {
    return this._alive;
  }

  isToolCallActive(toolCallId: string): boolean {
    return this.activeToolCallIds.has(toolCallId);
  }

  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      this.resetIdleTimer();
      if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") {
        this.activeToolCallIds.add(event.toolCallId);
      } else if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
        this.activeToolCallIds.delete(event.toolCallId);
      }
      let fileChangeUpdate: AgentEvent | null = null;
      try {
        const result = recordSessionFileChangeEvent({
          sessionId: this.sessionId,
          sessionFile: this.sessionFile,
          cwd: this.cwd,
          event,
        });
        if (result.changed && event.type === "tool_execution_end") {
          fileChangeUpdate = {
            type: "session_file_changes_update",
            sessionId: this.sessionId,
            fileCount: result.fileCount,
          };
        }
      } catch {
        // File-change projection must never interrupt normal agent event delivery.
      }
      for (const l of this.listeners) l(event);
      if (fileChangeUpdate) {
        for (const l of this.listeners) l(fileChangeUpdate);
      }
    });
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.destroy(), 10 * 60 * 1000);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    // Replay events that fired before the SSE client attached (extension commands often finish quickly).
    const buffered = this.eventBuffer;
    this.eventBuffer = [];
    for (const event of buffered) listener(event);
    for (const event of this.extensionUiBridge.getPendingEvents()) listener(event);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  emitEvent(event: AgentEvent): void {
    if (this.listeners.length === 0) {
      this.eventBuffer.push(event);
      if (this.eventBuffer.length > MAX_BUFFERED_EVENTS) {
        this.eventBuffer.splice(0, this.eventBuffer.length - MAX_BUFFERED_EVENTS);
      }
      return;
    }
    for (const listener of this.listeners) listener(event);
  }

  async bindExtensions(): Promise<void> {
    if (!this.inner.bindExtensions) return;

    await this.inner.bindExtensions({
      uiContext: this.extensionUiBridge.createContext(),
      mode: "rpc",
      commandContextActions: {
        waitForIdle: async () => {
          await this.inner.agent.waitForIdle?.();
        },
        newSession: async () => {
          this.emitEvent({ type: "extension_error", extensionPath: "<webui-extension-host>", event: "newSession", error: "Extension-driven new sessions are not supported in WebUI yet" });
          return { cancelled: true };
        },
        fork: async () => {
          this.emitEvent({ type: "extension_error", extensionPath: "<webui-extension-host>", event: "fork", error: "Extension-driven forks are not supported in WebUI yet" });
          return { cancelled: true };
        },
        navigateTree: async (targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }) => {
          const result = await this.inner.navigateTree(targetId, {
            summarize: options?.summarize,
          });
          return { cancelled: result.cancelled };
        },
        switchSession: async () => {
          this.emitEvent({ type: "extension_error", extensionPath: "<webui-extension-host>", event: "switchSession", error: "Extension-driven session switching is not supported in WebUI yet" });
          return { cancelled: true };
        },
        reload: async () => {
          await this.inner.reload?.();
          this.emitEvent({ type: "extension_ui_request", id: `reload-${Date.now()}`, method: "notify", message: "Pi extensions, skills, prompts, and themes reloaded.", notifyType: "info" });
        },
      },
      shutdownHandler: () => this.destroy(),
      onError: (error: { extensionPath: string; event: string; error: string }) => {
        this.emitEvent({ type: "extension_error", extensionPath: error.extensionPath, event: error.event, error: error.error });
      },
    });
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    const type = command.type as string;

    switch (type) {
      case "prompt": {
        // Fire-and-forget HTTP response; lifecycle still arrives over SSE.
        // Extension slash commands (e.g. /brainstorm) return from prompt() without
        // agent_start/agent_end — emit prompt_settled so the browser can clear the spinner.
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        void this.inner
          .prompt(command.message as string, promptImages?.length ? { images: promptImages } : undefined)
          .then(() => {
            if (!this._alive) return;
            if (!this.inner.isStreaming) {
              this.emitEvent({
                type: "prompt_settled",
                sessionId: this.sessionId,
                isStreaming: false,
              });
            }
          })
          .catch((error) => {
            if (!this._alive) return;
            this.emitEvent({
              type: "prompt_error",
              sessionId: this.sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        return null;
      }

      case "abort":
        await this.inner.abort();
        return null;

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: 0,
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        const model = this.inner.modelRuntime.getModel(provider, modelId);
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;

        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          // Fork before the first message: create an empty session linked to this one
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          newManager.newSession({ parentSession: currentSessionFile });
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          // Fork after some history: copy path up to (but not including) the fork point
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) throw new Error("Failed to create forked session");
          newSessionFile = forkedPath;
        }

        const newSessionId = SessionManager.open(newSessionFile, sessionDir).getSessionId();
        cacheSessionPath(newSessionId, newSessionFile);
        this.destroy();
        return { cancelled: false, newSessionId };
      }

      case "navigate_tree": {
        const result = await this.inner.navigateTree(command.targetId as string, {});
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
        // If the model has DeepSeek thinking compat (reasoningEffortMap maps xhigh→max),
        // force the state back so the compat layer can use it correctly.
        if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        return null;
      }

      case "compact": {
        // pi's compact() does not guard against empty messagesToSummarize — use findCutPoint
        // to pre-check and throw a clean error instead of generating a useless empty summary.
        const { findCutPoint, DEFAULT_COMPACTION_SETTINGS } = await import("@earendil-works/pi-coding-agent");
        const pathEntries = this.inner.sessionManager.getBranch() as Array<{ type: string }>;
        const settings = { ...DEFAULT_COMPACTION_SETTINGS, ...this.inner.settingsManager.getCompactionSettings() };
        let prevCompactionIndex = -1;
        for (let i = pathEntries.length - 1; i >= 0; i--) {
          if (pathEntries[i].type === "compaction") { prevCompactionIndex = i; break; }
        }
        const boundaryStart = prevCompactionIndex + 1;
        const cutPoint = findCutPoint(pathEntries as never, boundaryStart, pathEntries.length, settings.keepRecentTokens);
        const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
        if (historyEnd <= boundaryStart) {
          throw new Error("Conversation too short to compact");
        }
        const result = await this.inner.compact(command.customInstructions as string | undefined);
        return result;
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        return all.map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
        }));
      }

      case "set_tools": {
        const preset = command.toolPreset;
        if (isToolPresetMode(preset)) {
          applyToolSelection(this.inner, { preset });
        } else {
          applyToolSelection(this.inner, { names: command.toolNames as string[] });
        }
        return null;
      }

      case "extension_ui_response": {
        const handled = this.extensionUiBridge.respond(command as { id: string; cancelled?: boolean; value?: string; confirmed?: boolean });
        return { handled };
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.unsubscribe?.();
    this.activeToolCallIds.clear();
    this.extensionUiBridge.rejectAll();
    try {
      this.inner.dispose?.();
    } catch {
      // Dispose is best-effort; registry cleanup must still run.
    }
    this.onDestroyCallback?.();
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const cleanup = () => globalThis.__piSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

export function reloadRpcAuthState(): number {
  let count = 0;
  for (const wrapper of getRegistry().values()) {
    if (!wrapper.isAlive()) continue;
    try {
      // 0.80.10+: ModelRuntime owns credential reload + catalog refresh.
      void wrapper.inner.modelRuntime.reloadConfig?.();
      void wrapper.inner.modelRuntime.refresh?.();
      count += 1;
    } catch {
      // Keep account activation best-effort for live wrappers; new requests/sessions
      // still read the updated auth.json through fresh ModelRuntime instances.
    }
  }

  try {
    // OpenAI Codex keeps reusable WebSockets keyed by session id. After account
    // activation, old sessions must reconnect so the new token/account headers apply.
    cleanupSessionResources();
  } catch {
    // Auth reload should remain best-effort; stale resources expire on their own.
  }

  return count;
}

export function destroyRpcSessionsForCwd(cwd: string): string[] {
  const target = canonicalizeCwd(cwd);
  const destroyed: string[] = [];
  for (const [sessionId, wrapper] of getRegistry()) {
    if (canonicalizeCwd(wrapper.cwd) !== target) continue;
    wrapper.destroy();
    destroyed.push(sessionId);
  }
  return destroyed;
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * Pass a tool selection to pre-configure active tools. Without one, web sessions
 * default to all currently loaded built-in, extension, and custom tools.
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolSelection?: ToolSelection
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const starting = (async () => {
    const {
      SessionManager,
      getAgentDir,
      DefaultResourceLoader,
      SettingsManager,
    } = await import("@earendil-works/pi-coding-agent");
    const agentDir = getAgentDir();
    preparePiRuntimeEnvironment({ cwd, agentDir });

    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, undefined)
      : SessionManager.create(cwd, undefined);

    // SnFlow is opt-in per project init only (no global enable switch).
    // - Not initialized: strip managed SnFlow extension/skill/agents so leftover
    //   project files cannot force chat onto the SnFlow path.
    // - Initialized without project extension: legacy WebUI appendSystemPrompt guidance.
    // - Initialized with project extension: extension owns before_agent_start.
    let resourceLoader: InstanceType<typeof DefaultResourceLoader> | undefined;
    const snflowLifecycleRequired = isSnflowLifecycleRequired(cwd);
    try {
      const {
        hasWorkflowExtension,
        isSnflowActiveForSession,
        isSnflowManagedAgentPath,
        isSnflowManagedExtensionPath,
        isSnflowManagedSkill,
      } = await import("./workflow-setup");
      const { buildWorkflowSystemGuidance } = await import("./workflow-guidance");
      const { createWorkflowChatLifecycleExtension } = await import("./workflow-chat-lifecycle");
      const snflowActive = isSnflowActiveForSession(cwd);
      const settingsManager = SettingsManager.create(cwd, agentDir);

      if (!snflowActive) {
        resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          extensionsOverride: (base) => ({
            ...base,
            extensions: base.extensions.filter((ext) => !isSnflowManagedExtensionPath(ext.path)),
          }),
          skillsOverride: (base) => ({
            ...base,
            skills: base.skills.filter((skill) => !isSnflowManagedSkill(skill)),
          }),
          agentsFilesOverride: (base) => ({
            ...base,
            agentsFiles: base.agentsFiles.filter((file) => !isSnflowManagedAgentPath(file.path)),
          }),
        });
      } else {
        const guidance = hasWorkflowExtension(cwd) ? null : buildWorkflowSystemGuidance(cwd);
        resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          extensionFactories: [createWorkflowChatLifecycleExtension(cwd)],
          ...(guidance ? { appendSystemPrompt: [guidance] } : {}),
        });
      }
      await resourceLoader.reload();
      if (snflowActive) {
        const lifecycleDiagnostic = getSnflowChatLifecycleLoadDiagnostic(resourceLoader.getExtensions());
        if (lifecycleDiagnostic) throw new Error(lifecycleDiagnostic);
      }
    } catch (error) {
      if (snflowLifecycleRequired) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `SnFlow lifecycle validator failed to initialize; native subagent dispatch is blocked for this session: ${message}`,
        );
      }
      // General sessions keep the SDK's default loader when optional SnFlow filtering is unavailable.
      resourceLoader = undefined;
    }

    // Do NOT pass the `tools` parameter to createAgentSession.
    // The `tools` param acts as a global allowlist that filters out extension
    // tools (e.g. `subagent` from pi-subagents). Instead, let all built-in and
    // extension tools load, then control activation via setActiveToolsByName.
    const { session: inner, extensionsResult } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager,
      ...(resourceLoader ? { resourceLoader } : {}),
    });

    const wrapper = new AgentSessionWrapper(inner, cwd);
    wrapper.start();
    await wrapper.bindExtensions();
    for (const error of extensionsResult.errors ?? []) {
      wrapper.emitEvent({ type: "extension_error", extensionPath: error.path, event: "load", error: error.error });
    }

    applyToolSelection(inner, toolSelection);

    const realSessionId = inner.sessionId as string;
    const realSessionFile = inner.sessionFile as string | undefined;
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

    wrapper.onDestroy(() => registry.delete(realSessionId));
    registry.set(realSessionId, wrapper);

    return { session: wrapper, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}
