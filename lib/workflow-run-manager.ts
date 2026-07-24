/**
 * SnFlow runtime: cwd-bound in-memory Pi host sessions + native pi-subagents RPC.
 * Never falls back to process.cwd() for project context.
 */

import { createHash, randomUUID } from "crypto";
import { createReadStream, existsSync, readFileSync } from "fs";
import path from "path";
import { createInterface } from "readline";
import type { EventBusController } from "@earendil-works/pi-coding-agent";
import { canonicalizeCwd } from "./cwd";
import { preparePiRuntimeEnvironment } from "./pi-runtime-resolver";
import {
  agentNameForPhase,
  buildPhasePrompt,
  normalizeCheckResult,
  normalizeImplementResult,
} from "./workflow-prompts";
import {
  beginWorkflowRun,
  findWorkflowRunById,
  getWorkflowTaskDetail,
  getWorkflowTaskDocumentsPaths,
  readWorkflowRunRecord,
  repairWorkflowTerminalProjection,
  updateWorkflowTaskProjection,
  writeWorkflowRunRecord,
  WorkflowConflictError,
  WorkflowStoreError,
} from "./workflow-store";
import {
  WORKFLOW_ACTIVE_RUN_STATES,
  WORKFLOW_TERMINAL_RUN_STATES,
  type WorkflowRunPhase,
  type WorkflowRunRecord,
  type WorkflowRunState,
  type WorkflowTaskDetail,
} from "./workflow-types";

// Local protocol constants — do not import pi-subagents package internals.
const SUBAGENT_RPC_PROTOCOL_VERSION = 1;
const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const SPAWN_RPC_TIMEOUT_MS = 60_000;
const HOST_IDLE_TTL_MS = 30 * 60_000;

/** Keep Pi's extension loader in its native ESM graph under the tsx CLI. */
async function piSdk() {
  return import("@earendil-works/pi-coding-agent");
}

export class WorkflowRuntimeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options?: { status?: number; code?: string }) {
    super(message);
    this.name = "WorkflowRuntimeError";
    this.status = options?.status ?? 500;
    this.code = options?.code ?? "runtime_error";
  }
}

interface WorkflowHost {
  cwd: string;
  hostSessionId: string;
  eventBus: EventBusController;
  session: { sessionId: string; dispose: () => void; cwd?: string };
  createdAt: number;
  lastUsedAt: number;
  rpcReady: boolean;
}

interface StartRunOptions {
  cwd: string;
  taskId: string;
  phase: WorkflowRunPhase;
  expectedRevision: string;
}

interface StartRunResult {
  task: WorkflowTaskDetail;
  run: WorkflowRunRecord;
}

interface RpcReplySuccess<T> {
  version: number;
  requestId: string;
  method?: string;
  success: true;
  data: T;
}

interface RpcReplyFailure {
  version: number;
  requestId: string;
  method?: string;
  success: false;
  error: { code: string; message: string };
}

type RpcReply<T> = RpcReplySuccess<T> | RpcReplyFailure;

declare global {
  var __piWorkflowHosts: Map<string, WorkflowHost> | undefined;
  var __piWorkflowHostLocks: Map<string, Promise<WorkflowHost>> | undefined;
  var __piWorkflowRunLocks: Map<string, Promise<unknown>> | undefined;
}

function hosts(): Map<string, WorkflowHost> {
  if (!globalThis.__piWorkflowHosts) globalThis.__piWorkflowHosts = new Map();
  return globalThis.__piWorkflowHosts;
}

function hostLocks(): Map<string, Promise<WorkflowHost>> {
  if (!globalThis.__piWorkflowHostLocks) globalThis.__piWorkflowHostLocks = new Map();
  return globalThis.__piWorkflowHostLocks;
}

