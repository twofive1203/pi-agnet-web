/**
 * Attach-only desktop observer client (U6).
 *
 * Probes 127.0.0.1 health + protocol, mints a short-lived token in main, and
 * consumes one service-level SSE. Injectable fetch for tests.
 *
 * HARD RULES:
 * - Never import child_process / spawn / kill / pid helpers.
 * - Never store service PIDs.
 * - Token stays in main-process memory only (not settings, not renderer).
 */

import { TASK_OBSERVER_PROTOCOL_VERSION } from "../../lib/task-observer-types";
import { DESKTOP_OBSERVER_PRODUCT } from "../../lib/desktop-observer-access";
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

export type DesktopProtocolPayload = {
  protocolVersion?: unknown;
  product?: unknown;
  mode?: unknown;
  instanceId?: unknown;
  compatible?: unknown;
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
  now?: () => number;
  /** Optional low-rate reconnect backoff (ms). */
  reconnectDelayMs?: number;
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
    // Prefer service-not-running for cold attach failures; client maps via refused flag too.
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
  // Minimal health should expose instanceId; missing → unknown service.
  if (typeof record.instanceId !== "string" || !record.instanceId.trim()) {
    return { type: "incompatible", reasonCode: "health_invalid", detail: "missing_instance" };
  }
  return null;
}

export function interpretProtocolPayload(
  payload: unknown,
  httpStatus: number,
  expectedProtocolVersion = TASK_OBSERVER_PROTOCOL_VERSION,
): ProbeResult extends { ok: true } ? never : DesktopConnectionEvent | { type: "protocol_ok"; instanceId: string } {
  if (httpStatus === 0) return { type: "connection_refused" };
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
  if (p.mode === "server" || p.compatible === false || p.reasonCode === "server_mode") {
    return { type: "incompatible", reasonCode: "server_mode" };
  }
  if (typeof p.instanceId !== "string" || !p.instanceId.trim()) {
    return { type: "incompatible", reasonCode: "protocol_invalid", detail: "missing_instance" };
  }
  return { type: "protocol_ok", instanceId: p.instanceId.trim() };
}

export function interpretSessionPayload(
  payload: unknown,
  httpStatus: number,
): { ok: true; token: string; expiresAt: number; instanceId: string } | DesktopConnectionEvent {
  if (httpStatus === 0) return { type: "connection_refused" };
  if (httpStatus === 401 || httpStatus === 403) return { type: "token_rejected" };
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

export class DesktopObserverClient {
  private state: DesktopConnectionState;
  private readonly fetchImpl: DesktopFetch;
  private readonly now: () => number;
  private readonly onStateChange?: (state: DesktopConnectionState) => void;
  private readonly onSnapshot?: (
    snapshotJson: string,
    meta: { reset: boolean; instanceId: string | null },
  ) => void;
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private stopped = false;
  private probeController: AbortController | null = null;

  constructor(options: ObserverClientOptions = {}) {
    const port = options.port ?? DESKTOP_DEFAULT_PORT;
    this.state = createInitialConnectionState({ port, now: options.now?.() ?? Date.now() });
    this.fetchImpl = options.fetch ?? defaultDesktopFetch;
    this.now = options.now ?? Date.now;
    this.onStateChange = options.onStateChange;
    this.onSnapshot = options.onSnapshot;
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
    this.dispatch({ type: "start_probe" });
    void this.probeAndAttach();
  }

  retry(): void {
    if (this.stopped) return;
    this.abortProbe();
    this.dispatch({ type: "retry" });
    void this.probeAndAttach();
  }

  /** Stop only this client's timers/networking. Never signals a service. */
  quit(): void {
    this.stopped = true;
    this.abortProbe();
    this.token = null;
    this.tokenExpiresAt = 0;
    this.dispatch({ type: "quit" });
  }

  /** Mark the current connected snapshot as the notification baseline. */
  consumeNotificationBaseline(): void {
    this.state = acknowledgeConnectionBaseline(this.state, this.now());
    this.onStateChange?.(this.state);
  }

  private abortProbe(): void {
    if (this.probeController) {
      this.probeController.abort();
      this.probeController = null;
    }
  }

  private async probeAndAttach(): Promise<void> {
    if (this.stopped) return;
    this.abortProbe();
    const controller = new AbortController();
    this.probeController = controller;

    const result = await this.probe(controller.signal);
    if (this.stopped || controller.signal.aborted) return;

    if (!result.ok) {
      this.token = null;
      this.dispatch(result.event);
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
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    const origin = buildDesktopOrigin(this.state.port);

    // 1) Health
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

    // 2) Protocol
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

    // 3) Session token (main only)
    const session = await this.safeFetch(`${origin}/api/desktop-observer/session`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!session.okResponse) {
      return { ok: false, event: session.event };
    }
    let sessionJson: unknown;
    try {
      sessionJson = await session.okResponse.json();
    } catch {
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

  /**
   * Feed one SSE message payload already parsed by the transport layer.
   * Used by tests and by a future main SSE reader.
   */
  handleSseMessage(input: { event?: string | null; data: string }): void {
    if (this.stopped) return;
    const eventName = input.event ?? "snapshot";
    if (!input.data.trim()) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(input.data) as unknown;
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
    if (
      this.state.instanceId &&
      instanceId &&
      instanceId !== this.state.instanceId
    ) {
      this.dispatch({ type: "instance_changed", instanceId });
      this.token = null;
      void this.probeAndAttach();
      return;
    }

    const reset = eventName === "reset" || record.reset === true;
    if (this.state.status !== "connected") {
      this.dispatch({
        type: "connected",
        instanceId: instanceId ?? "unknown",
        resetBaseline: reset || this.state.resetNotificationBaseline,
      });
    }
    this.onSnapshot?.(input.data, {
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

/** Map reason codes to short UI labels (renderer may i18n separately later). */
export function connectionReasonLabel(code: DesktopConnectionReasonCode | null): string {
  switch (code) {
    case "connection_refused":
      return "Service not running";
    case "server_mode":
      return "Server mode unsupported";
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
