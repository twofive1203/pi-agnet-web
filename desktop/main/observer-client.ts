/**
 * Attach-only desktop observer client (U6 + SSE stream).
 *
 * Probes 127.0.0.1 health + protocol, mints a short-lived token in main, and
 * consumes one service-level SSE. Injectable fetch/SSE transport for tests.
 *
 * HARD RULES:
 * - Never import child_process / spawn / kill / pid helpers.
 * - Never store service PIDs.
 * - Token stays in main-process memory only (not settings, not renderer).
 */

import { DESKTOP_OBSERVER_PRODUCT } from "../../lib/desktop-observer-constants";
import { TASK_OBSERVER_PROTOCOL_VERSION } from "../../lib/task-observer-types";
import {
  acknowledgeConnectionBaseline,
  buildDesktopOrigin,
  createInitialConnectionState,
  DESKTOP_DEFAULT_PORT,
  reduceConnectionState,
  type DesktopConnectionEvent,
  type DesktopConnectionReasonCode,
  type DesktopConnectionState,
} from "./connection-state";

export const DESKTOP_OBSERVER_TOKEN_HEADER = "x-spi-desktop-observer-token";

export type DesktopFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    body?: string;
  },
) => Promise<DesktopFetchResponse>;

export type DesktopFetchResponse = {
  ok: boolean;
  status: number;
  /** True when TCP connect was refused / failed before HTTP. */
  connectionRefused?: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

/** Minimal SSE transport so tests need not supply a real byte stream. */
export type DesktopSseTransport = (input: {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}) => Promise<DesktopSseTransportResult>;

export type DesktopSseTransportResult =
  | {
      ok: true;
      status: number;
      /** Yield UTF-8 text chunks until the stream ends. */
      chunks: AsyncIterable<string>;
    }
  | {
      ok: false;
      status: number;
      connectionRefused?: boolean;
      detail?: string;
    };

export type DesktopProtocolPayload = {
  protocolVersion?: unknown;
  product?: unknown;
  mode?: unknown;
  instanceId?: unknown;
  compatible?: unknown;
  authRequired?: unknown;
  reasonCode?: unknown;
};

export type DesktopSessionPayload = {
  token?: unknown;
  expiresAt?: unknown;
  instanceId?: unknown;
  tokenHeader?: unknown;
};

export type ObserverClientOptions = {
  port?: number;
  fetch?: DesktopFetch;
  /** Override SSE byte/text transport (defaults to fetch streaming). */
  sseTransport?: DesktopSseTransport;
  /**
   * When false, stop after probe/token (unit tests). Default true for the pet.
   */
  enableSse?: boolean;
  now?: () => number;
  /** Base reconnect delay after stream loss (ms). */
  reconnectDelayMs?: number;
  /**
   * Optional server-mode access key (main memory only).
   * Used only for POST /desktop-observer/session when authRequired.
   */
  accessKey?: string | null;
  onStateChange?: (state: DesktopConnectionState) => void;
  /** Called for each full snapshot JSON text from SSE (main-only). */
  onSnapshot?: (snapshotJson: string, meta: { reset: boolean; instanceId: string | null }) => void;
};

export type ProbeResult =
  | { ok: true; instanceId: string; token: string; expiresAt: number }
  | { ok: false; event: DesktopConnectionEvent };

/**
 * Classify a thrown/network failure. Connection refused is distinct.
 */
export function classifyFetchFailure(error: unknown): DesktopConnectionEvent {
  const message = error instanceof Error ? error.message : String(error ?? "error");
  const lower = message.toLowerCase();
  if (
    lower.includes("econnrefused") ||
    lower.includes("connection refused") ||
    lower.includes("fetch failed") ||
    lower.includes("networkerror") ||
    lower.includes("connect etimedout") ||
    lower.includes("enotfound")
  ) {
    if (lower.includes("econnrefused") || lower.includes("connection refused")) {
      return { type: "connection_refused" };
    }
    return { type: "network_error", detail: message };
  }
  return { type: "network_error", detail: message };
}

export function interpretHealthPayload(payload: unknown, httpStatus: number): DesktopConnectionEvent | null {
  if (httpStatus === 0) return { type: "connection_refused" };
  if (httpStatus < 200 || httpStatus >= 300) {
    return { type: "incompatible", reasonCode: "health_http_error", detail: `http_${httpStatus}` };
  }
  if (!payload || typeof payload !== "object") {
    return { type: "incompatible", reasonCode: "health_invalid", detail: "non_object" };
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.instanceId !== "string" || !record.instanceId.trim()) {
    return { type: "incompatible", reasonCode: "health_invalid", detail: "missing_instance" };
  }
  return null;
}

export function interpretProtocolPayload(
  payload: unknown,
  httpStatus: number,
  expectedProtocolVersion = TASK_OBSERVER_PROTOCOL_VERSION,
): DesktopConnectionEvent | {
  type: "protocol_ok";
  instanceId: string;
  authRequired: boolean;
} {
  if (httpStatus === 0) return { type: "connection_refused" };
  // 401/403 on the pre-session probe almost always means server-mode access auth.
  if (httpStatus === 401 || httpStatus === 403) {
    return { type: "incompatible", reasonCode: "auth_required", detail: `http_${httpStatus}` };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return { type: "incompatible", reasonCode: "protocol_http_error", detail: `http_${httpStatus}` };
  }
  if (!payload || typeof payload !== "object") {
    return { type: "incompatible", reasonCode: "protocol_invalid", detail: "non_object" };
  }
  const p = payload as DesktopProtocolPayload;
  if (p.product !== DESKTOP_OBSERVER_PRODUCT) {
    return { type: "incompatible", reasonCode: "product_mismatch", detail: String(p.product ?? "missing") };
  }
  if (p.protocolVersion !== expectedProtocolVersion) {
    return {
      type: "incompatible",
      reasonCode: "protocol_mismatch",
      detail: `got_${String(p.protocolVersion)}`,
    };
  }
  // Legacy servers rejected server mode with compatible:false / reasonCode server_mode.
  if (p.compatible === false) {
    const reason =
      p.reasonCode === "server_mode" || p.mode === "server" ? "server_mode" : "protocol_invalid";
    return {
      type: "incompatible",
      reasonCode: reason,
      detail: typeof p.reasonCode === "string" ? p.reasonCode : undefined,
    };
  }
  if (typeof p.instanceId !== "string" || !p.instanceId.trim()) {
    return { type: "incompatible", reasonCode: "protocol_invalid", detail: "missing_instance" };
  }
  const authRequired =
    p.authRequired === true || p.mode === "server" || p.reasonCode === "auth_required";
  return {
    type: "protocol_ok",
    instanceId: p.instanceId.trim(),
    authRequired,
  };
}

export function interpretSessionPayload(
  payload: unknown,
  httpStatus: number,
): { ok: true; token: string; expiresAt: number; instanceId: string } | DesktopConnectionEvent {
  if (httpStatus === 0) return { type: "connection_refused" };
  if (httpStatus === 401 || httpStatus === 403) {
    const code =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { code?: unknown }).code === "string"
        ? String((payload as { code: string }).code)
        : "";
    if (code === "auth_invalid") {
      return { type: "incompatible", reasonCode: "auth_invalid", detail: `session_http_${httpStatus}` };
    }
    if (code === "auth_required" || code === "unauthorized" || !code) {
      return { type: "incompatible", reasonCode: "auth_required", detail: `session_http_${httpStatus}` };
    }
    return { type: "incompatible", reasonCode: "auth_invalid", detail: code };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return { type: "incompatible", reasonCode: "protocol_http_error", detail: `session_http_${httpStatus}` };
  }
  if (!payload || typeof payload !== "object") {
    return { type: "incompatible", reasonCode: "protocol_invalid", detail: "session_non_object" };
  }
  const p = payload as DesktopSessionPayload;
  if (typeof p.token !== "string" || !p.token.trim()) {
    return { type: "incompatible", reasonCode: "protocol_invalid", detail: "missing_token" };
  }
  if (typeof p.instanceId !== "string" || !p.instanceId.trim()) {
    return { type: "incompatible", reasonCode: "protocol_invalid", detail: "session_missing_instance" };
  }
  const expiresAt =
    typeof p.expiresAt === "number" && Number.isFinite(p.expiresAt)
      ? p.expiresAt
      : Date.now() + 15 * 60 * 1000;
  return {
    ok: true,
    token: p.token,
    expiresAt,
    instanceId: p.instanceId.trim(),
  };
}