function runLocks(): Map<string, Promise<unknown>> {
  if (!globalThis.__piWorkflowRunLocks) globalThis.__piWorkflowRunLocks = new Map();
  return globalThis.__piWorkflowRunLocks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalProjectCwd(cwd: string): string {
  if (!cwd || !cwd.trim()) {
    throw new WorkflowRuntimeError("Missing project cwd", { status: 400, code: "missing_cwd" });
  }
  // Explicit project cwd only — never process.cwd().
  return canonicalizeCwd(cwd);
}

export function workflowHostSessionIdForCwd(cwd: string): string {
  const canonical = canonicalProjectCwd(cwd);
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
  return `workflow-host-${digest}`;
}

function replyEventName(requestId: string): string {
  return `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;
}

async function rpcRequest<T>(
  host: WorkflowHost,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
): Promise<T> {
  const requestId = randomUUID();
  const envelope = {
    version: SUBAGENT_RPC_PROTOCOL_VERSION,
    requestId,
    method,
    params,
    source: { extension: "snail-pi-web-workflow" },
  };

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(
          new WorkflowRuntimeError(`pi-subagents RPC ${method} timed out after ${timeoutMs}ms`, {
            status: 504,
            code: "rpc_timeout",
          }),
        );
      }
    }, timeoutMs);

    const cleanupFns: Array<() => void> = [];

    const cleanup = () => {
      clearTimeout(timer);
      while (cleanupFns.length > 0) {
        const fn = cleanupFns.pop();
        try {
          fn?.();
        } catch {
          // ignore
        }
      }
    };

    const onReply = (raw: unknown) => {
      cleanup();
      if (settled) return;
      settled = true;
      if (!isRecord(raw)) {
        reject(new WorkflowRuntimeError("Invalid RPC reply envelope", { status: 502, code: "rpc_invalid_reply" }));
        return;
      }
      const reply = raw as unknown as RpcReply<T>;
      if (reply.success) {
        resolve(reply.data);
        return;
      }
      reject(
        new WorkflowRuntimeError(reply.error?.message || `RPC ${method} failed`, {
          status: 502,
          code: reply.error?.code || "rpc_error",
        }),
      );
    };

    cleanupFns.push(host.eventBus.on(replyEventName(requestId), onReply));
    try {
      host.eventBus.emit(SUBAGENT_RPC_REQUEST_EVENT, envelope);
    } catch (error) {
      cleanup();
      if (!settled) {
        settled = true;
        reject(
          new WorkflowRuntimeError(
            `Failed to emit RPC request: ${error instanceof Error ? error.message : String(error)}`,
            { status: 500, code: "rpc_emit_failed" },
          ),
        );
      }
    }
  });
}

async function createWorkflowHost(cwd: string): Promise<WorkflowHost> {
  const canonical = canonicalProjectCwd(cwd);
  const hostSessionId = workflowHostSessionIdForCwd(canonical);

  // Lazy-import Pi SDK at the async boundary so tsx/esbuild transformation
  // does not break the SDK's ESM extension loader (import.meta.resolve).
  const {
    createAgentSession,
    createEventBus,
    DefaultResourceLoader,
    getAgentDir,
    SessionManager,
    SettingsManager,
  } = await piSdk();

  const agentDir = getAgentDir();
  preparePiRuntimeEnvironment({ cwd: canonical, agentDir });

  const eventBus = createEventBus();
  const settingsManager = SettingsManager.create(canonical, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: canonical,
    agentDir,
    settingsManager,
    eventBus,
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.inMemory(canonical, { id: hostSessionId });
  const { session, extensionsResult } = await createAgentSession({
    cwd: canonical,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager,
  });

  const extensionErrors = (extensionsResult.errors ?? [])
    .map((error) => `${error.path}: ${error.error}`)
    .join("; ");

  const host: WorkflowHost = {
    cwd: canonical,
    hostSessionId: session.sessionId || hostSessionId,
    eventBus,
    session: session as WorkflowHost["session"],
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    rpcReady: false,
  };

  // Bind after subscribing: pi-subagents captures cwd/session context during session_start.
  const rpcReady = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 1500);
    const onReady = () => {
      host.rpcReady = true;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      try {
        unsub?.();
      } catch {
        // ignore
      }
    };
    const unsub = eventBus.on(SUBAGENT_RPC_READY_EVENT, onReady);
  });

  try {
    await session.bindExtensions({ mode: "print" });
    await rpcReady;
    const ping = await rpcRequest<{
      version?: number;
      session?: { cwd?: string; sessionId?: string };
      methods?: string[];
    }>(host, "ping", {}, 8_000);
    const pingCwd = ping.session?.cwd ? canonicalizeCwd(ping.session.cwd) : "";
    if (!pingCwd || pingCwd !== canonical) {
      throw new WorkflowRuntimeError(
        `pi-subagents RPC ping cwd mismatch: expected ${canonical}, got ${ping.session?.cwd ?? "(missing)"}`,
        { status: 502, code: "cwd_mismatch" },
      );
    }
    if (ping.version !== SUBAGENT_RPC_PROTOCOL_VERSION) {
      throw new WorkflowRuntimeError(
        `Unsupported pi-subagents RPC version: ${String(ping.version)}`,
        { status: 502, code: "rpc_version" },
      );
    }
    host.rpcReady = true;
  } catch (error) {
    try {
      session.dispose();
    } catch {
      // ignore
    }
    try {
      eventBus.clear?.();
    } catch {
      // ignore
    }
    const message = error instanceof Error ? error.message : String(error);
    const hint = extensionErrors
      ? `${message}. Extension load issues: ${extensionErrors}`
      : `${message}. Ensure pi-subagents is installed and discoverable for this workspace.`;
    throw new WorkflowRuntimeError(hint, {
      status: error instanceof WorkflowRuntimeError ? error.status : 503,
      code: error instanceof WorkflowRuntimeError ? error.code : "extension_missing",
    });
  }

  return host;
}

export async function getWorkflowHost(cwd: string): Promise<WorkflowHost> {
  const canonical = canonicalProjectCwd(cwd);
  const existing = hosts().get(canonical);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }

  const locks = hostLocks();
  const inflight = locks.get(canonical);
  if (inflight) return inflight;

  const creating = createWorkflowHost(canonical)
    .then((host) => {
      hosts().set(canonical, host);
      return host;
    })
    .finally(() => {
      locks.delete(canonical);
    });
  locks.set(canonical, creating);
  return creating;
}

export function disposeWorkflowHost(cwd: string): void {
  const canonical = canonicalProjectCwd(cwd);
  const host = hosts().get(canonical);
  if (!host) return;
  hosts().delete(canonical);
  try {
    host.session.dispose();
  } catch {
    // ignore
  }
  try {
    host.eventBus.clear?.();
  } catch {
    // ignore
  }
}

function pruneIdleHosts(): void {
  const now = Date.now();
  for (const [cwd, host] of hosts()) {
    if (now - host.lastUsedAt > HOST_IDLE_TTL_MS) {
      disposeWorkflowHost(cwd);
    }
  }
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (Array.isArray(value.content)) {
    return value.content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function pickNativeRefs(data: unknown): {
  nativeRunId: string | null;
  asyncDir: string | null;
  sessionFile: string | null;
  outputFile: string | null;
  model: string | null;
  thinking: string | null;
  state: WorkflowRunState | null;
  summaryText: string;
} {
  const root = isRecord(data) ? data : {};
  const details = isRecord(root.details) ? root.details : root;
  const results = Array.isArray(details.results) ? details.results : [];
  const firstResult = isRecord(results[0]) ? results[0] : null;

  const nativeRunId =
    (typeof details.runId === "string" && details.runId) ||
    (typeof root.runId === "string" && root.runId) ||
    (typeof details.id === "string" && details.id) ||
    null;

  const asyncDir =
    (typeof details.asyncDir === "string" && details.asyncDir) ||
    (typeof root.asyncDir === "string" && root.asyncDir) ||
    null;

  const sessionFile =
    (typeof details.sessionFile === "string" && details.sessionFile) ||
    (typeof root.sessionFile === "string" && root.sessionFile) ||
    null;

  const outputFile =
    (typeof details.outputFile === "string" && details.outputFile) ||
    (typeof root.outputFile === "string" && root.outputFile) ||
    null;

  const model =
    (firstResult && typeof firstResult.model === "string" && firstResult.model) ||
    (typeof details.model === "string" && details.model) ||
    null;

  const thinking =
    (firstResult && typeof firstResult.thinking === "string" && firstResult.thinking) ||
    (typeof details.thinking === "string" && details.thinking) ||
    null;

  const nativeStateRaw =
    (typeof details.state === "string" && details.state) ||
    (typeof root.state === "string" && root.state) ||
    null;

  let state: WorkflowRunState | null = null;
  if (nativeStateRaw === "running" || nativeStateRaw === "starting") state = nativeStateRaw;
  if (
    nativeStateRaw === "complete" ||
    nativeStateRaw === "completed" ||
    nativeStateRaw === "succeeded" ||
    nativeStateRaw === "success"
  ) {
    state = "completed";
  }
  if (nativeStateRaw === "failed" || nativeStateRaw === "error") state = "failed";
  if (nativeStateRaw === "cancelled" || nativeStateRaw === "canceled" || nativeStateRaw === "stopped") {
    state = "cancelled";
  }
  if (nativeStateRaw === "stopping") state = "running";

  return {
    nativeRunId,
    asyncDir,
    sessionFile,
    outputFile,
    model,
    thinking,
    state,
    summaryText: textFromUnknown(data),
  };
}

function readArtifactText(filePath: string | null | undefined, maxChars = 20_000): string {
  if (!filePath || !existsSync(filePath)) return "";
  try {
    const text = readFileSync(filePath, "utf8");
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return "";
  }
}

function readStatusJson(asyncDir: string | null | undefined): Record<string, unknown> | null {
  if (!asyncDir) return null;
  const statusPath = path.join(asyncDir, "status.json");
  if (!existsSync(statusPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statusPath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function textBlocks(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("");
}

async function readPersistedToolResult(
  sessionFile: string,
  toolCallId: string,
): Promise<{ isError: boolean; text: string; details?: unknown } | null> {
  const lines = createInterface({
    input: createReadStream(sessionFile, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let match: { isError: boolean; text: string; details?: unknown } | null = null;
  for await (const line of lines) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "toolResult" || message.toolCallId !== toolCallId) continue;
    match = {
      isError: message.isError === true,
      text: textBlocks(message.content),
      details: message.details,
    };
  }
  return match;
}

async function reconcileChatCorrelatedRun(
  cwd: string,
  run: WorkflowRunRecord,
): Promise<{ terminal?: WorkflowRunRecord; running: boolean }> {
  if (!run.parentSessionId || !run.parentToolCallId) return { running: false };

  try {
    const { resolveSessionPath } = await import("./session-reader");
    const sessionFile = await resolveSessionPath(run.parentSessionId);
    if (sessionFile && existsSync(sessionFile)) {
      const persisted = await readPersistedToolResult(sessionFile, run.parentToolCallId);
      if (persisted) {
        const { finalizeWorkflowChatRun } = await import("./workflow-chat-lifecycle");
        return {
          running: false,
          terminal: finalizeWorkflowChatRun(cwd, run, persisted),
        };
      }
    }
  } catch {
    // Live correlation and the bounded stale policy below remain available.
  }

  try {
    const { getRpcSession } = await import("./rpc-manager");
    const live = getRpcSession(run.parentSessionId);
    if (live?.isAlive() && live.isToolCallActive(run.parentToolCallId)) {
      return { running: true };
    }
  } catch {
    // Fall through to bounded stale handling.
  }

  const baseline = Date.parse(run.startedAt ?? run.createdAt);
  const ageMs = Number.isFinite(baseline) ? Date.now() - baseline : Number.POSITIVE_INFINITY;
  return { running: ageMs < 2 * 60_000 };
}

async function withCwdRunLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const canonical = canonicalProjectCwd(cwd);
  const locks = runLocks();
  const previous = locks.get(canonical) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  locks.set(
    canonical,
    tail.finally(() => {
      if (locks.get(canonical) === tail) locks.delete(canonical);
    }),
  );
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function startWorkflowRun(options: StartRunOptions): Promise<StartRunResult> {
  pruneIdleHosts();
  const canonical = canonicalProjectCwd(options.cwd);

  return withCwdRunLock(canonical, async () => {
    const host = await getWorkflowHost(canonical);
    const detail = getWorkflowTaskDetail(canonical, options.taskId);
    const paths = getWorkflowTaskDocumentsPaths(canonical, options.taskId);
    const agentName = agentNameForPhase(options.phase);

    // Persist starting run + task projection before spawn.
    const begun = beginWorkflowRun(canonical, options.taskId, {
      phase: options.phase,
      expectedRevision: options.expectedRevision,
      agentName,
      hostSessionId: host.hostSessionId,
      requestedCwd: canonical,
      effectiveCwd: canonical,
    });

    let run = begun.run;
    try {
      // Re-verify ping cwd immediately before spawn.
      const ping = await rpcRequest<{ session?: { cwd?: string } }>(host, "ping", {}, 8_000);
      const pingCwd = ping.session?.cwd ? canonicalizeCwd(ping.session.cwd) : "";
      if (pingCwd !== canonical) {
        throw new WorkflowRuntimeError(
          `pi-subagents RPC ping cwd mismatch before spawn: expected ${canonical}, got ${ping.session?.cwd ?? "(missing)"}`,
          { status: 502, code: "cwd_mismatch" },
        );
      }

      const implementSummary =
        options.phase === "check" && detail.latestImplementRunId
          ? readWorkflowRunRecord(canonical, options.taskId, detail.latestImplementRunId).summary
          : null;

      const taskPrompt = buildPhasePrompt({
        taskId: options.taskId,
        title: detail.title,
        cwd: canonical,
        pathLabels: paths.pathLabels,
        phase: options.phase,
        implementSummary,
        taskRevision: options.expectedRevision,
      });

      const spawnData = await rpcRequest<unknown>(
        host,
        "spawn",
        {
          agent: agentName,
          task: taskPrompt,
          context: "fresh",
          cwd: canonical,
          async: true,
          clarify: false,
          reads: [
            paths.pathLabels.requirements,
            paths.pathLabels.design,
            paths.pathLabels.plan,
            paths.pathLabels.taskJson,
          ],
        },
        SPAWN_RPC_TIMEOUT_MS,
      );

      const refs = pickNativeRefs(spawnData);
      run = {
        ...run,
        state: "running",
        startedAt: new Date().toISOString(),
        nativeRunId: refs.nativeRunId,
        asyncDir: refs.asyncDir,
        sessionFile: refs.sessionFile,
        outputFile: refs.outputFile,
        model: refs.model,
        thinking: refs.thinking,
        lastReconciledAt: new Date().toISOString(),
        summary: refs.summaryText || null,
      };
      writeWorkflowRunRecord(canonical, options.taskId, run);
      return {
        task: getWorkflowTaskDetail(canonical, options.taskId),
        run,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof WorkflowRuntimeError ? error.code : "spawn_failed";
      run = {
        ...run,
        state: "failed",
        endedAt: new Date().toISOString(),
        lastReconciledAt: new Date().toISOString(),
        error: { code, message },
        summary: message,
      };
      writeWorkflowRunRecord(canonical, options.taskId, run);
      updateWorkflowTaskProjection(canonical, options.taskId, (task) => ({
        ...task,
        status: "failed",
        activeRunId: null,
      }));
      throw error instanceof WorkflowRuntimeError || error instanceof WorkflowStoreError
        ? error
        : new WorkflowRuntimeError(message, { status: 502, code });
    }
  });
}

function applyTerminalProjection(
  cwd: string,
  taskId: string,
  run: WorkflowRunRecord,
): WorkflowTaskDetail {
  return repairWorkflowTerminalProjection(cwd, taskId, run);
}

export async function reconcileWorkflowRun(cwd: string, runId: string): Promise<{
  task: WorkflowTaskDetail;
  run: WorkflowRunRecord;
}> {
  const canonical = canonicalProjectCwd(cwd);
  const located = findWorkflowRunById(canonical, runId);
  let run = located.run;
  const taskId = located.taskId;

  if (WORKFLOW_TERMINAL_RUN_STATES.has(run.state)) {
    return {
      task: applyTerminalProjection(canonical, taskId, run),
      run,
    };
  }

  if (run.parentSessionId && run.parentToolCallId) {
    const chatState = await reconcileChatCorrelatedRun(canonical, run);
    if (chatState.terminal) {
      return {
        task: getWorkflowTaskDetail(canonical, taskId),
        run: chatState.terminal,
      };
    }
    if (chatState.running) {
      run = {
        ...run,
        state: "running",
        startedAt: run.startedAt ?? new Date().toISOString(),
        lastReconciledAt: new Date().toISOString(),
      };
      writeWorkflowRunRecord(canonical, taskId, run);
      return { task: getWorkflowTaskDetail(canonical, taskId), run };
    }
    run = finalizeRunRecord(
      run,
      "stale",
      "The parent chat has no live or persisted evidence for this foreground subagent run.",
    );
    writeWorkflowRunRecord(canonical, taskId, run);
    return { task: applyTerminalProjection(canonical, taskId, run), run };
  }

  // Prefer native lifecycle artifacts when available (survives host recycle).
  const statusJson = readStatusJson(run.asyncDir);
  let summaryText = readArtifactText(run.outputFile) || run.summary || "";

  if (statusJson) {
    const nativeState = typeof statusJson.state === "string" ? statusJson.state : "";
    const refs = pickNativeRefs({ ...statusJson, text: summaryText });
    if (!summaryText) summaryText = refs.summaryText;
    if (refs.nativeRunId) run = { ...run, nativeRunId: refs.nativeRunId };
    if (refs.asyncDir) run = { ...run, asyncDir: refs.asyncDir };
    if (refs.sessionFile) run = { ...run, sessionFile: refs.sessionFile };
    if (refs.outputFile) run = { ...run, outputFile: refs.outputFile };
    if (refs.model) run = { ...run, model: refs.model };
    if (refs.thinking) run = { ...run, thinking: refs.thinking };

    if (nativeState === "running" || nativeState === "starting" || nativeState === "stopping") {
      run = {
        ...run,
        state: nativeState === "starting" ? "starting" : "running",
        lastReconciledAt: new Date().toISOString(),
        summary: summaryText || run.summary,
      };
      writeWorkflowRunRecord(canonical, taskId, run);
      return { task: getWorkflowTaskDetail(canonical, taskId), run };
    }

    if (
      nativeState === "complete" ||
      nativeState === "completed" ||
      nativeState === "failed" ||
      nativeState === "cancelled" ||
      nativeState === "canceled" ||
      nativeState === "stopped" ||
      nativeState === "succeeded"
    ) {
      const mapped =
        nativeState === "complete" || nativeState === "completed" || nativeState === "succeeded"
          ? "completed"
          : nativeState === "failed"
            ? "failed"
            : "cancelled";
      run = finalizeRunRecord(run, mapped, summaryText);
      writeWorkflowRunRecord(canonical, taskId, run);
      const task = applyTerminalProjection(canonical, taskId, run);
      return { task, run };
    }
  }

  // Live RPC status when host can be obtained.
  try {
    const host = await getWorkflowHost(canonical);
    const statusData = await rpcRequest<unknown>(
      host,
      "status",
      run.nativeRunId
        ? { id: run.nativeRunId }
        : run.asyncDir
          ? { dir: run.asyncDir }
          : { id: run.id },
      12_000,
    );
    const refs = pickNativeRefs(statusData);
    summaryText = refs.summaryText || summaryText || readArtifactText(refs.outputFile);
    run = {
      ...run,
      nativeRunId: refs.nativeRunId ?? run.nativeRunId,
      asyncDir: refs.asyncDir ?? run.asyncDir,
      sessionFile: refs.sessionFile ?? run.sessionFile,
      outputFile: refs.outputFile ?? run.outputFile,
      model: refs.model ?? run.model,
      thinking: refs.thinking ?? run.thinking,
      lastReconciledAt: new Date().toISOString(),
      summary: summaryText || run.summary,
    };

    if (refs.state && WORKFLOW_TERMINAL_RUN_STATES.has(refs.state)) {
      run = finalizeRunRecord(run, refs.state, summaryText);
      writeWorkflowRunRecord(canonical, taskId, run);
      const task = applyTerminalProjection(canonical, taskId, run);
      return { task, run };
    }

    if (refs.state === "starting" || refs.state === "running") {
      run = { ...run, state: refs.state, startedAt: run.startedAt ?? new Date().toISOString() };
      writeWorkflowRunRecord(canonical, taskId, run);
      return { task: getWorkflowTaskDetail(canonical, taskId), run };
    }

    // Unknown shape while still active — keep running if we have asyncDir evidence.
    if (run.asyncDir && existsSync(run.asyncDir)) {
      run = { ...run, state: "running", lastReconciledAt: new Date().toISOString() };
      writeWorkflowRunRecord(canonical, taskId, run);
      return { task: getWorkflowTaskDetail(canonical, taskId), run };
    }

    // No evidence left: mark stale.
    run = finalizeRunRecord(run, "stale", summaryText || "Native run state could not be reconciled after status poll.");
    writeWorkflowRunRecord(canonical, taskId, run);
    const task = applyTerminalProjection(canonical, taskId, run);
    return { task, run };
  } catch (error) {
    // Host/RPC unavailable: artifact-only path already tried. Keep non-terminal if asyncDir exists.
    if (run.asyncDir && existsSync(run.asyncDir)) {
      run = {
        ...run,
        state: "running",
        lastReconciledAt: new Date().toISOString(),
        summary:
          summaryText ||
          run.summary ||
          `Status RPC unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
      writeWorkflowRunRecord(canonical, taskId, run);
      return { task: getWorkflowTaskDetail(canonical, taskId), run };
    }

    run = finalizeRunRecord(
      run,
      "stale",
      `Unable to reconcile run: ${error instanceof Error ? error.message : String(error)}`,
    );
    writeWorkflowRunRecord(canonical, taskId, run);
    const task = applyTerminalProjection(canonical, taskId, run);
    return { task, run };
  }
}

