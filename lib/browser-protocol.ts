/**
 * Shared contracts for the Snail Pi Chrome tab debugging bridge.
 * Model-facing types never include raw Chrome tabId or installation credentials.
 */

export const BROWSER_PROTOCOL_VERSION = 1 as const;

export const DEFAULT_BROWSER_BRIDGE_PORT = 62667;
export const DEFAULT_PAIRING_TTL_MS = 5 * 60_000;
export const DEFAULT_PENDING_BINDING_TTL_MS = 60_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const MAX_TOOL_TIMEOUT_MS = 120_000;
export const MAX_FRAME_BYTES = 512 * 1024;
export const MAX_SNAPSHOT_NODES = 400;
export const MAX_SNAPSHOT_DEPTH = 12;
export const MAX_TEXT_CHARS = 8_000;
export const MAX_FIND_RESULTS = 25;
/** Raw decoded screenshot budget before base64/envelope overhead. */
export const MAX_SCREENSHOT_BYTES = 350_000;
/** Max base64 payload chars so JSON envelope stays under MAX_FRAME_BYTES. */
export const MAX_SCREENSHOT_BASE64_CHARS = 360_000;
export const MAX_CONSOLE_EVENTS = 200;
export const MAX_NETWORK_EVENTS = 200;
/** Default serialized JSON budgets. Screenshot image payloads use their own budget. */
export const BROWSER_RESPONSE_BUDGETS = {
  compact: 16 * 1024,
  snapshot: 256 * 1024,
  diagnostics: 448 * 1024,
} as const;
export const RECENT_REQUEST_CACHE = 256;
/** Reject envelopes older/newer than this skew (replay + clock drift). */
export const MAX_ENVELOPE_AGE_MS = 5 * 60_000;
/** Max persistent audit file size before rotation. */
export const MAX_AUDIT_FILE_BYTES = 512 * 1024;
export const MAX_AUDIT_FILE_LINES = 2_000;

export type BrowserCapability = "dom" | "debug_readonly";

export const BROWSER_EXTENSION_FEATURES = [
  "element_diagnostics_v1",
  "post_action_state_v1",
] as const;
export type BrowserExtensionFeature = typeof BROWSER_EXTENSION_FEATURES[number];

export type BindingState =
  | "pending"
  | "active_dom"
  | "active_debug"
  | "suspended"
  | "revoked"
  | "expired";

export type BrowserEnvelopeKind =
  | "request"
  | "response"
  | "event"
  | "cancel"
  | "ping"
  | "pong";

export type BrowserErrorCode =
  | "NO_BOUND_TAB"
  | "BINDING_NOT_FOUND"
  | "BINDING_SUSPENDED"
  | "TAB_ALREADY_BOUND"
  | "TAB_CLOSED"
  | "DOCUMENT_CHANGED"
  | "STALE_ELEMENT_REF"
  | "WRONG_ELEMENT_CONTEXT"
  | "ELEMENT_HIDDEN"
  | "ELEMENT_DISABLED"
  | "ELEMENT_COVERED"
  | "CAPABILITY_REQUIRED"
  | "CAPABILITY_UNAVAILABLE"
  | "UNSUPPORTED_EXTENSION_CAPABILITY"
  | "ACTION_BLOCKED"
  | "BRIDGE_DISCONNECTED"
  | "REQUEST_TIMEOUT"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "PROTOCOL_MISMATCH"
  | "AUTH_FAILED"
  | "PAIRING_EXPIRED"
  | "PAIRING_INVALID"
  | "RATE_LIMITED"
  | "INVALID_FRAME"
  | "FEATURE_DISABLED"
  | "INTERNAL_ERROR";