/**
 * Parse one SSE block (`event:` / `data:` lines). Heartbeat comments are ignored by the caller.
 */
export function parseSseBlock(block: string): { event: string | null; data: string } | null {
  const lines = block.split(/\r?\n/);
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  if (dataLines.length === 0 && !event) return null;
  return { event, data: dataLines.join("\n") };
}

/**
 * Server `/api/desktop-observer/events` wraps snapshots:
 * `{ type: "reset"|"snapshot"|"error", snapshot?: object, code?: string }`
 * Legacy plain snapshot objects (with instanceId) are also accepted.
 */
export function unwrapObserverSseData(rawData: string): {
  kind: "snapshot" | "error" | "ignore";
  snapshotJson?: string;
  reset?: boolean;
  code?: string;
} {
  const trimmed = rawData.trim();
  if (!trimmed) return { kind: "ignore" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { kind: "error", code: "bad_json" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { kind: "error", code: "not_object" };
  }
  const record = parsed as Record<string, unknown>;

  if (record.type === "error") {
    return {
      kind: "error",
      code: typeof record.code === "string" ? record.code : "stream_error",
    };
  }

  if (record.snapshot && typeof record.snapshot === "object") {
    return {
      kind: "snapshot",
      snapshotJson: JSON.stringify(record.snapshot),
      reset: record.type === "reset" || (record.snapshot as { reset?: unknown }).reset === true,
    };
  }

  // Legacy / test: body is the snapshot itself.
  if (typeof record.instanceId === "string" || typeof record.revision === "number") {
    return {
      kind: "snapshot",
      snapshotJson: trimmed,
      reset: record.reset === true,
    };
  }

  return { kind: "ignore" };
}

export class DesktopObserverClient {
  private state: DesktopConnectionState;
  private readonly fetchImpl: DesktopFetch;
  private readonly sseTransport: DesktopSseTransport;
  private readonly enableSse: boolean;
  private readonly reconnectDelayMs: number;
  private readonly now: () => number;
  private readonly onStateChange?: (state: DesktopConnectionState) => void;
  private readonly onSnapshot?: (
    snapshotJson: string,
    meta: { reset: boolean; instanceId: string | null },
  ) => void;
  /** Main-memory only — never written to settings JSON. */
  private accessKey: string | null = null;
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private stopped = false;
  private probeController: AbortController | null = null;
  private sseController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  constructor(options: ObserverClientOptions = {}) {
    const port = options.port ?? DESKTOP_DEFAULT_PORT;
    this.state = createInitialConnectionState({ port, now: options.now?.() ?? Date.now() });
    this.fetchImpl = options.fetch ?? defaultDesktopFetch;
    this.sseTransport = options.sseTransport ?? defaultSseTransport;
    this.enableSse = options.enableSse !== false;
    this.reconnectDelayMs = Math.max(250, options.reconnectDelayMs ?? 1500);
    this.now = options.now ?? Date.now;
    this.onStateChange = options.onStateChange;
    this.onSnapshot = options.onSnapshot;
    this.accessKey = normalizeClientAccessKey(options.accessKey);
  }

  getState(): DesktopConnectionState {
    return this.state;
  }

  getOrigin(): string {
    return this.state.origin;
  }

  /** Main-only token accessor — never expose to renderer. */
  getTokenForTests(): string | null {
    return this.token;
  }

  hasAccessKey(): boolean {
    return Boolean(this.accessKey);
  }

  /** Replace the in-memory access key used for server-mode session mint. */
  setAccessKey(accessKey: string | null | undefined): void {
    this.accessKey = normalizeClientAccessKey(accessKey);
  }

  /** True when this module graph must not reference process control APIs. */
  static forbiddenApis(): readonly string[] {
    return ["child_process", "spawn", "fork", "exec", "execFile", "kill", "servicePid"];
  }

  private dispatch(event: DesktopConnectionEvent): void {
    this.state = reduceConnectionState(this.state, event, this.now());
    this.onStateChange?.(this.state);
  }

  start(): void {
    this.stopped = false;
    this.clearReconnectTimer();
    this.dispatch({ type: "start_probe" });
    void this.probeAndAttach();
  }

  retry(): void {
    if (this.stopped) return;
    this.clearReconnectTimer();
    this.abortNetworking();
    this.reconnectAttempt = 0;
    this.dispatch({ type: "retry" });
    void this.probeAndAttach();
  }

  /** Stop only this client's timers/networking. Never signals a service. */
  quit(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.abortNetworking();
    this.token = null;
    this.tokenExpiresAt = 0;
    this.dispatch({ type: "quit" });
  }

  /** Mark the current connected snapshot as the notification baseline. */
  consumeNotificationBaseline(): void {
    this.state = acknowledgeConnectionBaseline(this.state, this.now());
    this.onStateChange?.(this.state);
  }

  private abortNetworking(): void {
    if (this.probeController) {
      this.probeController.abort();
      this.probeController = null;
    }
    if (this.sseController) {
      this.sseController.abort();
      this.sseController = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(detail?: string): void {
    if (this.stopped) return;
    this.clearReconnectTimer();
    this.reconnectAttempt += 1;
    const delay = Math.min(
      30_000,
      this.reconnectDelayMs * Math.min(8, this.reconnectAttempt),
    );
    this.dispatch({ type: "stream_lost", detail: detail ?? `reconnect_in_${delay}ms` });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      void this.probeAndAttach();
    }, delay);
  }

  private async probeAndAttach(): Promise<void> {
    if (this.stopped) return;
    this.abortNetworking();
    const controller = new AbortController();
    this.probeController = controller;

    const result = await this.probe(controller.signal);
    if (this.stopped || controller.signal.aborted) return;

    if (!result.ok) {
      this.token = null;
      this.dispatch(result.event);
      // Soft reconnect only after we were previously live / probing retries.
      if (
        result.event.type === "connection_refused" ||
        result.event.type === "network_error"
      ) {
        // Leave service-not-running visible; still low-rate retry while running.
        this.scheduleReconnect(result.event.type);
      }
      return;
    }

    const previousInstance = this.state.instanceId;
    this.token = result.token;
    this.tokenExpiresAt = result.expiresAt;
    const resetBaseline =
      previousInstance == null ||
      previousInstance !== result.instanceId ||
      this.state.resetNotificationBaseline;
    this.dispatch({
      type: "connected",
      instanceId: result.instanceId,
      resetBaseline,
    });
    this.reconnectAttempt = 0;

    if (this.enableSse) {
      void this.runSseLoop();
    }
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    const origin = buildDesktopOrigin(this.state.port);

    const health = await this.safeFetch(`${origin}/api/health`, { method: "GET", signal });
    if (!health.okResponse) {
      return { ok: false, event: health.event };
    }
    let healthJson: unknown;
    try {
      healthJson = await health.okResponse.json();
    } catch {
      return {
        ok: false,
        event: { type: "incompatible", reasonCode: "health_invalid", detail: "bad_json" },
      };
    }
    const healthEvent = interpretHealthPayload(healthJson, health.okResponse.status);
    if (healthEvent) return { ok: false, event: healthEvent };

    const protocol = await this.safeFetch(`${origin}/api/desktop-observer/protocol`, {
      method: "GET",
      signal,
    });
    if (!protocol.okResponse) {
      return { ok: false, event: protocol.event };
    }
    let protocolJson: unknown;
    try {
      protocolJson = await protocol.okResponse.json();
    } catch {
      return {
        ok: false,
        event: { type: "incompatible", reasonCode: "protocol_invalid", detail: "bad_json" },
      };
    }
    const protocolResult = interpretProtocolPayload(protocolJson, protocol.okResponse.status);
    if (protocolResult.type !== "protocol_ok") {
      return { ok: false, event: protocolResult };
    }

    if (protocolResult.authRequired && !this.accessKey) {
      return {
        ok: false,
        event: { type: "incompatible", reasonCode: "auth_required", detail: "missing_access_key" },
      };
    }

    const sessionBody = this.accessKey ? { accessKey: this.accessKey } : {};
    const session = await this.safeFetch(`${origin}/api/desktop-observer/session`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sessionBody),
    });
    if (!session.okResponse) {
      return { ok: false, event: session.event };
    }
    let sessionJson: unknown;
    try {
      sessionJson = await session.okResponse.json();
    } catch {
      if (session.okResponse.status === 401 || session.okResponse.status === 403) {
        return {
          ok: false,
          event: {
            type: "incompatible",
            reasonCode: this.accessKey ? "auth_invalid" : "auth_required",
            detail: "session_bad_json",
          },
        };
      }
      return {
        ok: false,
        event: { type: "incompatible", reasonCode: "protocol_invalid", detail: "session_bad_json" },
      };
    }
    const sessionResult = interpretSessionPayload(sessionJson, session.okResponse.status);
    if (!("ok" in sessionResult) || sessionResult.ok !== true) {
      return { ok: false, event: sessionResult as DesktopConnectionEvent };
    }

    if (sessionResult.instanceId !== protocolResult.instanceId) {
      return {
        ok: false,
        event: {
          type: "incompatible",
          reasonCode: "protocol_invalid",
          detail: "instance_mismatch",
        },
      };
    }

    return {
      ok: true,
      instanceId: sessionResult.instanceId,
      token: sessionResult.token,
      expiresAt: sessionResult.expiresAt,
    };
  }

  private async runSseLoop(): Promise<void> {
    if (this.stopped || !this.token || !this.enableSse) return;

    const controller = new AbortController();
    this.sseController = controller;
    const origin = buildDesktopOrigin(this.state.port);
    const url = `${origin}/api/desktop-observer/events`;

    try {
      const result = await this.sseTransport({
        url,
        headers: {
          Accept: "text/event-stream",
          [DESKTOP_OBSERVER_TOKEN_HEADER]: this.token,
        },
        signal: controller.signal,
      });

      if (this.stopped || controller.signal.aborted) return;

      if (!result.ok) {
        if (result.status === 401 || result.status === 403) {
          this.handleTokenExpiry();
          return;
        }
        if (result.connectionRefused) {
          this.token = null;
          this.dispatch({ type: "connection_refused" });
          this.scheduleReconnect("sse_refused");
          return;
        }
        this.scheduleReconnect(result.detail ?? `sse_http_${result.status}`);
        return;
      }

      let buffer = "";
      for await (const chunk of result.chunks) {
        if (this.stopped || controller.signal.aborted) return;
        buffer += chunk;
        // SSE events are separated by blank lines.
        let splitAt = buffer.indexOf("\n\n");
        while (splitAt !== -1) {
          const block = buffer.slice(0, splitAt);
          buffer = buffer.slice(splitAt + 2);
          const parsed = parseSseBlock(block);
          if (parsed) {
            this.handleSseMessage(parsed);
          }
          splitAt = buffer.indexOf("\n\n");
        }
        // Also accept CRLF separators.
        let splitAtCr = buffer.indexOf("\r\n\r\n");
        while (splitAtCr !== -1) {
          const block = buffer.slice(0, splitAtCr);
          buffer = buffer.slice(splitAtCr + 4);
          const parsed = parseSseBlock(block);
          if (parsed) {
            this.handleSseMessage(parsed);
          }
          splitAtCr = buffer.indexOf("\r\n\r\n");
        }
      }

      if (!this.stopped) {
        this.scheduleReconnect("sse_ended");
      }
    } catch (error) {
      if (this.stopped || controller.signal.aborted) return;
      const classified = classifyFetchFailure(error);
      if (classified.type === "connection_refused") {
        this.token = null;
        this.dispatch({ type: "connection_refused" });
      }
      this.scheduleReconnect(
        classified.type === "network_error" ? classified.detail ?? "sse_error" : classified.type,
      );
    }
  }

  /**
   * Feed one SSE message payload already parsed by the transport layer.
   */
  handleSseMessage(input: { event?: string | null; data: string }): void {
    if (this.stopped) return;
    if (!input.data.trim()) return;

    const unwrapped = unwrapObserverSseData(input.data);
    if (unwrapped.kind === "ignore") return;
    if (unwrapped.kind === "error") {
      if (unwrapped.code === "token_expired") {
        this.handleTokenExpiry();
        return;
      }
      this.handleSseError(unwrapped.code);
      return;
    }

    const snapshotJson = unwrapped.snapshotJson ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(snapshotJson) as unknown;
    } catch {
      this.dispatch({ type: "stream_lost", detail: "bad_snapshot_json" });
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      this.dispatch({ type: "stream_lost", detail: "snapshot_not_object" });
      return;
    }
    const record = parsed as Record<string, unknown>;
    const instanceId =
      typeof record.instanceId === "string" && record.instanceId.trim()
        ? record.instanceId.trim()
        : this.state.instanceId;
    if (this.state.instanceId && instanceId && instanceId !== this.state.instanceId) {
      this.dispatch({ type: "instance_changed", instanceId });
      this.token = null;
      void this.probeAndAttach();
      return;
    }

    const eventName = input.event ?? null;
    const reset =
      unwrapped.reset === true ||
      eventName === "reset" ||
      record.reset === true;
    if (this.state.status !== "connected") {
      this.dispatch({
        type: "connected",
        instanceId: instanceId ?? "unknown",
        resetBaseline: reset || this.state.resetNotificationBaseline,
      });
    }
    this.onSnapshot?.(snapshotJson, {
      reset: reset || this.state.resetNotificationBaseline,
      instanceId: this.state.instanceId,
    });
    if (reset || this.state.resetNotificationBaseline) {
      this.consumeNotificationBaseline();
    }
  }

  handleSseError(detail?: string): void {
    if (this.stopped) return;
    this.dispatch({ type: "stream_lost", detail });
  }

  handleTokenExpiry(): void {
    if (this.stopped) return;
    this.token = null;
    this.abortNetworking();
    this.dispatch({ type: "token_rejected" });
    void this.probeAndAttach();
  }

  private async safeFetch(
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      body?: string;
    },
  ): Promise<
    | { okResponse: DesktopFetchResponse; event?: undefined }
    | { okResponse: null; event: DesktopConnectionEvent }
  > {
    try {
      const response = await this.fetchImpl(url, init);
      if (response.connectionRefused) {
        return { okResponse: null, event: { type: "connection_refused" } };
      }
      return { okResponse: response };
    } catch (error) {
      if (init.signal?.aborted) {
        return { okResponse: null, event: { type: "network_error", detail: "aborted" } };
      }
      return { okResponse: null, event: classifyFetchFailure(error) };
    }
  }
}

