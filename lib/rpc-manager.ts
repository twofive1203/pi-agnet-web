import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { cacheSessionPath } from "./session-reader";
import { flushSessionFileChanges, recordSessionFileChangeEvent } from "./session-file-changes";
import { canonicalizeCwd } from "./cwd";
import {
  getSnflowChatLifecycleLoadDiagnostic,
  isSnflowLifecycleRequired,
} from "./workflow-lifecycle-load";
export { getSnflowChatLifecycleLoadDiagnostic, isSnflowLifecycleRequired };
import { preparePiRuntimeEnvironment } from "./pi-runtime-resolver";
import { createBundledPiResourceLoader } from "./bundled-pi-extensions";
import { ExtensionWebUiBridge } from "./extension-web-ui";
import { createEmptyCompletedRetryExtension } from "./empty-completed-retry";
import { disposeAgentSession } from "./pi-session-lifecycle";
import type { AgentSessionLike, ToolInfo } from "./pi-types";
import { isSubagentToolName } from "./subagent-runs";
import { SubagentProgressThrottler } from "./subagent-progress-throttler";
import { AgentEventThrottler } from "./agent-event-throttler";
import { projectSubagentEvent } from "./subagent-event-projection";
import {
  nowForSubagentMetric,
  recordSubagentDuration,
  recordSubagentMetric,
} from "./subagent-observability";

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
  private destroyPromise: Promise<void> | null = null;
  private extensionUiBridge: ExtensionWebUiBridge;
  private agentEventThrottler: AgentEventThrottler<AgentEvent>;
  private subagentProgressThrottler: SubagentProgressThrottler<AgentEvent>;
  private activeToolCallIds = new Set<string>();
  private activeSubagentToolCallIds = new Set<string>();
  private _alive = true;

  constructor(public readonly inner: AgentSessionLike, public readonly cwd: string) {
    this.extensionUiBridge = new ExtensionWebUiBridge(
      (event) => this.emitEvent(event),
      () => this.listeners.length > 0,
    );
    this.agentEventThrottler = new AgentEventThrottler(
      (event) => this.deliverAgentEvent(event),
      50,
    );
    this.subagentProgressThrottler = new SubagentProgressThrottler(
      (event) => this.agentEventThrottler.handle(event),
      300,
      Date.now,
      () => recordSubagentMetric("coalescedProgress"),
      () => recordSubagentMetric("immediateProgress"),
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
      const handlerStartedAt = nowForSubagentMetric();
      this.resetIdleTimer();
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      const isSubagentEvent = toolCallId ? this.activeSubagentToolCallIds.has(toolCallId) : false;
      if (event.type === "tool_execution_start" && toolCallId) {
        this.activeToolCallIds.add(toolCallId);
        if (isSubagentToolName(event.toolName)) {
          this.activeSubagentToolCallIds.add(toolCallId);
        }
      } else if (event.type === "tool_execution_end" && toolCallId) {
        this.activeToolCallIds.delete(toolCallId);
      }
      if (isSubagentEvent && event.type === "tool_execution_update") {
        recordSubagentMetric("rawProgress");
      }
      if (isSubagentEvent && event.type === "tool_execution_end") {
        recordSubagentMetric("terminalEvents");
      }

      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
        const fileProjectionStartedAt = nowForSubagentMetric();
        const isEnd = event.type === "tool_execution_end";
        void recordSessionFileChangeEvent({
          sessionId: this.sessionId,
          sessionFile: this.sessionFile,
          cwd: this.cwd,
          event,
        }).then((result) => {
          recordSubagentDuration("fileProjectionMs", fileProjectionStartedAt);
          if (this._alive && result.changed && isEnd) {
            this.emitEvent({
              type: "session_file_changes_update",
              sessionId: this.sessionId,
              fileCount: result.fileCount,
            });
          }
        }, () => {
          // File-change projection must never interrupt normal agent event delivery.
          recordSubagentDuration("fileProjectionMs", fileProjectionStartedAt);
        });
      }

      this.subagentProgressThrottler.handle(event, isSubagentEvent);
      if (event.type === "tool_execution_end" && toolCallId) {
        this.activeSubagentToolCallIds.delete(toolCallId);
      }
      recordSubagentDuration("handlerMs", handlerStartedAt);
    });
    this.resetIdleTimer();
  }

  private deliverAgentEvent(event: AgentEvent): void {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    const isSubagentEvent = toolCallId ? this.activeSubagentToolCallIds.has(toolCallId) : false;
    const projectionStartedAt = nowForSubagentMetric();
    const browserEvent = isSubagentEvent ? projectSubagentEvent(event) : event;
    recordSubagentDuration("projectionMs", projectionStartedAt);
    if (isSubagentEvent && event.type === "tool_execution_update") {
      recordSubagentMetric("deliveredProgress");
    }
    // Reuse the buffered path so a throttled trailing snapshot is not lost while
    // the browser is between SSE connections.
    this.publishEvent(browserEvent);
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
    // Extension/UI events share the same ordering barrier as SDK lifecycle events.
    this.agentEventThrottler.handle(event);
  }

  private publishEvent(event: AgentEvent): void {
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
        await this.destroyForReplacement("fork");
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
    void this.destroyWithReason("quit").catch(() => {
      // Teardown is best-effort for idle/process shutdown paths.
    });
  }

  private destroyForReplacement(reason: "new" | "resume" | "fork"): Promise<void> {
    return this.destroyWithReason(reason);
  }

  private destroyWithReason(reason: "quit" | "new" | "resume" | "fork"): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;

    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.unsubscribe?.();
    this.subagentProgressThrottler.clear();
    this.agentEventThrottler.clear();
    this.activeToolCallIds.clear();
    this.activeSubagentToolCallIds.clear();
    this.extensionUiBridge.rejectAll();

    this.destroyPromise = (async () => {
      try {
        // Browser tab bindings are temporary and must not survive wrapper teardown/fork.
        const sessionId = this.inner.sessionId;
        if (sessionId) {
          void import("./browser-binding-manager").then(({ getBrowserBindingManager }) => {
            getBrowserBindingManager().invalidateSession(sessionId);
          }).catch(() => {
            // Browser control is optional; destroy must still complete.
          });
        }
      } catch {
        // ignore
      }
      try {
        await flushSessionFileChanges(this.inner.sessionId);
      } catch {
        // Changed-file projection is best-effort and must not block SDK disposal on failure.
      }
      await disposeAgentSession(this.inner, reason);
      this.onDestroyCallback?.();
    })();

    return this.destroyPromise;
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
      // ModelRuntime owns credential reload + catalog refresh.
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

    // Project init makes SnFlow resources available; conversational entry stays opt-in.
    // - Not initialized: strip managed SnFlow extension/skill/agents so leftover
    //   project files cannot expose an unavailable workflow path.
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
        resourceLoader = createBundledPiResourceLoader(DefaultResourceLoader, {
          cwd,
          agentDir,
          settingsManager,
          extensionFactories: [createEmptyCompletedRetryExtension()],
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
        resourceLoader = createBundledPiResourceLoader(DefaultResourceLoader, {
          cwd,
          agentDir,
          settingsManager,
          extensionFactories: [
            createEmptyCompletedRetryExtension(),
            createWorkflowChatLifecycleExtension(cwd),
          ],
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
      // Keep the retry normalizer available even if optional SnFlow filtering fails.
      try {
        resourceLoader = createBundledPiResourceLoader(DefaultResourceLoader, {
          cwd,
          agentDir,
          settingsManager: SettingsManager.create(cwd, agentDir),
          extensionFactories: [createEmptyCompletedRetryExtension()],
        });
        await resourceLoader.reload();
      } catch {
        // General sessions keep the SDK's default loader as the final fallback.
        resourceLoader = undefined;
      }
    }

    // Do NOT pass the `tools` parameter to createAgentSession.
    // The `tools` param acts as a global allowlist that filters out extension
    // tools (e.g. `subagent` from pi-subagents). Instead, let all built-in and
    // extension tools load, then control activation via setActiveToolsByName.
    // Browser tools are customTools (not extension_ui_request) and inject session
    // id from ctx.sessionManager at execute time.
    const { createBrowserToolDefinitions } = await import("./browser-tools");
    const { createAutomationToolDefinitions } = await import("./automation-tools");
    // Interactive sessions get browser + automation management tools.
    // Scheduled Automation runners never use this adapter.
    const { session: inner, extensionsResult } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager,
      customTools: [
        ...createBrowserToolDefinitions(),
        ...(createAutomationToolDefinitions() as ReturnType<typeof createBrowserToolDefinitions>),
      ],
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
