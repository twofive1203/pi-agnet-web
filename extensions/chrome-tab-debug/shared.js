/** Shared constants/helpers for the Snail Pi Chrome extension. */

// Redaction helpers are generated from lib/browser-redaction.ts — single source of truth.
export {
  isSensitiveHeaderName,
  redactHeaders,
  redactUrl,
  isSensitiveFieldName,
  isSensitiveControl,
  truncateText,
  sanitizeConsoleText,
  sanitizeConsoleValue,
  summarizeAuditParams,
  networkSummarySafe,
} from "./redaction.js";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 62667;
export const PAIR_API = (port) => `http://127.0.0.1:${port}/api/browser/pair`;
export const BINDINGS_API = (port) => `http://127.0.0.1:${port}/api/browser/bindings`;
export const STATUS_API = (port) => `http://127.0.0.1:${port}/api/browser/status`;
export const MAX_ENVELOPE_AGE_MS = 5 * 60_000;
export const MAX_FRAME_BYTES = 512 * 1024;
export const MAX_SCREENSHOT_BASE64_CHARS = 360_000;

// Snail Pi HTTP API lives on the web UI port; bridge WS uses browser bridge port.
export const DEFAULT_WEB_PORT = 62666;

export function normalizePairingCode(code) {
  return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isRestrictedUrl(url) {
  if (!url) return true;
  try {
    const u = new URL(url);
    if (u.protocol === "chrome:" || u.protocol === "chrome-extension:" || u.protocol === "edge:" || u.protocol === "about:") {
      return true;
    }
    if (u.protocol === "devtools:") return true;
    return false;
  } catch {
    return true;
  }
}

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export function isEnvelopeFresh(timestamp, now = Date.now()) {
  return typeof timestamp === "number" && Number.isFinite(timestamp) && Math.abs(now - timestamp) <= MAX_ENVELOPE_AGE_MS;
}

/**
 * Final authorization gate: every command must match extension-owned session binding.
 *
 * @param {object} state session binding store
 * @param {object} payload command payload
 * @param {object} [params] command params (routing identities under __*)
 * @param {object} [options]
 * @param {"command"|"manage"} [options.mode="command"]
 *   - command: page/debug ops — require session/tab/document/origin identities; active only
 *   - manage: revoke/disable_debug — require binding + session ownership; allow suspended
 */
export function authorizeLocalBinding(state, payload, params = {}, options = {}) {
  const mode = options.mode === "manage" ? "manage" : "command";
  const bindingId = payload?.bindingId;
  if (!bindingId || typeof bindingId !== "string") {
    return { ok: false, code: "BINDING_NOT_FOUND", message: "bindingId required" };
  }
  const binding = state?.bindings?.[bindingId];
  if (!binding) {
    return { ok: false, code: "BINDING_NOT_FOUND", message: "No local binding authorization" };
  }

  // sessionId is always required for authorization — never optional.
  if (typeof payload.sessionId !== "string" || !payload.sessionId) {
    return { ok: false, code: "BINDING_NOT_FOUND", message: "sessionId required" };
  }
  if (binding.sessionId && payload.sessionId !== binding.sessionId) {
    return { ok: false, code: "BINDING_NOT_FOUND", message: "sessionId does not own binding" };
  }

  if (mode === "command") {
    // Routing identity fields are required for all page/debug commands.
    if (typeof params.__tabId !== "number") {
      return { ok: false, code: "DOCUMENT_CHANGED", message: "tabId routing identity required" };
    }
    if (binding.tabId !== params.__tabId) {
      return { ok: false, code: "DOCUMENT_CHANGED", message: "tabId does not match binding" };
    }
    if (typeof params.__documentId !== "string" || !params.__documentId) {
      return { ok: false, code: "DOCUMENT_CHANGED", message: "documentId routing identity required" };
    }
    if (binding.documentId && params.__documentId !== binding.documentId) {
      return { ok: false, code: "DOCUMENT_CHANGED", message: "documentId does not match binding" };
    }
    if (typeof params.__origin !== "string" || !params.__origin) {
      return { ok: false, code: "BINDING_SUSPENDED", message: "origin routing identity required" };
    }
    if (binding.origin && params.__origin !== binding.origin) {
      return { ok: false, code: "BINDING_SUSPENDED", message: "origin does not match binding" };
    }
    if (binding.state === "suspended") {
      return { ok: false, code: "BINDING_SUSPENDED", message: "Binding is suspended" };
    }
    if (binding.state === "revoked" || binding.state === "expired") {
      return { ok: false, code: "BINDING_NOT_FOUND", message: "Binding is not active" };
    }
    if (binding.state !== "active_dom" && binding.state !== "active_debug") {
      return { ok: false, code: "BINDING_NOT_FOUND", message: `Binding state ${binding.state} is not operable` };
    }
    return { ok: true, binding };
  }

  // manage mode: revoke / disable_debug — ownership gate before any debugger side effects.
  if (typeof params.__tabId === "number" && binding.tabId != null && binding.tabId !== params.__tabId) {
    return { ok: false, code: "DOCUMENT_CHANGED", message: "tabId does not match binding" };
  }
  if (binding.state === "revoked" || binding.state === "expired") {
    return { ok: false, code: "BINDING_NOT_FOUND", message: "Binding is not active" };
  }
  return { ok: true, binding };
}

export function bindingHasCapability(binding, capability) {
  if (!binding) return false;
  if (binding.state !== "active_dom" && binding.state !== "active_debug") return false;
  return Array.isArray(binding.capabilities) && binding.capabilities.includes(capability);
}

export async function getLocalInstall() {
  const data = await chrome.storage.local.get([
    "clientId",
    "installationSecret",
    "webPort",
    "bridgePort",
    "pairedAt",
  ]);
  if (!data.clientId || !data.installationSecret) return null;
  return {
    clientId: data.clientId,
    installationSecret: data.installationSecret,
    webPort: data.webPort || DEFAULT_WEB_PORT,
    bridgePort: data.bridgePort || DEFAULT_PORT,
    pairedAt: data.pairedAt || 0,
  };
}

export async function setLocalInstall(install) {
  await chrome.storage.local.set(install);
}

export async function clearLocalInstall() {
  await chrome.storage.local.remove([
    "clientId",
    "installationSecret",
    "webPort",
    "bridgePort",
    "pairedAt",
  ]);
}

export async function getSessionBindings() {
  const data = await chrome.storage.session.get([
    "bindings",
    "primaryBySession",
    "debugConsent",
    "pendingRequest",
    "pendingRequests",
  ]);
  const pendingRequests = Array.isArray(data.pendingRequests)
    ? data.pendingRequests
    : (data.pendingRequest ? [data.pendingRequest] : []);
  return {
    bindings: data.bindings || {},
    primaryBySession: data.primaryBySession || {},
    debugConsent: data.debugConsent || {},
    pendingRequest: data.pendingRequest || (pendingRequests.length === 1 ? pendingRequests[0] : null),
    pendingRequests,
  };
}

export async function setSessionBindings(state) {
  const pendingRequests = Array.isArray(state.pendingRequests)
    ? state.pendingRequests
    : (state.pendingRequest ? [state.pendingRequest] : []);
  await chrome.storage.session.set({
    bindings: state.bindings || {},
    primaryBySession: state.primaryBySession || {},
    debugConsent: state.debugConsent || {},
    pendingRequests,
    pendingRequest: pendingRequests.length === 1 ? pendingRequests[0] : null,
  });
}

export async function resetTemporaryState() {
  await chrome.storage.session.set({
    bindings: {},
    primaryBySession: {},
    debugConsent: {},
    pendingRequest: null,
    pendingRequests: [],
  });
}
