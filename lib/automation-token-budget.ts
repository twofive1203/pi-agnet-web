/**
 * Hard total-token budget for Automation runs.
 * Intercepts each model request at the streamFn boundary so multi-turn tool loops
 * cannot reset the allowance, and input already over budget is rejected before spend.
 *
 * Guarantees:
 * - Conservative UTF-8-byte upper bound for CJK/token-dense input
 * - Atomic reserve of full-input bound + per-request output allowance BEFORE dispatch
 * - Immediate usage reconciliation from AssistantMessageEventStream done/error events
 * - Two concurrent/rapid requests cannot over-reserve past maxTokensPerRun
 */

/** UTF-8 byte length (safe upper bound basis for CJK / dense scripts). */
export function utf8ByteLength(text: string | null | undefined): number {
  if (!text) return 0;
  return Buffer.byteLength(text, "utf8");
}

/**
 * Conservative worst-case input token bound.
 * Uses UTF-8 byte count as a hard upper bound (byte-level tokenizers can
 * approach one token per byte). Never under-estimates CJK/dense scripts.
 */
export function estimateTextTokens(text: string | null | undefined): number {
  if (!text) return 0;
  // Worst-case: one token per UTF-8 byte (+1 floor for non-empty).
  return Math.max(utf8ByteLength(text), 1);
}

/** Bound system prompt + tool schemas + current context messages/input. */
export function estimateContextTokens(input: {
  systemPrompt?: string | null;
  tools?: Array<{ name?: string; description?: string; parameters?: unknown }> | null;
  messages?: Array<unknown> | null;
  extraText?: string | null;
}): number {
  let total = 0;
  total += estimateTextTokens(input.systemPrompt ?? "");
  // Fixed system/runtime overhead (role markers, formatting, provider framing).
  total += 384;
  if (input.tools?.length) {
    for (const tool of input.tools) {
      total += estimateTextTokens(tool.name ?? "");
      total += estimateTextTokens(tool.description ?? "");
      try {
        total += estimateTextTokens(JSON.stringify(tool.parameters ?? {}));
      } catch {
        total += 64;
      }
      // Per-tool framing overhead.
      total += 48;
    }
  }
  if (input.messages?.length) {
    for (const msg of input.messages) {
      try {
        // Serialize real message objects (content/role/tool results) for a true upper bound.
        total += estimateTextTokens(stableSerialize(msg));
      } catch {
        total += 128;
      }
    }
  }
  total += estimateTextTokens(input.extraText ?? "");
  return total;
}

