/**
 * Pure connection state machine for the attach-only desktop pet (U6).
 *
 * No child_process, PID, signal, or service ownership — only probe/attach UX.
 */

export const DESKTOP_DEFAULT_PORT = 62666;
export const DESKTOP_DEFAULT_HOST = "127.0.0.1";
export const DESKTOP_START_COMMAND = "spi --no-open";

export type DesktopConnectionStatus =
  | "probing"
  | "connected"
  | "reconnecting"
  | "service-not-running"
  | "incompatible";

/** Stable diagnostic codes for incompatible / failed attach (never raw HTML bodies). */
export type DesktopConnectionReasonCode =
  | "connection_refused"
  | "network_error"
  | "health_invalid"
  | "health_http_error"
  | "protocol_http_error"
  | "protocol_invalid"
  | "protocol_mismatch"
  | "product_mismatch"
  | "server_mode"
  | "auth_required"
  | "auth_invalid"
  | "token_rejected"
  | "instance_changed"
  | "stream_error"
  | "unknown";

export type DesktopConnectionState = {
  status: DesktopConnectionStatus;
  origin: string;
  port: number;
  /** Copyable only — never executed by the pet. */
  startCommand: string;
  instanceId: string | null;
  reasonCode: DesktopConnectionReasonCode | null;
  detail: string | null;
  attempt: number;
  /** When true, the next successful snapshot is a notification baseline (no toasts). */
  resetNotificationBaseline: boolean;
  /**
   * Additive protocol capability. Missing/unknown on old servers stays false so
   * observer attach still works while the quick-session entry stays hidden.
   */
  quickSessionAvailable: boolean;
  updatedAt: number;
};

export type DesktopConnectionEvent =
  | { type: "start_probe" }
  | { type: "retry" }
  | { type: "connection_refused" }
  | { type: "network_error"; detail?: string }
  | {
      type: "incompatible";
      reasonCode: Exclude<
        DesktopConnectionReasonCode,
        "connection_refused" | "network_error" | "instance_changed" | "stream_error"
      >;
      detail?: string;
    }
  | {
      type: "connected";
      instanceId: string;
      resetBaseline?: boolean;
      quickSessionAvailable?: boolean;
    }
  | { type: "stream_lost"; detail?: string }
  | { type: "instance_changed"; instanceId: string }
  | { type: "token_rejected" }
  | { type: "quit" };

export function buildDesktopOrigin(port: number = DESKTOP_DEFAULT_PORT): string {
  const safePort = Number.isFinite(port) && port > 0 && port <= 65535 ? Math.floor(port) : DESKTOP_DEFAULT_PORT;
  return `http://${DESKTOP_DEFAULT_HOST}:${safePort}`;
}

export function createInitialConnectionState(input?: {
  port?: number;
  now?: number;
}): DesktopConnectionState {
  const port =
    input?.port && Number.isFinite(input.port) && input.port > 0 && input.port <= 65535
      ? Math.floor(input.port)
      : DESKTOP_DEFAULT_PORT;
  return {
    status: "probing",
    origin: buildDesktopOrigin(port),
    port,
    startCommand: DESKTOP_START_COMMAND,
    instanceId: null,
    reasonCode: null,
    detail: null,
    attempt: 0,
    resetNotificationBaseline: true,
    quickSessionAvailable: false,
    updatedAt: input?.now ?? 0,
  };
}

function withMeta(
  state: DesktopConnectionState,
  patch: Partial<DesktopConnectionState>,
  now: number,
): DesktopConnectionState {
  return {
    ...state,
    ...patch,
    origin: buildDesktopOrigin(patch.port ?? state.port),
    startCommand: DESKTOP_START_COMMAND,
    updatedAt: now,
  };
}

/**
 * Pure reducer. Service-not-running is distinct from incompatible diagnostics.
 * Quit only clears local networking intent — never mutates a service.
 */
