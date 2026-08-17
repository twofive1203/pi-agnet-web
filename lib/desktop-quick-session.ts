/**
 * Desktop quick-session create path: bounded input, default model, and
 * instance-scoped requestId idempotency. The registry stores only hashes and
 * stable outcomes — never message, cwd, tokens, or provider text.
 */

import { createHash, randomBytes } from "crypto";
import { buildAgentDeepLink } from "./desktop-deep-link";
import {
  resolveDesktopProjectRef,
  type DesktopProjectCatalogDeps,
} from "./desktop-project-catalog";
import { getProcessInstanceId } from "./process-runtime";
import {
  selectDefaultNewSessionModel,
  type ModelMetadata,
} from "./model-metadata";
import {
  startNewAgentSession,
  type NewAgentSessionRuntime,
} from "./new-agent-session";
import {
  DESKTOP_QUICK_SESSION_MAX_MESSAGE_CHARS,
  DESKTOP_QUICK_SESSION_REQUEST_ID_PATTERN,
} from "./desktop-quick-session-limits";

export {
  DESKTOP_QUICK_SESSION_MAX_MESSAGE_CHARS,
  DESKTOP_QUICK_SESSION_REQUEST_ID_PATTERN,
} from "./desktop-quick-session-limits";

export const DESKTOP_QUICK_SESSION_MAX_BODY_BYTES = 32 * 1024;
export const DESKTOP_QUICK_SESSION_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

export const DESKTOP_QUICK_SESSION_ERROR_CODES = [
  "bad_request",
  "message_empty",
  "message_too_long",
  "project_unknown",
  "project_unavailable",
  "project_collision",
  "project_out_of_catalog",
  "model_unavailable",
  "request_conflict",
  "start_failed",
  "result_unknown",
] as const;

export type DesktopQuickSessionErrorCode = (typeof DESKTOP_QUICK_SESSION_ERROR_CODES)[number];

export type DesktopQuickSessionSuccess = {
  ok: true;
  sessionId: string;
  deepLink: string;
  duplicate: boolean;
};

export type DesktopQuickSessionFailure = {
  ok: false;
  status: 400 | 409 | 422 | 500;
  code: DesktopQuickSessionErrorCode;
};

export type DesktopQuickSessionResult = DesktopQuickSessionSuccess | DesktopQuickSessionFailure;

export type DesktopQuickSessionCreateInput = {
  projectRef: unknown;
  message: unknown;
  requestId: unknown;
};

export type DesktopQuickSessionCreateDeps = {
  catalog?: DesktopProjectCatalogDeps;
  loadModelMetadata?: (cwd: string) => Promise<ModelMetadata>;
  startSession?: typeof startNewAgentSession;
  sessionRuntime?: NewAgentSessionRuntime;
  instanceId?: string;
  now?: () => number;
};

type IdempotencyRecord =
  | {
      kind: "in_flight";
      instanceId: string;
      bodyHash: string;
      expiresAt: number;
      promise: Promise<DesktopQuickSessionResult>;
    }
  | {
      kind: "terminal";
      instanceId: string;
      bodyHash: string;
      expiresAt: number;
      result: DesktopQuickSessionResult;
    };

declare global {
  var __piDesktopQuickSessionIdempotency: Map<string, IdempotencyRecord> | undefined;
}

function registry(): Map<string, IdempotencyRecord> {
  if (!globalThis.__piDesktopQuickSessionIdempotency) {
    globalThis.__piDesktopQuickSessionIdempotency = new Map();
  }
  return globalThis.__piDesktopQuickSessionIdempotency;
}

function hashBody(parts: { projectRef: string; message: string; model: string }): string {
  return createHash("sha256")
    .update(parts.projectRef)
    .update("\0")
    .update(String(parts.message.length))
    .update("\0")
    .update(createHash("sha256").update(parts.message).digest("hex"))
    .update("\0")
    .update(parts.model)
    .digest("hex");
}

function pruneExpired(now: number): void {
  for (const [id, entry] of registry()) {
    if (entry.expiresAt <= now) registry().delete(id);
  }
}

function claimIdempotencySlot(input: {
  requestId: string;
  instanceId: string;
  bodyHash: string;
  now: number;
}):
  | { kind: "conflict" }
  | { kind: "reuse"; promise: Promise<DesktopQuickSessionResult> }
  | { kind: "fresh"; settle: (result: DesktopQuickSessionResult) => void } {
  const existing = registry().get(input.requestId);
  if (existing && existing.instanceId === input.instanceId && existing.expiresAt > input.now) {
    if (existing.bodyHash !== input.bodyHash) return { kind: "conflict" };
    if (existing.kind === "in_flight") return { kind: "reuse", promise: existing.promise };
    return { kind: "reuse", promise: Promise.resolve(existing.result) };
  }

  let settle!: (result: DesktopQuickSessionResult) => void;
  const promise = new Promise<DesktopQuickSessionResult>((resolve) => {
    settle = resolve;
  });
  registry().set(input.requestId, {
    kind: "in_flight",
    instanceId: input.instanceId,
    bodyHash: input.bodyHash,
    expiresAt: input.now + DESKTOP_QUICK_SESSION_IDEMPOTENCY_TTL_MS,
    promise,
  });
  return { kind: "fresh", settle };
}