async function defaultDesktopFetch(
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    body?: string;
  },
): Promise<DesktopFetchResponse> {
  try {
    const response = await fetch(input, {
      method: init?.method,
      headers: init?.headers,
      signal: init?.signal,
      body: init?.body,
    });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json() as Promise<unknown>,
      text: async () => response.text(),
    };
  } catch (error) {
    const event = classifyFetchFailure(error);
    if (event.type === "connection_refused") {
      return {
        ok: false,
        status: 0,
        connectionRefused: true,
        json: async () => ({}),
        text: async () => "",
      };
    }
    throw error;
  }
}

async function defaultSseTransport(input: {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}): Promise<DesktopSseTransportResult> {
  try {
    const response = await fetch(input.url, {
      method: "GET",
      headers: input.headers,
      signal: input.signal,
    });
    if (!response.ok || !response.body) {
      return {
        ok: false,
        status: response.status,
        detail: `sse_http_${response.status}`,
      };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const chunks: AsyncIterable<string> = {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) yield decoder.decode(value, { stream: true });
          }
          const tail = decoder.decode();
          if (tail) yield tail;
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // ignore
          }
        }
      },
    };
    return { ok: true, status: response.status, chunks };
  } catch (error) {
    if (input.signal.aborted) {
      return { ok: false, status: 0, detail: "aborted" };
    }
    const event = classifyFetchFailure(error);
    return {
      ok: false,
      status: 0,
      connectionRefused: event.type === "connection_refused",
      detail: event.type === "network_error" ? event.detail ?? "sse_error" : event.type,
    };
  }
}

/** Map reason codes to short UI labels (renderer may i18n separately later). */
export function connectionReasonLabel(code: DesktopConnectionReasonCode | null): string {
  switch (code) {
    case "connection_refused":
      return "Service not running";
    case "server_mode":
      return "Server mode unsupported";
    case "auth_required":
      return "Access key required";
    case "auth_invalid":
      return "Invalid access key";
    case "protocol_mismatch":
      return "Observer protocol mismatch";
    case "product_mismatch":
      return "Not a Snail Pi Web service";
    case "health_invalid":
    case "health_http_error":
      return "Unknown service on port";
    case "token_rejected":
      return "Observer session expired";
    case "instance_changed":
      return "Service instance changed";
    default:
      return code ? `Connection issue (${code})` : "Connection issue";
  }
}

function normalizeClientAccessKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key.length > 512) return null;
  return key;
}