export function reduceConnectionState(
  state: DesktopConnectionState,
  event: DesktopConnectionEvent,
  now = Date.now(),
): DesktopConnectionState {
  switch (event.type) {
    case "start_probe":
      return withMeta(
        state,
        {
          status: "probing",
          reasonCode: null,
          detail: null,
          attempt: state.attempt + (state.status === "probing" ? 0 : 1),
        },
        now,
      );

    case "retry":
      return withMeta(
        state,
        {
          status: "probing",
          reasonCode: null,
          detail: null,
          attempt: state.attempt + 1,
          // Manual retry after disconnect keeps baseline only when we were not connected.
          resetNotificationBaseline:
            state.status === "service-not-running" ||
            state.status === "incompatible" ||
            state.status === "probing"
              ? true
              : state.resetNotificationBaseline,
        },
        now,
      );

    case "connection_refused":
      return withMeta(
        state,
        {
          status: "service-not-running",
          reasonCode: "connection_refused",
          detail: null,
          instanceId: null,
          quickSessionAvailable: false,
        },
        now,
      );

    case "network_error":
      // Soft network blip while connected → reconnecting; cold probe → service-not-running
      // only when the failure looks like refusal is handled by the client via connection_refused.
      if (state.status === "connected" || state.status === "reconnecting") {
        return withMeta(
          state,
          {
            status: "reconnecting",
            reasonCode: "network_error",
            detail: clampDetail(event.detail),
            attempt: state.attempt + 1,
          },
          now,
        );
      }
      return withMeta(
        state,
        {
          status: "service-not-running",
          reasonCode: "network_error",
          detail: clampDetail(event.detail),
          instanceId: null,
          quickSessionAvailable: false,
        },
        now,
      );

    case "incompatible":
      return withMeta(
        state,
        {
          status: "incompatible",
          reasonCode: event.reasonCode,
          detail: clampDetail(event.detail),
          instanceId: null,
          quickSessionAvailable: false,
        },
        now,
      );

    case "connected": {
      const instanceChanged =
        state.instanceId != null && state.instanceId !== event.instanceId;
      const resetBaseline =
        event.resetBaseline === true ||
        state.resetNotificationBaseline ||
        instanceChanged ||
        state.status !== "connected";
      return withMeta(
        state,
        {
          status: "connected",
          instanceId: event.instanceId,
          reasonCode: null,
          detail: null,
          attempt: 0,
          resetNotificationBaseline: resetBaseline,
          quickSessionAvailable: event.quickSessionAvailable === true,
        },
        now,
      );
    }

    case "stream_lost":
      if (state.status === "service-not-running" || state.status === "incompatible") {
        return state;
      }
      return withMeta(
        state,
        {
          status: "reconnecting",
          reasonCode: "stream_error",
          detail: clampDetail(event.detail),
          attempt: state.attempt + 1,
        },
        now,
      );

    case "instance_changed":
      return withMeta(
        state,
        {
          status: "reconnecting",
          instanceId: event.instanceId,
          reasonCode: "instance_changed",
          detail: null,
          resetNotificationBaseline: true,
          quickSessionAvailable: false,
          attempt: state.attempt + 1,
        },
        now,
      );

    case "token_rejected":
      return withMeta(
        state,
        {
          status: "reconnecting",
          reasonCode: "token_rejected",
          detail: null,
          resetNotificationBaseline: true,
          attempt: state.attempt + 1,
        },
        now,
      );

    case "quit":
      // Local teardown marker only — does not imply service stop.
      return withMeta(
        state,
        {
          status: "service-not-running",
          reasonCode: null,
          detail: "desktop_quit",
          instanceId: null,
          attempt: 0,
          resetNotificationBaseline: true,
          quickSessionAvailable: false,
        },
        now,
      );

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/** After the first connected snapshot is applied for notifications, clear the baseline flag. */
export function acknowledgeConnectionBaseline(
  state: DesktopConnectionState,
  now = Date.now(),
): DesktopConnectionState {
  if (!state.resetNotificationBaseline) return state;
  return withMeta(state, { resetNotificationBaseline: false }, now);
}

export function isServiceNotRunning(state: DesktopConnectionState): boolean {
  return state.status === "service-not-running";
}

export function canCopyStartCommand(state: DesktopConnectionState): boolean {
  return state.status === "service-not-running" || state.status === "incompatible";
}

function clampDetail(detail: string | undefined | null): string | null {
  if (!detail) return null;
  const trimmed = detail.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed.length > 160 ? `${trimmed.slice(0, 159)}…` : trimmed;
}