function fail(code: DesktopQuickSessionErrorCode, status: DesktopQuickSessionFailure["status"]): DesktopQuickSessionFailure {
  return { ok: false, status, code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ALLOWED_CREATE_KEYS = new Set(["projectRef", "message", "requestId"]);
const SMUGGLED_KEYS = [
  "cwd",
  "path",
  "token",
  "accessKey",
  "provider",
  "modelId",
  "thinkingLevel",
  "toolPreset",
  "toolNames",
  "images",
  "prompt",
];

export function parseDesktopQuickSessionCreateBody(
  value: unknown,
): DesktopQuickSessionFailure | { ok: true; projectRef: string; message: string; requestId: string } {
  if (!isRecord(value)) return fail("bad_request", 400);
  for (const key of Object.keys(value)) {
    if (!ALLOWED_CREATE_KEYS.has(key) || SMUGGLED_KEYS.includes(key)) {
      return fail("bad_request", 400);
    }
  }

  const projectRef = typeof value.projectRef === "string" ? value.projectRef.trim() : "";
  const requestId = typeof value.requestId === "string" ? value.requestId.trim() : "";
  const message = typeof value.message === "string" ? value.message : "";

  if (!projectRef || !requestId || !DESKTOP_QUICK_SESSION_REQUEST_ID_PATTERN.test(requestId)) {
    return fail("bad_request", 400);
  }
  if (!message.trim()) return fail("message_empty", 400);
  if ([...message].length > DESKTOP_QUICK_SESSION_MAX_MESSAGE_CHARS) {
    return fail("message_too_long", 400);
  }

  return { ok: true, projectRef, message, requestId };
}

export async function createDesktopQuickSession(
  input: DesktopQuickSessionCreateInput,
  deps: DesktopQuickSessionCreateDeps = {},
): Promise<DesktopQuickSessionResult> {
  const parsed = parseDesktopQuickSessionCreateBody(input);
  if (!parsed.ok) return parsed;

  const resolved = await resolveDesktopProjectRef(parsed.projectRef, deps.catalog);
  if (!resolved.ok) {
    return fail(resolved.code, 422);
  }

  const loadModels =
    deps.loadModelMetadata
    ?? (await import("./model-metadata")).loadModelMetadata;
  const metadata = await loadModels(resolved.cwd);
  const selected = selectDefaultNewSessionModel(metadata);
  if (!selected) return fail("model_unavailable", 422);

  const instanceId = deps.instanceId ?? getProcessInstanceId();
  const now = deps.now?.() ?? Date.now();
  pruneExpired(now);

  const bodyHash = hashBody({
    projectRef: parsed.projectRef,
    message: parsed.message,
    model: `${selected.provider}:${selected.modelId}`,
  });
  const claimed = claimIdempotencySlot({
    requestId: parsed.requestId,
    instanceId,
    bodyHash,
    now,
  });
  if (claimed.kind === "conflict") return fail("request_conflict", 409);
  if (claimed.kind === "reuse") {
    const result = await claimed.promise;
    return result.ok ? { ...result, duplicate: true } : result;
  }

  const start = deps.startSession ?? startNewAgentSession;
  const settle = claimed.settle;

  try {
    const started = await start(
      {
        cwd: resolved.cwd,
        command: {
          type: "prompt",
          message: parsed.message,
          provider: selected.provider,
          modelId: selected.modelId,
          toolPreset: "all",
        },
      },
      deps.sessionRuntime,
    );
    if (!started.success) {
      const result = fail("start_failed", 500);
      registry().set(parsed.requestId, {
        kind: "terminal",
        instanceId,
        bodyHash,
        expiresAt: now + DESKTOP_QUICK_SESSION_IDEMPOTENCY_TTL_MS,
        result,
      });
      settle(result);
      return result;
    }

    const result: DesktopQuickSessionSuccess = {
      ok: true,
      sessionId: started.sessionId,
      deepLink: buildAgentDeepLink(started.sessionId),
      duplicate: false,
    };
    registry().set(parsed.requestId, {
      kind: "terminal",
      instanceId,
      bodyHash,
      expiresAt: now + DESKTOP_QUICK_SESSION_IDEMPOTENCY_TTL_MS,
      result,
    });
    settle(result);
    return result;
  } catch {
    const result = fail("result_unknown", 500);
    registry().set(parsed.requestId, {
      kind: "terminal",
      instanceId,
      bodyHash,
      expiresAt: now + DESKTOP_QUICK_SESSION_IDEMPOTENCY_TTL_MS,
      result,
    });
    settle(result);
    return result;
  }
}

export function resetDesktopQuickSessionIdempotencyForTests(): void {
  registry().clear();
}

/** Test-only nonce so callers can mint a valid requestId without importing crypto in UI. */
export function newDesktopQuickSessionRequestIdForTests(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