function finalizeRunRecord(
  run: WorkflowRunRecord,
  state: WorkflowRunState,
  summaryText: string,
): WorkflowRunRecord {
  const endedAt = new Date().toISOString();
  let implementResult = run.implementResult;
  let checkResult = run.checkResult;
  let error = run.error;
  let summary = summaryText || run.summary;

  if (state === "completed") {
    if (run.phase === "implement") {
      implementResult = normalizeImplementResult(summaryText) ?? implementResult;
      summary = implementResult?.summary ?? summary;
    } else {
      checkResult = normalizeCheckResult(summaryText) ?? checkResult;
      summary = checkResult?.summary ?? summary;
    }
  } else if (state === "failed" || state === "stale") {
    error = error ?? {
      code: state,
      message: summaryText || `Run ${state}`,
    };
  } else if (state === "cancelled") {
    error = error ?? { code: "cancelled", message: summaryText || "Run cancelled" };
  }

  return {
    ...run,
    state,
    summary: summary ?? null,
    implementResult,
    checkResult,
    error,
    endedAt: run.endedAt ?? endedAt,
    lastReconciledAt: endedAt,
  };
}

export async function cancelWorkflowRun(cwd: string, runId: string): Promise<{
  task: WorkflowTaskDetail;
  run: WorkflowRunRecord;
}> {
  const canonical = canonicalProjectCwd(cwd);
  const located = findWorkflowRunById(canonical, runId);
  let run = located.run;
  const taskId = located.taskId;

  if (WORKFLOW_TERMINAL_RUN_STATES.has(run.state)) {
    return { task: getWorkflowTaskDetail(canonical, taskId), run };
  }

  try {
    const host = await getWorkflowHost(canonical);
    await rpcRequest<unknown>(
      host,
      "stop",
      run.nativeRunId
        ? { id: run.nativeRunId }
        : run.asyncDir
          ? { dir: run.asyncDir }
          : { id: run.id },
      15_000,
    );
  } catch (error) {
    // If stop fails, still try to reconcile; may become cancelled/stale.
    run = {
      ...run,
      lastReconciledAt: new Date().toISOString(),
      summary:
        run.summary ||
        `Stop request error: ${error instanceof Error ? error.message : String(error)}`,
    };
    writeWorkflowRunRecord(canonical, taskId, run);
  }

  // Poll briefly for terminal state.
  for (let i = 0; i < 5; i++) {
    const reconciled = await reconcileWorkflowRun(canonical, runId);
    if (WORKFLOW_TERMINAL_RUN_STATES.has(reconciled.run.state)) {
      if (reconciled.run.state === "running" || reconciled.run.state === "starting") {
        // continue
      } else {
        // Force cancelled projection if native reports completed after stop? Prefer actual state.
        return reconciled;
      }
    }
    if (reconciled.run.state === "cancelled" || reconciled.run.state === "failed" || reconciled.run.state === "stale" || reconciled.run.state === "completed") {
      return reconciled;
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  // Force cancelled if still active after stop attempts.
  const latest = findWorkflowRunById(canonical, runId).run;
  if (WORKFLOW_ACTIVE_RUN_STATES.has(latest.state)) {
    run = finalizeRunRecord(latest, "cancelled", latest.summary || "Run cancelled by user");
    writeWorkflowRunRecord(canonical, taskId, run);
    const task = applyTerminalProjection(canonical, taskId, run);
    return { task, run };
  }
  return { task: getWorkflowTaskDetail(canonical, taskId), run: latest };
}

export async function getWorkflowRunStatus(cwd: string, runId: string): Promise<{
  task: WorkflowTaskDetail;
  run: WorkflowRunRecord;
}> {
  return reconcileWorkflowRun(cwd, runId);
}

// Re-export conflict type for routes.
export { WorkflowConflictError };