function stableSerialize(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${k}:${stableSerialize(obj[k])}`).join(",")}}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export type TokenBudgetState = {
  maxTokensPerRun: number;
  /** Tokens already consumed by prior completed model turns (input+output). */
  spentTokens: number;
  /** Tokens atomically reserved for in-flight requests (input bound + output allowance). */
  reservedTokens?: number;
};

export type RequestBudgetDecision =
  | {
      ok: true;
      maxOutputTokens: number;
      remaining: number;
      estimatedInputTokens: number;
      reservation: number;
    }
  | { ok: false; reason: string; remaining: number; estimatedInputTokens: number };

/**
 * Decide whether a new model request is allowed under the hard total ceiling.
 * remaining = max - spent - reserved - estimatedInput - safetyMargin.
 * maxOutput for THIS request is clamped to remaining (no multi-request reset).
 * Caller MUST call reserveRequestBudget atomically before dispatch when ok.
 */
export function decideRequestBudget(input: {
  maxTokensPerRun: number;
  spentTokens: number;
  estimatedInputTokens: number;
  reservedTokens?: number;
  safetyMargin?: number;
}): RequestBudgetDecision {
  const margin = input.safetyMargin ?? 64;
  const max = Math.max(0, input.maxTokensPerRun);
  if (max <= 0) {
    return {
      ok: true,
      maxOutputTokens: 0,
      remaining: 0,
      estimatedInputTokens: input.estimatedInputTokens,
      reservation: 0,
    };
  }
  const spent = Math.max(0, input.spentTokens);
  const reserved = Math.max(0, input.reservedTokens ?? 0);
  const remainingAfterCommitted = max - spent - reserved;
  if (remainingAfterCommitted <= margin) {
    return {
      ok: false,
      reason: `Token budget exhausted: spent=${spent} reserved=${reserved} maxTokensPerRun=${max}`,
      remaining: Math.max(0, remainingAfterCommitted),
      estimatedInputTokens: input.estimatedInputTokens,
    };
  }
  const estimatedInput = Math.max(0, input.estimatedInputTokens);
  if (estimatedInput + margin >= remainingAfterCommitted) {
    return {
      ok: false,
      reason: `Estimated input tokens (${estimatedInput}) plus safety margin (${margin}) exhaust remaining budget (${remainingAfterCommitted}) under maxTokensPerRun=${max} (spent=${spent} reserved=${reserved})`,
      remaining: remainingAfterCommitted,
      estimatedInputTokens: estimatedInput,
    };
  }
  const remaining = remainingAfterCommitted - estimatedInput - margin;
  const maxOutputTokens = Math.max(1, remaining);
  // Full conservative reservation = input bound + entire output allowance for this request.
  const reservation = estimatedInput + maxOutputTokens + margin;
  return {
    ok: true,
    maxOutputTokens,
    remaining,
    estimatedInputTokens: estimatedInput,
    reservation,
  };
}

/**
 * Atomically reserve tokens on state. Returns false if concurrent reservation raced.
 */
export function tryReserveRequestBudget(
  state: TokenBudgetState,
  reservation: number,
): boolean {
  if (reservation <= 0) return true;
  const max = Math.max(0, state.maxTokensPerRun);
  if (max <= 0) return true;
  const available = max - Math.max(0, state.spentTokens) - Math.max(0, state.reservedTokens ?? 0);
  if (reservation > available) return false;
  state.reservedTokens = Math.max(0, state.reservedTokens ?? 0) + reservation;
  return true;
}

/**
 * Release a prior reservation and optionally record actual usage into spentTokens.
 * actualUsage replaces the reservation (never double-counts).
 */
export function settleRequestBudget(
  state: TokenBudgetState,
  reservation: number,
  actualUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null,
): void {
  if (reservation > 0) {
    state.reservedTokens = Math.max(0, (state.reservedTokens ?? 0) - reservation);
  }
  const max = Math.max(0, state.maxTokensPerRun);
  if (actualUsage) {
    const total =
      typeof actualUsage.totalTokens === "number" && Number.isFinite(actualUsage.totalTokens)
        ? actualUsage.totalTokens
        : Math.max(0, Number(actualUsage.inputTokens ?? 0)) +
          Math.max(0, Number(actualUsage.outputTokens ?? 0));
    // Replace reservation with actual usage (incremental). Conservative pre-reserve
    // guarantees actual should fit; if a provider still overruns, pin spent past max
    // so the next request fails closed.
    if (total > 0) {
      state.spentTokens = Math.max(0, state.spentTokens) + total;
    }
    if (max > 0 && state.spentTokens > max) {
      state.spentTokens = Math.max(state.spentTokens, max + 1);
    }
  } else if (reservation > 0) {
    // No usage observed — keep the conservative reservation as spent so budget cannot reopen.
    state.spentTokens = Math.max(0, state.spentTokens) + reservation;
    if (max > 0 && state.spentTokens > max) {
      state.spentTokens = Math.max(state.spentTokens, max + 1);
    }
  }
}

/**
 * Wrap an SDK StreamFn so each model request is budget-checked and maxTokens-capped.
 * Throws on budget exhaustion BEFORE the underlying provider call.
 * Atomically reserves input+output allowance; reconciles from stream usage events immediately.
 */
export type AnyStreamFn = (
  model: unknown,
  context: unknown,
  options?: Record<string, unknown>,
) => unknown;

export function wrapStreamFnWithTokenBudget(
  base: AnyStreamFn,
  state: TokenBudgetState,
  options?: {
    onReject?: (reason: string) => void;
    /** Optional usage extractor from stream final message (best-effort). */
    onUsage?: (usage: { inputTokens: number; outputTokens: number; totalTokens: number }) => void;
  },
): AnyStreamFn {
  if (state.reservedTokens == null || !Number.isFinite(state.reservedTokens)) {
    state.reservedTokens = 0;
  }

  const wrapped: AnyStreamFn = (model, context, streamOpts) => {
    const ctx = (context ?? {}) as {
      systemPrompt?: string;
      messages?: unknown[];
      tools?: Array<{ name?: string; description?: string; parameters?: unknown }>;
    };
    const estimatedInput = estimateContextTokens({
      systemPrompt: ctx.systemPrompt,
      tools: ctx.tools,
      messages: ctx.messages,
    });
    const decision = decideRequestBudget({
      maxTokensPerRun: state.maxTokensPerRun,
      spentTokens: state.spentTokens,
      reservedTokens: state.reservedTokens,
      estimatedInputTokens: estimatedInput,
    });
    if (!decision.ok) {
      options?.onReject?.(decision.reason);
      const err = Object.assign(new Error(decision.reason), {
        code: "budget",
        errorCategory: "budget",
      });
      throw err;
    }

    // Atomic reserve BEFORE provider dispatch so rapid/concurrent calls cannot over-reserve.
    const reservation = decision.reservation;
    if (!tryReserveRequestBudget(state, reservation)) {
      const reason = `Token budget reservation race: could not reserve ${reservation} under maxTokensPerRun=${state.maxTokensPerRun} (spent=${state.spentTokens} reserved=${state.reservedTokens})`;
      options?.onReject?.(reason);
      throw Object.assign(new Error(reason), { code: "budget", errorCategory: "budget" });
    }

    const nextOpts: Record<string, unknown> = { ...(streamOpts ?? {}) };
    const prevMax =
      typeof nextOpts.maxTokens === "number" && Number.isFinite(nextOpts.maxTokens)
        ? (nextOpts.maxTokens as number)
        : decision.maxOutputTokens;
    nextOpts.maxTokens = Math.min(prevMax, decision.maxOutputTokens);

    // Also clamp model.maxTokens so providers that read the model object still honor the ceiling.
    if (model && typeof model === "object") {
      const m = model as { maxTokens?: number };
      if (typeof m.maxTokens === "number") {
        m.maxTokens = Math.min(m.maxTokens, decision.maxOutputTokens);
      } else {
        m.maxTokens = decision.maxOutputTokens;
      }
    }

    let settled = false;
    const settle = (
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null,
    ) => {
      if (settled) return;
      settled = true;
      settleRequestBudget(state, reservation, usage);
      if (usage && options?.onUsage) {
        const inputTokens = Math.max(0, Number(usage.inputTokens ?? 0));
        const outputTokens = Math.max(0, Number(usage.outputTokens ?? 0));
        const totalTokens =
          typeof usage.totalTokens === "number"
            ? usage.totalTokens
            : inputTokens + outputTokens;
        options.onUsage({ inputTokens, outputTokens, totalTokens });
      }
    };

    try {
      const result = base(model, context, nextOpts);
      return wrapStreamResultWithUsageAccounting(result, settle);
    } catch (err) {
      settle(null);
      throw err;
    }
  };
  return wrapped;
}

/**
 * Wrap AssistantMessageEventStream (or thenable/async-iterable) so usage is
 * accounted immediately on done/error events, not only via 250ms polling.
 */
export function wrapStreamResultWithUsageAccounting(
  result: unknown,
  settle: (
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null,
  ) => void,
): unknown {
  if (result == null) {
    settle(null);
    return result;
  }

  // Promise-like
  if (typeof (result as { then?: unknown }).then === "function") {
    return (result as Promise<unknown>).then(
      (v) => {
        const usage = extractUsageFromUnknown(v);
        settle(usage);
        return v;
      },
      (err) => {
        settle(null);
        throw err;
      },
    );
  }

  const stream = result as {
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
    result?: () => Promise<unknown>;
    push?: (event: unknown) => void;
    end?: (r?: unknown) => void;
  };

  // Prefer patching result() when present (AssistantMessageEventStream).
  if (typeof stream.result === "function") {
    const origResult = stream.result.bind(stream);
    stream.result = async () => {
      try {
        const msg = await origResult();
        settle(extractUsageFromUnknown(msg));
        return msg;
      } catch (err) {
        settle(null);
        throw err;
      }
    };
  }

  // Also wrap async iterator so consumers that only iterate still settle promptly.
  if (typeof stream[Symbol.asyncIterator] === "function") {
    const origAsyncFn = stream[Symbol.asyncIterator]!;
    const origAsync = origAsyncFn.bind(stream) as () => AsyncIterator<unknown>;
    (stream as { [Symbol.asyncIterator]: () => AsyncIterator<unknown> })[Symbol.asyncIterator] =
      function patchedAsyncIterator() {
        const it = origAsync();
        return {
          async next() {
            const n = await it.next();
            if (!n.done) {
              const ev = n.value as {
                type?: string;
                message?: unknown;
                error?: unknown;
                partial?: unknown;
              };
              if (ev && (ev.type === "done" || ev.type === "error")) {
                const msg = ev.type === "done" ? ev.message : ev.error;
                settle(extractUsageFromUnknown(msg ?? ev.partial));
              }
            } else {
              // Iterator exhausted without done event — settle conservatively.
              settle(null);
            }
            return n;
          },
          async return(value?: unknown) {
            settle(null);
            if (it.return) return it.return(value);
            return { done: true as const, value: undefined };
          },
          async throw(e?: unknown) {
            settle(null);
            if (it.throw) return it.throw(e);
            throw e;
          },
        };
      };
    return stream;
  }

  // Plain object with usage
  const direct = extractUsageFromUnknown(result);
  if (direct) settle(direct);
  else settle(null);
  return result;
}

function extractUsageFromUnknown(
  value: unknown,
): { inputTokens: number; outputTokens: number; totalTokens: number } | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as {
    usage?: {
      input?: number;
      output?: number;
      totalTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
    };
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  const u = obj.usage ?? obj;
  if (!u || typeof u !== "object") return null;
  const inputTokens = Math.max(
    0,
    Number((u as { input?: number }).input ?? (u as { inputTokens?: number }).inputTokens ?? 0),
  );
  const outputTokens = Math.max(
    0,
    Number((u as { output?: number }).output ?? (u as { outputTokens?: number }).outputTokens ?? 0),
  );
  const totalTokens = Math.max(
    0,
    Number((u as { totalTokens?: number }).totalTokens ?? inputTokens + outputTokens),
  );
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) {
    // All-zero may still be a valid empty usage — treat as observed zero (not missing).
    if ("usage" in obj || "totalTokens" in u || "input" in u || "output" in u) {
      return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    }
    return null;
  }
  return { inputTokens, outputTokens, totalTokens };
}

/**
 * After a model turn, add observed cumulative session usage into spentTokens.
 * Prefer stream-event settle for per-request accounting; this is a floor for session stats.
 */
export function recordSpentTokens(
  state: TokenBudgetState,
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null | undefined,
): void {
  if (!usage) return;
  const total =
    typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)
      ? usage.totalTokens
      : Math.max(0, Number(usage.inputTokens ?? 0)) + Math.max(0, Number(usage.outputTokens ?? 0));
  // Session stats are cumulative — raise spentTokens floor without decreasing.
  if (total > state.spentTokens) {
    state.spentTokens = total;
  }
}

/**
 * Classify provider/auth failure from AgentSession state / messages / stop reason.
 * When the session exposes no agent state (test doubles / minimal adapters), callers
 * should pass `promptResolved: true` if prompt() returned without throwing.
 */
export function classifySessionOutcome(
  session: {
    agent?: {
      state?: {
        errorMessage?: string | null;
        messages?: Array<{
          role?: string;
          stopReason?: string;
          errorMessage?: string | null;
          content?: unknown;
        }>;
        isStreaming?: boolean;
      };
    };
    getSessionStats?: () => unknown;
  },
  options?: { promptResolved?: boolean },
): {
  ok: boolean;
  status: "succeeded" | "failed" | "blocked";
  errorCategory: string | null;
  errorMessage: string | null;
} {
  const state = session.agent?.state;
  const hasAgentState = Boolean(session.agent && "state" in session.agent);
  const errMsg = (state?.errorMessage ?? "").trim();
  const messages = state?.messages ?? [];
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const stop = (lastAssistant?.stopReason ?? "").toLowerCase();
  const assistantErr = (lastAssistant?.errorMessage ?? "").trim();
  const combined = `${errMsg}\n${assistantErr}\n${stop}`.toLowerCase();

  const authHints =
    /auth|unauthorized|unauthenticated|invalid[_ -]?api[_ -]?key|api[_ -]?key|401|403|permission|credential|forbidden|invalid.?key|authentication/i;
  const providerHints =
    /provider|rate.?limit|overloaded|model.?not.?found|billing|quota|connection.?refused|enotfound|econnrefused|fetch failed|network/i;

  if (stop === "error" || stop === "aborted" || errMsg || assistantErr) {
    if (authHints.test(combined)) {
      return {
        ok: false,
        status: "failed",
        errorCategory: "auth",
        errorMessage: assistantErr || errMsg || "Provider authentication failed",
      };
    }
    if (providerHints.test(combined)) {
      return {
        ok: false,
        status: "failed",
        errorCategory: "provider",
        errorMessage: assistantErr || errMsg || "Provider request failed",
      };
    }
    return {
      ok: false,
      status: "failed",
      errorCategory: "provider",
      errorMessage: assistantErr || errMsg || `Model stopReason=${stop || "error"}`,
    };
  }

  // Real AgentSession: require a non-error assistant turn. Empty transcript after prompt
  // is fail-closed (covers invalid-key providers that settle without throwing).
  if (hasAgentState) {
    if (!lastAssistant) {
      return {
        ok: false,
        status: "failed",
        errorCategory: "provider",
        errorMessage: "No assistant response after prompt",
      };
    }
    return { ok: true, status: "succeeded", errorCategory: null, errorMessage: null };
  }

  // Minimal adapters / test doubles without agent.state: honor promptResolved.
  if (options?.promptResolved) {
    return { ok: true, status: "succeeded", errorCategory: null, errorMessage: null };
  }
  return {
    ok: false,
    status: "failed",
    errorCategory: "provider",
    errorMessage: "No session outcome available",
  };
}