export const BROWSER_ERROR_RECOVERY: Record<BrowserErrorCode, string> = {
  NO_BOUND_TAB: "Ask the user to connect a browser tab from Snail Pi, then retry.",
  BINDING_NOT_FOUND: "Refresh bindings with browser_tabs and choose a valid bindingId.",
  BINDING_SUSPENDED: "Ask the user to re-confirm the tab in the extension after navigation.",
  TAB_ALREADY_BOUND: "That tab is owned by another session; unbind it first or pick another tab.",
  TAB_CLOSED: "The tab was closed. Bind a new tab.",
  DOCUMENT_CHANGED: "Take a fresh browser_snapshot; previous element refs are invalid.",
  STALE_ELEMENT_REF: "Take a new browser_snapshot/browser_find and use a fresh elementRef.",
  WRONG_ELEMENT_CONTEXT: "Run browser_find on the selected binding and use the returned elementRef.",
  ELEMENT_HIDDEN: "Wait for the element to become visible or choose a visible control.",
  ELEMENT_DISABLED: "Wait for the control to become enabled or complete its prerequisite.",
  ELEMENT_COVERED: "Dismiss the covering UI or scroll the target into view, then retry.",
  CAPABILITY_REQUIRED: "Ask the user to enable the required capability (for example debug mode).",
  CAPABILITY_UNAVAILABLE: "Debugger is unavailable (possibly DevTools contention). Continue with DOM tools or re-enable debug mode.",
  UNSUPPORTED_EXTENSION_CAPABILITY: "Update the Snail Pi Chrome extension, reconnect it, and retry.",
  ACTION_BLOCKED: "Choose a safer control or ask the user to perform the sensitive action manually.",
  BRIDGE_DISCONNECTED: "Ensure the Chrome extension is paired and connected to local Snail Pi.",
  REQUEST_TIMEOUT: "Retry with a narrower action or increase wait specificity.",
  OUTPUT_LIMIT_EXCEEDED: "Narrow the query (depth/limit/format) and retry.",
  PROTOCOL_MISMATCH: "Update the Chrome extension or Snail Pi so protocol versions match.",
  AUTH_FAILED: "Re-pair the Chrome extension with a fresh pairing code.",
  PAIRING_EXPIRED: "Generate a new pairing code in Snail Pi settings.",
  PAIRING_INVALID: "Check the pairing code and try again.",
  RATE_LIMITED: "Wait briefly before retrying browser tools.",
  INVALID_FRAME: "The bridge rejected a malformed message; reconnect the extension.",
  FEATURE_DISABLED: "Enable browser control in Snail Pi settings.",
  INTERNAL_ERROR: "Inspect Snail Pi logs and retry after reconnecting the extension.",
};

export class BrowserControlError extends Error {
  readonly code: BrowserErrorCode;
  readonly recovery: string;
  readonly details?: Record<string, unknown>;

  constructor(code: BrowserErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "BrowserControlError";
    this.code = code;
    this.recovery = BROWSER_ERROR_RECOVERY[code];
    this.details = details;
  }
}

export type BrowserEnvelope = {
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION;
  kind: BrowserEnvelopeKind;
  requestId: string;
  clientId: string;
  timestamp: number;
  payload: unknown;
};

/** Internal binding record (server + extension). Never return tabId to the model. */
export type BrowserBindingRecord = {
  bindingId: string;
  sessionId: string;
  clientId: string;
  /** Chrome tab id — internal only */
  tabId: number;
  documentId: string;
  origin: string;
  title: string;
  url: string;
  capabilities: BrowserCapability[];
  state: BindingState;
  createdAt: number;
  lastValidatedAt: number;
  lastActiveAt: number;
};

/** Model-safe binding projection. */
export type BrowserBindingView = {
  bindingId: string;
  title: string;
  origin: string;
  url: string;
  state: BindingState;
  capabilities: BrowserCapability[];
  primary: boolean;
  lastActiveAt: number;
};

export type PendingBindingRequest = {
  pendingRequestId: string;
  sessionId: string;
  sessionLabel: string;
  requestedCapabilities: BrowserCapability[];
  createdAt: number;
  expiresAt: number;
};

export type BrowserCommandName =
  | "ping"
  | "reconcile"
  | "binding.accept"
  | "binding.list"
  | "binding.set_primary"
  | "binding.enable_debug"
  | "binding.disable_debug"
  | "binding.revoke"
  | "page.snapshot"
  | "page.find"
  | "page.act"
  | "page.wait"
  | "page.screenshot"
  | "page.console"
  | "page.network";

export type BrowserCommandRequest = {
  command: BrowserCommandName;
  sessionId: string;
  bindingId?: string;
  params?: Record<string, unknown>;
  deadlineMs?: number;
};

export type BrowserCommandResponse = {
  ok: boolean;
  result?: unknown;
  error?: {
    code: BrowserErrorCode;
    message: string;
    recovery: string;
    details?: Record<string, unknown>;
  };
};

