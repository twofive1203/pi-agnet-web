/**
 * Killable Automation child-process host.
 * Loads only parent-supplied verified extension artifacts (re-checked digests),
 * runs with an explicit allowlisted env only, and seals sessions only AFTER dispose.
 *
 * Invoked via child_process.fork from automation-runner.ts against the stable
 * compiled artifact lib/automation-worker-runtime.cjs (or this .ts under tsx).
 *
 * IPC protocol:
 *   parent → child: { type: "start", job: WorkerJob }
 *   child → parent: { type: "result", result }
 *                   { type: "progress", usage?: ... }
 *                   { type: "error", message: string }
 *   parent → child: { type: "abort" }
 */

import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "fs";
import { join } from "path";
import {
  classifySessionOutcome,
  decideRequestBudget,
  estimateContextTokens,
  recordSpentTokens,
  wrapStreamFnWithTokenBudget,
  type TokenBudgetState,
} from "./automation-token-budget";

// Shared protocol types live in automation-worker-protocol (Next-safe).
export type {
  WorkerExtensionArtifact,
  WorkerJob,
  WorkerReviewedWebTool,
} from "./automation-worker-protocol";
import type {
  WorkerExtensionArtifact,
  WorkerJob,
  WorkerReviewedWebTool,
} from "./automation-worker-protocol";
import {
  deriveMaxOutputTokens,
  estimatePromptTokens,
  hashDirectoryClosure,
} from "./automation-worker-protocol";
export { deriveMaxOutputTokens, estimatePromptTokens, hashDirectoryClosure };

type WorkerResult = {
  status: "succeeded" | "failed" | "timed_out" | "cancelled" | "blocked" | "ambiguous";
  summary: string | null;
  errorCategory: string | null;
  errorMessage: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number | null;
  } | null;
  actualModel: { provider: string; modelId: string; thinking: string | null } | null;
  session: {
    sessionId: string | null;
    sessionFile: string | null;
    availability: "available" | "unavailable" | "pending";
    unavailableReason: string | null;
    /** Technical detail only; primary reason stays a declared union member. */
    unavailableDetail?: string | null;
    sealed: boolean;
    seal: { size: number; sha256: string; entryCount: number; sealedAt: string } | null;
  };
  sideEffectsStarted: boolean;
};

function findJsonl(sessionDir: string): string | null {
  try {
    const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
    if (!files.length) return null;
    files.sort();
    return join(sessionDir, files[files.length - 1]!);
  } catch {
    return null;
  }
}