export type BrowserEventName =
  | "binding.updated"
  | "binding.revoked"
  | "binding.suspended"
  | "binding.resumed"
  | "binding.pending"
  | "debugger_detached"
  | "extension.ready"
  | "extension.disconnected";

export type BrowserEventPayload = {
  event: BrowserEventName;
  sessionId?: string;
  bindingId?: string;
  data?: Record<string, unknown>;
};

export type PairingOffer = {
  pairingCode: string;
  expiresAt: number;
  port: number;
  host: "127.0.0.1";
};

export type InstallationCredentialRecord = {
  clientId: string;
  /** scrypt/sha256 verifier; never the raw secret */
  secretVerifier: string;
  createdAt: number;
  label?: string;
  extensionOrigin?: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createEnvelope(
  kind: BrowserEnvelopeKind,
  clientId: string,
  requestId: string,
  payload: unknown,
  timestamp = Date.now(),
): BrowserEnvelope {
  return {
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    kind,
    requestId,
    clientId,
    timestamp,
    payload,
  };
}

export function parseEnvelope(value: unknown): BrowserEnvelope {
  if (!isRecord(value)) {
    throw new BrowserControlError("INVALID_FRAME", "Envelope must be an object");
  }
  if (value.protocolVersion !== BROWSER_PROTOCOL_VERSION) {
    throw new BrowserControlError("PROTOCOL_MISMATCH", `Unsupported protocolVersion: ${String(value.protocolVersion)}`);
  }
  const kind = value.kind;
  if (
    kind !== "request"
    && kind !== "response"
    && kind !== "event"
    && kind !== "cancel"
    && kind !== "ping"
    && kind !== "pong"
  ) {
    throw new BrowserControlError("INVALID_FRAME", `Invalid envelope kind: ${String(kind)}`);
  }
  if (typeof value.requestId !== "string" || !value.requestId) {
    throw new BrowserControlError("INVALID_FRAME", "requestId is required");
  }
  if (typeof value.clientId !== "string" || !value.clientId) {
    throw new BrowserControlError("INVALID_FRAME", "clientId is required");
  }
  if (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) {
    throw new BrowserControlError("INVALID_FRAME", "timestamp must be a number");
  }
  return {
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    kind,
    requestId: value.requestId,
    clientId: value.clientId,
    timestamp: value.timestamp,
    payload: value.payload,
  };
}

export function toBindingView(
  binding: BrowserBindingRecord,
  primaryBindingId: string | null,
): BrowserBindingView {
  return {
    bindingId: binding.bindingId,
    title: binding.title,
    origin: binding.origin,
    url: binding.url,
    state: binding.state,
    capabilities: [...binding.capabilities],
    primary: primaryBindingId === binding.bindingId,
    lastActiveAt: binding.lastActiveAt,
  };
}

export function formatBrowserToolError(error: unknown): {
  code: BrowserErrorCode;
  message: string;
  recovery: string;
  details?: Record<string, unknown>;
} {
  if (error instanceof BrowserControlError) {
    return {
      code: error.code,
      message: error.message,
      recovery: error.recovery,
      details: error.details,
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    recovery: BROWSER_ERROR_RECOVERY.INTERNAL_ERROR,
  };
}

export function clampTimeoutMs(value: unknown, fallback = DEFAULT_TOOL_TIMEOUT_MS): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1_000, Math.min(MAX_TOOL_TIMEOUT_MS, Math.floor(value)));
}

export function isActiveBindingState(state: BindingState): boolean {
  return state === "active_dom" || state === "active_debug";
}

export function browserResponseBudget(command: BrowserCommandName): number | null {
  if (command === "page.screenshot") return null;
  if (command === "page.snapshot") return BROWSER_RESPONSE_BUDGETS.snapshot;
  if (command === "page.console" || command === "page.network") return BROWSER_RESPONSE_BUDGETS.diagnostics;
  return BROWSER_RESPONSE_BUDGETS.compact;
}

export function serializedBrowserResponseBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function bindingHasCapability(
  binding: Pick<BrowserBindingRecord, "capabilities" | "state">,
  capability: BrowserCapability,
): boolean {
  if (!isActiveBindingState(binding.state)) return false;
  return binding.capabilities.includes(capability);
}