function sealSessionFile(sessionFile: string | null): WorkerResult["session"]["seal"] {
  if (!sessionFile || !existsSync(sessionFile)) return null;
  try {
    const buf = readFileSync(sessionFile);
    const st = statSync(sessionFile);
    const text = buf.toString("utf8");
    return {
      size: st.size,
      sha256: createHash("sha256").update(buf).digest("hex"),
      entryCount: text.split(/\r?\n/).filter((l) => l.trim()).length,
      sealedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function extractUsage(session: {
  getSessionStats?: () => {
    tokens?: { input?: number; output?: number; total?: number };
    cost?: number;
  };
}): WorkerResult["usage"] {
  try {
    const stats = session.getSessionStats?.();
    if (stats?.tokens) {
      const input = Number(stats.tokens.input ?? 0);
      const output = Number(stats.tokens.output ?? 0);
      const total = Number(stats.tokens.total ?? input + output);
      return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: total,
        costUsd: Number(stats.cost ?? 0),
      };
    }
  } catch {
    // ignore
  }
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
}

export type VerifiedInMemoryExtension = {
  sourceIdentity: string;
  sourcePath: string;
  bundleSha256: string;
  entryRel: string;
  factory: (pi: unknown) => unknown | Promise<unknown>;
  packageClosure: string[];
};

/**
 * Verify every extension artifact from authoritative in-memory bundle bytes and
 * load factories exclusively from those bytes. Never imports mutable extracts.
 */
export function verifyAndLoadExtensionFactories(
  artifacts: WorkerExtensionArtifact[],
): { ok: true; extensions: VerifiedInMemoryExtension[] } | { ok: false; reason: string } {
  const extensions: VerifiedInMemoryExtension[] = [];
  for (const art of artifacts) {
    if (!art.bundleSha256 || !art.bundleBytesBase64) {
      return { ok: false, reason: `extension artifact missing in-memory bundle for ${art.sourceIdentity}` };
    }
    let bundleBytes: Buffer;
    try {
      bundleBytes = Buffer.from(art.bundleBytesBase64, "base64");
    } catch {
      return { ok: false, reason: `extension bundle bytes not base64 for ${art.sourceIdentity}` };
    }
    const live = createHash("sha256").update(bundleBytes).digest("hex");
    if (live !== art.bundleSha256) {
      return {
        ok: false,
        reason: `extension bundle digest mismatch for ${art.sourceIdentity}: expected ${art.bundleSha256.slice(0, 12)} got ${live.slice(0, 12)}`,
      };
    }
    // On-disk content-addressed cache is never imported. In-memory bytes already
    // verified above remain authoritative even if the cache file is later mutated.
    try {
      // Lazy import to keep worker bootstrap light and avoid circular deps at load time.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { loadFactoryFromVerifiedBundleBytes } = require("./automation-extension-runtime") as typeof import("./automation-extension-runtime");
      const loaded = loadFactoryFromVerifiedBundleBytes(bundleBytes, art.bundleSha256);
      extensions.push({
        sourceIdentity: art.sourceIdentity,
        sourcePath: art.sourcePath,
        bundleSha256: art.bundleSha256,
        entryRel: loaded.entryRel,
        factory: loaded.factory,
        packageClosure: loaded.packageClosure,
      });
    } catch (error) {
      return {
        ok: false,
        reason: `extension in-memory load failed for ${art.sourceIdentity}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { ok: true, extensions };
}

/**
 * @deprecated Prefer verifyAndLoadExtensionFactories (in-memory).
 * Kept for smoke probes that only check digest refusal.
 */
export function verifyExtensionArtifacts(
  artifacts: WorkerExtensionArtifact[],
): { ok: true; paths: string[]; extensions?: VerifiedInMemoryExtension[] } | { ok: false; reason: string } {
  const loaded = verifyAndLoadExtensionFactories(artifacts);
  if (!loaded.ok) return loaded;
  return {
    ok: true,
    paths: loaded.extensions.map((e) => `<in-memory:${e.bundleSha256.slice(0, 12)}:${e.entryRel}>`),
    extensions: loaded.extensions,
  };
}

function emptySession(
  reason: string,
  sealed = false,
): WorkerResult["session"] {
  return {
    sessionId: null,
    sessionFile: null,
    availability: "unavailable",
    unavailableReason: reason,
    sealed,
    seal: null,
  };
}

async function runJob(job: WorkerJob, signal: AbortSignal): Promise<WorkerResult> {
  // Hard reject before any model/session work if input already exhausts the ceiling.
  if (job.maxTokensPerRun > 0) {
    const bound = deriveMaxOutputTokens({
      maxTokensPerRun: job.maxTokensPerRun,
      estimatedInputTokens: job.estimatedInputTokens,
    });
    if (!bound.ok) {
      return {
        status: "failed",
        summary: null,
        errorCategory: "budget",
        errorMessage: bound.reason,
        usage: {
          inputTokens: job.estimatedInputTokens,
          outputTokens: 0,
          totalTokens: job.estimatedInputTokens,
          costUsd: 0,
        },
        actualModel: null,
        session: emptySession("budget_preflight"),
        sideEffectsStarted: false,
      };
    }
  }

  // FINAL in-memory verify+factory load BEFORE any resourceLoader.reload / import.
  const verified = verifyAndLoadExtensionFactories(job.extensionArtifacts ?? []);
  if (!verified.ok) {
    return {
      status: "blocked",
      summary: null,
      errorCategory: "preflight",
      errorMessage: verified.reason,
      usage: null,
      actualModel: null,
      session: emptySession("extension_digest_mismatch"),
      sideEffectsStarted: false,
    };
  }

  type SessionHandle = {
    sessionId?: string;
    sessionFile?: string;
    abort?: () => void;
    getSessionStats?: () => {
      tokens?: { input?: number; output?: number; total?: number };
      cost?: number;
    };
    agent?: {
      state?: {
        errorMessage?: string | null;
        messages?: Array<{ role?: string; stopReason?: string; errorMessage?: string | null }>;
        systemPrompt?: string;
        tools?: unknown[];
      };
      streamFunction?: (model: unknown, context: unknown, opts?: Record<string, unknown>) => unknown;
      ui?: unknown;
    };
    model?: { id?: string; provider?: string; maxTokens?: number } | null;
    thinkingLevel?: string;
    prompt?: (text: string) => Promise<unknown>;
    setModel?: (model: unknown) => Promise<void>;
    setThinkingLevel?: (level: string) => void | Promise<void>;
    modelRuntime?: { getModel?: (p: string, m: string) => unknown };
    bindExtensions?: (opts: unknown) => void | Promise<void>;
    ui?: { confirm?: unknown; select?: unknown; input?: unknown; editor?: unknown };
  };
  let sessionObj: unknown = null;
  let sessionHandle: SessionHandle | null = null;
  let sideEffectsStarted = false;
  let disposalConfirmed = false;
  let appliedModel: WorkerResult["actualModel"] = null;
  const budgetState: TokenBudgetState = {
    maxTokensPerRun: job.maxTokensPerRun,
    spentTokens: 0,
    reservedTokens: 0,
  };

  const disposeThenSeal = async (
    reason: string,
  ): Promise<WorkerResult["session"]> => {
    let disposeOk = false;
    try {
      if (sessionObj) {
        const { disposeAgentSession } = await import("./pi-session-lifecycle");
        await disposeAgentSession(sessionObj as never, "quit");
        disposeOk = true;
      } else {
        disposeOk = true;
      }
    } catch {
      disposeOk = false;
    }
    // Drain so filesystem flushes settle before seal.
    await new Promise((r) => setTimeout(r, 50));
    disposalConfirmed = disposeOk;
    const sessionFile = sessionHandle?.sessionFile ?? findJsonl(job.sessionDir);
    if (!disposeOk) {
      // Cleanup uncertain → do NOT claim sealed.
      // Keep unavailableReason in the declared union; put cause in unavailableDetail.
      return {
        sessionId: sessionHandle?.sessionId ?? null,
        sessionFile,
        availability: sessionFile && existsSync(sessionFile) ? "available" : "unavailable",
        unavailableReason: "dispose_unconfirmed",
        unavailableDetail: reason || null,
        sealed: false,
        seal: null,
      };
    }
    const seal = sealSessionFile(sessionFile);
    return {
      sessionId: sessionHandle?.sessionId ?? null,
      sessionFile,
      availability: sessionFile && existsSync(sessionFile) ? "available" : "unavailable",
      unavailableReason: sessionFile ? null : "no_session_file",
      sealed: Boolean(seal),
      seal,
    };
  };

  try {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const agentDir = job.agentDir || sdk.getAgentDir();
    const settingsManager = sdk.SettingsManager.create(job.cwd, agentDir);

    // Re-load factories from the same in-memory verified bytes immediately before loader construction.
    const verifiedAgain = verifyAndLoadExtensionFactories(job.extensionArtifacts ?? []);
    if (!verifiedAgain.ok) {
      return {
        status: "blocked",
        summary: null,
        errorCategory: "preflight",
        errorMessage: verifiedAgain.reason,
        usage: null,
        actualModel: null,
        session: emptySession("extension_digest_mismatch"),
        sideEffectsStarted: false,
      };
    }

    const extensionFactories = verifiedAgain.extensions.map((ext, index) => ({
      name: `automation-verified-${index}-${ext.bundleSha256.slice(0, 12)}`,
      factory: ext.factory as never,
    }));

    // No filesystem extension paths: factories come only from verified in-memory bytes.
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: job.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: [],
      extensionFactories: extensionFactories as never,
      extensionsOverride: ((base: { extensions?: Array<{ path?: string }> }) => {
        const exts = (base.extensions ?? []).filter((e) => {
          const p = e.path ?? "";
          return p.startsWith("<inline:") || p.includes("automation-verified-");
        });
        return { ...base, extensions: exts };
      }) as never,
    });

    await resourceLoader.reload();
    sideEffectsStarted = true;

    const loaded = resourceLoader.getExtensions?.() as
      | { extensions?: Array<{ path?: string }> }
      | undefined;
    for (const ext of loaded?.extensions ?? []) {
      const p = ext.path ?? "";
      if (!(p.startsWith("<inline:") || p.includes("automation-verified-"))) {
        throw new Error(`Unapproved extension loaded in worker: ${ext.path}`);
      }
    }
    mkdirSync(job.sessionDir, { recursive: true });
    const sessionManager = sdk.SessionManager.create(job.cwd, job.sessionDir);

    // Reviewed web tools: pass exact shared registry digests — never dummy "worker" hashes.
    let customTools: unknown[] | undefined;
    const reviewedSnaps: WorkerReviewedWebTool[] =
      job.reviewedWebTools && job.reviewedWebTools.length
        ? job.reviewedWebTools
        : (job.reviewedWebToolNames ?? []).map((name) => {
            // Legacy fallback rebuilds from live registry (still exact, not dummy).
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { buildReviewedWebToolSnapshot } = require("./automation-reviewed-web-tools") as typeof import("./automation-reviewed-web-tools");
            if (name !== "web_search" && name !== "web_fetch") {
              throw new Error(`Unsupported reviewed web tool name: ${name}`);
            }
            const snap = buildReviewedWebToolSnapshot(name);
            return {
              name: snap.name,
              origin: "custom" as const,
              sourceIdentity: snap.sourceIdentity,
              executableDigest: snap.executableDigest,
              schemaHash: snap.schemaHash,
              configHash: snap.configHash,
              description: snap.description,
              risks: snap.risks,
            };
          });

    if (reviewedSnaps.length) {
      const { createAutomationReviewedWebTools } = await import("./automation-reviewed-web-tools");
      customTools = createAutomationReviewedWebTools(
        reviewedSnaps.map((t) => ({
          name: t.name,
          origin: "custom" as const,
          sourceIdentity: t.sourceIdentity,
          executableDigest: t.executableDigest,
          schemaHash: t.schemaHash,
          configHash: t.configHash,
          description: t.description,
          hookInventory: [],
          risks: t.risks ?? {
            headlessCompatible: true,
            localMutation: false,
            networkEgress: true,
            credentialUse: false,
            interactionRequired: false,
            blocked: false,
          },
        })),
      );
      // Never silently drop requested reviewed authority.
      if (customTools.length !== reviewedSnaps.length) {
        const got = new Set(customTools.map((t) => (t as { name: string }).name));
        const missing = reviewedSnaps.filter((t) => !got.has(t.name)).map((t) => t.name);
        throw Object.assign(
          new Error(
            `Reviewed web tools failed exact registry match (refusing silent drop): ${missing.join(", ")}`,
          ),
          { code: "blocked", blockedReason: "reauthorization_required" },
        );
      }
    }

    const { createAgentSessionWithServices } = await import("./agent-session-services");
    const { session } = await createAgentSessionWithServices({
      cwd: job.cwd,
      agentDir,
      sessionManager,
      resourceLoader,
      tools: job.toolNames.length ? job.toolNames : [],
      customTools: customTools?.length ? customTools : undefined,
      settingsManager,
    });
    sessionObj = session;
    sessionHandle = session as unknown as SessionHandle;

    // Bind extensions using SDK uiContext contract for print/headless UI.
    const blockUi = () => {
      throw Object.assign(new Error("Headless automation cannot satisfy interactive UI request"), {
        code: "blocked",
        blockedReason: "interaction_required",
      });
    };
    const headlessUi = {
      mode: "print" as const,
      confirm: blockUi,
      select: blockUi,
      input: blockUi,
      editor: blockUi,
      notify: () => undefined,
    };
    // Headless binding is mandatory when bindExtensions exists: failure blocks the run
    // (never fail-open). Missing bindExtensions is only OK when we can still install
    // blocking UI handlers on a public ui surface.
    let headlessBound = false;
    if (typeof sessionHandle?.bindExtensions === "function") {
      try {
        await sessionHandle.bindExtensions({ uiContext: headlessUi, mode: "print" });
        headlessBound = true;
      } catch (bindErr) {
        // Fail closed: dispose and block — do not continue without proven headless UI.
        const sessionMeta = await disposeThenSeal("bind_extensions_failed");
        return {
          status: "blocked",
          summary: null,
          errorCategory: "interaction_required",
          errorMessage: `bindExtensions/uiContext failed: ${bindErr instanceof Error ? bindErr.message : String(bindErr)}`,
          usage: null,
          actualModel: appliedModel,
          session: sessionMeta,
          sideEffectsStarted: true,
        };
      }
    }
    if (sessionHandle?.ui) {
      sessionHandle.ui.confirm = blockUi;
      sessionHandle.ui.select = blockUi;
      sessionHandle.ui.input = blockUi;
      sessionHandle.ui.editor = blockUi;
      headlessBound = true;
    }
    if (sessionHandle?.agent && typeof sessionHandle.agent === "object") {
      try {
        (sessionHandle.agent as { ui?: unknown }).ui = headlessUi;
        headlessBound = true;
      } catch {
        // ignore assignment failure; checked below
      }
    }
    if (!headlessBound) {
      const sessionMeta = await disposeThenSeal("headless_ui_unbound");
      return {
        status: "blocked",
        summary: null,
        errorCategory: "interaction_required",
        errorMessage: "Headless UI binding unavailable (no bindExtensions/ui surface)",
        usage: null,
        actualModel: appliedModel,
        session: sessionMeta,
        sideEffectsStarted: true,
      };
    }

    appliedModel = {
      provider: job.model.provider,
      modelId: job.model.modelId,
      thinking: job.model.thinking ?? null,
    };

    try {
      const model = sessionHandle?.modelRuntime?.getModel?.(job.model.provider, job.model.modelId);
      if (model && typeof sessionHandle?.setModel === "function") {
        if (job.maxOutputTokens > 0 && model && typeof model === "object") {
          const m = model as {
            maxTokens?: number;
            request?: { max_tokens?: number; maxTokens?: number };
          };
          const cap = job.maxOutputTokens;
          if (typeof m.maxTokens === "number") {
            m.maxTokens = Math.min(m.maxTokens, cap);
          } else {
            m.maxTokens = cap;
          }
          if (m.request && typeof m.request === "object") {
            if (typeof m.request.max_tokens === "number") {
              m.request.max_tokens = Math.min(m.request.max_tokens, cap);
            } else {
              m.request.max_tokens = cap;
            }
            if (typeof m.request.maxTokens === "number") {
              m.request.maxTokens = Math.min(m.request.maxTokens, cap);
            }
          }
        }
        await sessionHandle.setModel(model);
      }
      if (job.model.thinking && typeof sessionHandle?.setThinkingLevel === "function") {
        await sessionHandle.setThinkingLevel(job.model.thinking);
      }
      appliedModel = {
        provider: sessionHandle?.model?.provider ?? appliedModel.provider,
        modelId: sessionHandle?.model?.id ?? appliedModel.modelId,
        thinking: (sessionHandle?.thinkingLevel as string | undefined) ?? appliedModel.thinking,
      };
    } catch (error) {
      throw new Error(
        `Failed to apply model: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Hard total-token budget: intercept each model request at streamFn boundary.
    if (sessionHandle?.agent && typeof sessionHandle.agent === "object") {
      const agent = sessionHandle.agent as {
        streamFunction?: (model: unknown, context: unknown, opts?: Record<string, unknown>) => unknown;
        state?: { messages?: unknown[]; systemPrompt?: string; tools?: unknown[] };
      };
      if (typeof agent.streamFunction === "function") {
        const base = agent.streamFunction.bind(agent) as (
          model: unknown,
          context: unknown,
          opts?: Record<string, unknown>,
        ) => unknown;
        agent.streamFunction = wrapStreamFnWithTokenBudget(base, budgetState, {
          onReject: (reason) => {
            try {
              sessionHandle?.abort?.();
            } catch {
              // ignore
            }
            if (typeof process.send === "function") {
              process.send({ type: "progress", budgetExceeded: true, reason });
            }
          },
        });
      }
    }

    let budgetAborted = false;
    const tokenMonitor = setInterval(() => {
      if (budgetAborted || signal.aborted) return;
      try {
        const usage = extractUsage(sessionHandle ?? {});
        recordSpentTokens(budgetState, usage);
        const total = usage?.totalTokens ?? 0;
        if (job.maxTokensPerRun > 0 && total > job.maxTokensPerRun) {
          budgetAborted = true;
          try {
            sessionHandle?.abort?.();
          } catch {
            // ignore
          }
          if (typeof process.send === "function") {
            process.send({ type: "progress", usage, budgetExceeded: true });
          }
        } else if (usage && typeof process.send === "function") {
          process.send({ type: "progress", usage });
        }
      } catch {
        // ignore
      }
    }, 250);
    tokenMonitor.unref?.();

    const onAbort = () => {
      try {
        sessionHandle?.abort?.();
      } catch {
        // ignore
      }
    };
    signal.addEventListener("abort", onAbort);

    try {
      if (signal.aborted) {
        return {
          status: "cancelled",
          summary: null,
          errorCategory: "cancelled",
          errorMessage: "Cancelled before prompt",
          usage: extractUsage(sessionHandle ?? {}),
          actualModel: appliedModel,
          session: await disposeThenSeal("cancelled_before_prompt"),
          sideEffectsStarted: true,
        };
      }

      // Pre-prompt budget check including real system/tool overhead once session exists.
      if (job.maxTokensPerRun > 0 && sessionHandle?.agent) {
        const st = (sessionHandle.agent as { state?: { systemPrompt?: string; tools?: unknown[]; messages?: unknown[] } }).state;
        const estimated = estimateContextTokens({
          systemPrompt: st?.systemPrompt,
          tools: st?.tools as Array<{ name?: string; description?: string; parameters?: unknown }>,
          messages: st?.messages,
          extraText: job.prompt,
        });
        const decision = decideRequestBudget({
          maxTokensPerRun: job.maxTokensPerRun,
          spentTokens: budgetState.spentTokens,
          estimatedInputTokens: estimated,
        });
        if (!decision.ok) {
          return {
            status: "failed",
            summary: null,
            errorCategory: "budget",
            errorMessage: decision.reason,
            usage: {
              inputTokens: estimated,
              outputTokens: 0,
              totalTokens: estimated,
              costUsd: 0,
            },
            actualModel: appliedModel,
            session: await disposeThenSeal("budget_pre_prompt"),
            sideEffectsStarted: true,
          };
        }
      }

      if (typeof sessionHandle?.prompt !== "function") {
        throw new Error("Session missing prompt()");
      }
      const promptResult = await sessionHandle.prompt(job.prompt);
      const usage = extractUsage(sessionHandle);
      recordSpentTokens(budgetState, usage);

      const total = usage?.totalTokens ?? 0;
      const overBudget =
        budgetAborted || (job.maxTokensPerRun > 0 && total > job.maxTokensPerRun);
      const overOutput =
        job.maxOutputTokens > 0 && (usage?.outputTokens ?? 0) > job.maxOutputTokens + 64;

      if (overBudget || overOutput) {
        return {
          status: "failed",
          summary: null,
          errorCategory: "budget",
          errorMessage: overOutput
            ? `Output tokens exceeded hard maxOutputTokens=${job.maxOutputTokens}`
            : `Exceeded maxTokensPerRun=${job.maxTokensPerRun}`,
          usage,
          actualModel: appliedModel,
          session: await disposeThenSeal("budget"),
          sideEffectsStarted: true,
        };
      }

      if (signal.aborted) {
        return {
          status: "cancelled",
          summary: null,
          errorCategory: "cancelled",
          errorMessage: "Cancelled",
          usage,
          actualModel: appliedModel,
          session: await disposeThenSeal("cancelled"),
          sideEffectsStarted: true,
        };
      }

      // Inspect AgentSession state/messages/stop reason — provider/auth failure is failed, not success.
      const outcome = classifySessionOutcome(
        {
          agent: sessionHandle?.agent as {
            state?: {
              errorMessage?: string | null;
              messages?: Array<{ role?: string; stopReason?: string; errorMessage?: string | null }>;
            };
          },
        },
        { promptResolved: true },
      );
      if (!outcome.ok) {
        return {
          status: outcome.status,
          summary: null,
          errorCategory: outcome.errorCategory,
          errorMessage: outcome.errorMessage,
          usage,
          actualModel: appliedModel,
          session: await disposeThenSeal(outcome.errorCategory ?? "provider"),
          sideEffectsStarted: true,
        };
      }

      return {
        status: "succeeded",
        summary:
          typeof promptResult === "string" ? promptResult.slice(0, 500) : "Automation completed",
        errorCategory: null,
        errorMessage: null,
        usage,
        actualModel: appliedModel,
        session: await disposeThenSeal("success"),
        sideEffectsStarted: true,
      };
    } finally {
      clearInterval(tokenMonitor);
      signal.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string; errorCategory?: string; blockedReason?: string })?.code;
    const errorCategory =
      code === "budget" || (error as { errorCategory?: string })?.errorCategory === "budget"
        ? "budget"
        : code === "blocked" || (error as { blockedReason?: string })?.blockedReason
          ? "preflight"
          : "runner";
    const status =
      errorCategory === "budget"
        ? ("failed" as const)
        : errorCategory === "preflight"
          ? ("blocked" as const)
          : ("failed" as const);

    // Always dispose/seal (or surface unsealed) on exception paths.
    let sessionResult: WorkerResult["session"];
    if (sessionObj || sessionHandle) {
      sessionResult = await disposeThenSeal(errorCategory);
    } else {
      sessionResult = emptySession(errorCategory);
    }
    if (!disposalConfirmed && (sessionObj || sessionHandle)) {
      sessionResult = {
        ...sessionResult,
        sealed: false,
        seal: null,
        unavailableReason: sessionResult.unavailableReason ?? "dispose_unconfirmed",
      };
    }
    return {
      status,
      summary: null,
      errorCategory,
      errorMessage: msg,
      usage: sessionHandle ? extractUsage(sessionHandle) : null,
      actualModel: appliedModel,
      session: sessionResult,
      sideEffectsStarted,
    };
  }
}

// --- child entrypoint ---
const isWorkerEntrypoint =
  typeof process.send === "function" &&
  Boolean(process.argv[1]) &&
  /automation-worker-(host|runtime)/.test(String(process.argv[1]).replace(/\\/g, "/"));

if (isWorkerEntrypoint) {
  // Fail closed if ambient injection env slipped past the parent allowlist.
  for (const banned of ["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS"]) {
    if (process.env[banned]) {
      process.send?.({
        type: "error",
        message: `Worker refused ambient injection env: ${banned}`,
      });
      process.exit(2);
    }
  }

  const ac = new AbortController();
  process.on("message", (msg: unknown) => {
    const m = msg as { type?: string; job?: WorkerJob };
    if (m?.type === "abort") {
      ac.abort();
      return;
    }
    if (m?.type === "start" && m.job) {
      void runJob(m.job, ac.signal)
        .then((result) => {
          process.send?.({ type: "result", result });
          setTimeout(() => process.exit(0), 50);
        })
        .catch((error) => {
          // Outer catch: still try to report; runJob itself is try/finally-safe.
          process.send?.({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          setTimeout(() => process.exit(1), 50);
        });
    }
  });
  process.send?.({ type: "ready" });
}

export { runJob };
