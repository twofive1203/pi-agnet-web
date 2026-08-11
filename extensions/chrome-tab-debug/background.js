/**
 * MV3 service worker: pairing, WebSocket bridge, binding lifecycle, tool routing.
 * Final browser authorization gate lives here — never trust server tab metadata alone.
 */

import {
  BINDINGS_API,
  DEFAULT_PORT,
  DEFAULT_WEB_PORT,
  EXTENSION_FEATURES,
  MAX_SCREENSHOT_BASE64_CHARS,
  PROTOCOL_VERSION,
  authorizeLocalBinding,
  bindingHasCapability,
  clearLocalInstall,
  getLocalInstall,
  getSessionBindings,
  isEnvelopeFresh,
  isRestrictedUrl,
  originOf,
  redactUrl,
  resetTemporaryState,
  sanitizeConsoleText,
  sanitizeConsoleValue,
  setLocalInstall,
  setSessionBindings,
  sha256Hex,
} from "./shared.js";

let socket = null;
let socketAuthenticated = false;
let reconnectAttempt = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
const debugBuffers = new Map(); // bindingId -> { console: [], network: [], tabId }
const recentMutations = new Map(); // requestId -> result
const recentInbound = new Map(); // requestId -> ts
/** @type {Map<string, { aborted: boolean, tabId?: number }>} */
const abortByRequest = new Map(); // requestId -> { aborted, tabId }
/** @type {Array<object>} */
let cachedPendings = [];

async function setBadge(text, color = "#f59e0b") {
  try {
    await chrome.action.setBadgeText({ text: text || "" });
    if (text) await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    // ignore
  }
}

function wsUrl(port) {
  return `ws://127.0.0.1:${port}`;
}

async function ensureContentScript(tabId) {
  // Policy IIFE must load before content.js so evaluateActionPolicy is available.
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ["action-policy.inject.js", "content.js"],
  });
}

function normalizePendings(resultOrParams) {
  if (!resultOrParams) return [];
  if (Array.isArray(resultOrParams.pendings)) {
    return resultOrParams.pendings.filter((p) => p && p.pendingRequestId);
  }
  if (resultOrParams.pending?.pendingRequestId) return [resultOrParams.pending];
  return [];
}

function pickPending(pendings, pendingRequestId) {
  if (!Array.isArray(pendings) || pendings.length === 0) return null;
  if (pendingRequestId) {
    return pendings.find((p) => p.pendingRequestId === pendingRequestId) || null;
  }
  // Only auto-select when a single pending exists — prevents cross-session mistakes.
  return pendings.length === 1 ? pendings[0] : null;
}

async function deliverCancelToTab(tabId, requestId) {
  if (typeof tabId !== "number" || !requestId) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      channel: "snail-pi-content-broadcast",
      type: "cancel",
      requestId,
    });
  } catch {
    // Tab may not have content script yet.
  }
}

async function sendToContent(tabId, type, params, requestId) {
  await ensureContentScript(tabId);
  return await chrome.tabs.sendMessage(tabId, {
    channel: "snail-pi-content",
    type,
    params,
    requestId,
  });
}

function sendSocket(obj) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const text = JSON.stringify(obj);
  if (text.length > 500_000) {
    console.warn("Snail Pi: dropping oversized outbound frame");
    return;
  }
  socket.send(text);
}

function formatPairHttpError(status, data) {
  const message = (data && typeof data.error === "string" && data.error) || "Pairing failed";
  const code = data && typeof data.code === "string" ? data.code : "";
  if (status === 401 || code === "unauthorized") {
    return "Snail Pi is in server mode and blocked extension pairing. Update Snail Pi (loopback pair bypass) or open the Web UI on 127.0.0.1 and retry.";
  }
  if (status === 403 || code === "forbidden" || /origin/i.test(message)) {
    return "Pairing was blocked by the server origin/auth gate. Ensure Snail Pi includes the loopback extension-pair bypass, then reload this extension.";
  }
  if (status === 426 || code === "secure_transport_required") {
    return "Server mode requires HTTPS for ordinary traffic; extension pairing must use loopback HTTP. Update Snail Pi or set PI_WEB_ALLOW_INSECURE_HTTP=1 for local trials.";
  }
  if (!status) return message;
  return `${message} (HTTP ${status}${code ? ` · ${code}` : ""})`;
}

async function pairWithCode(pairingCode, webPort = DEFAULT_WEB_PORT) {
  const normalizedCode = String(pairingCode || "").trim();
  if (!normalizedCode) throw new Error("Pairing code is required");
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${webPort}/api/browser/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "exchange",
        pairingCode: normalizedCode,
        extensionOrigin: chrome.runtime.getURL("").replace(/\/$/, ""),
        label: "Snail Pi Tab Debug",
      }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot reach Snail Pi at http://127.0.0.1:${webPort} (${detail}). Is the Web UI running locally?`);
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) throw new Error(formatPairHttpError(res.status, data));
  if (!data.clientId || !data.installationSecret) {
    throw new Error("Pairing response missing client credentials");
  }
  await setLocalInstall({
    clientId: data.clientId,
    installationSecret: data.installationSecret,
    webPort,
    bridgePort: data.port || DEFAULT_PORT,
    pairedAt: Date.now(),
  });
  await connectBridge();
  return data;
}

async function fetchConnectToken(install) {
  const res = await fetch(`http://127.0.0.1:${install.webPort}/api/browser/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "connect_token",
      clientId: install.clientId,
      installationSecret: install.installationSecret,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "connect_token failed");
  return data;
}

async function connectBridge() {
  const install = await getLocalInstall();
  if (!install) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  let token;
  try {
    token = await fetchConnectToken(install);
  } catch (error) {
    scheduleReconnect();
    console.warn("Snail Pi connect token failed", error);
    return;
  }

  const url = wsUrl(token.port || install.bridgePort);
  socketAuthenticated = false;
  const currentSocket = new WebSocket(url);
  socket = currentSocket;

  currentSocket.addEventListener("open", async () => {
    if (socket !== currentSocket) return;
    reconnectAttempt = 0;
    const response = await sha256Hex(`snail-pi-browser-v1:${token.nonce}:${token.connectToken}`);
    currentSocket.send(JSON.stringify({
      type: "auth",
      protocolVersion: PROTOCOL_VERSION,
      clientId: install.clientId,
      connectToken: token.connectToken,
      nonce: token.nonce,
      response,
      extensionFeatures: EXTENSION_FEATURES,
    }));
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (socket === currentSocket && socketAuthenticated && currentSocket.readyState === WebSocket.OPEN) {
        currentSocket.send(JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: "ping",
          requestId: crypto.randomUUID(),
          clientId: install.clientId,
          timestamp: Date.now(),
          payload: { t: Date.now() },
        }));
      }
    }, 20000);
  });

  currentSocket.addEventListener("message", (event) => {
    if (socket === currentSocket) {
      void onSocketMessage(String(event.data || ""));
    }
  });

  currentSocket.addEventListener("close", () => {
    if (socket !== currentSocket) return;
    socket = null;
    socketAuthenticated = false;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    scheduleReconnect();
  });

  currentSocket.addEventListener("error", () => {
    try { currentSocket.close(); } catch { /* ignore */ }
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(30_000, 1000 * (2 ** Math.min(reconnectAttempt, 5)));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectBridge();
  }, delay);
}

/**
 * Apply server reconcile snapshot after bridge/Snail Pi restart.
 * Clears stale temporary bindings that no longer exist server-side.
 */
async function applyReconcileSnapshot(params = {}) {
  const state = await getSessionBindings();
  const serverBindings = Array.isArray(params.bindings) ? params.bindings : [];
  const next = { bindings: {}, primaryBySession: {}, debugConsent: state.debugConsent || {}, pendingRequest: params.pending || null, closedBindings: state.closedBindings || {} };
  const allowed = new Set(serverBindings.map((b) => b.bindingId));
  for (const remote of serverBindings) {
    if (state.closedBindings?.[remote?.bindingId]) allowed.delete(remote.bindingId);
  }

  // Keep only bindings still authorized by the server for this client.
  for (const remote of serverBindings) {
    if (!remote?.bindingId || !allowed.has(remote.bindingId)) continue;
    const local = state.bindings[remote.bindingId] || {};
    next.bindings[remote.bindingId] = {
      bindingId: remote.bindingId,
      sessionId: remote.sessionId,
      tabId: remote.tabId ?? local.tabId,
      documentId: remote.documentId || local.documentId,
      origin: remote.origin || local.origin,
      title: remote.title || local.title || "",
      url: remote.url || local.url || "",
      capabilities: remote.capabilities || ["dom"],
      state: remote.state || "active_dom",
      contextId: local.contextId,
    };
  }

  // Detach debugger for removed bindings.
  for (const [bindingId, binding] of Object.entries(state.bindings)) {
    if (!allowed.has(bindingId)) {
      if (binding?.tabId != null) await detachDebugger(binding.tabId, bindingId);
      debugBuffers.delete(bindingId);
    }
  }

  // Prefer the server's primary projection; legacy servers fall back to insertion order.
  const serverPrimary = params.primaryBySession && typeof params.primaryBySession === "object"
    ? params.primaryBySession
    : {};
  for (const binding of Object.values(next.bindings)) {
    if (serverPrimary[binding.sessionId] === binding.bindingId) {
      next.primaryBySession[binding.sessionId] = binding.bindingId;
    }
  }
  for (const binding of Object.values(next.bindings)) {
    if (!next.primaryBySession[binding.sessionId]) {
      next.primaryBySession[binding.sessionId] = binding.bindingId;
    }
  }

  // Drop consent for gone bindings.
  for (const id of Object.keys(next.debugConsent)) {
    if (!next.bindings[id]) delete next.debugConsent[id];
  }

  const pendings = normalizePendings(params);
  cachedPendings = pendings;
  next.pendingRequest = pendings.length === 1 ? pendings[0] : null;
  next.pendingRequests = pendings;
  await setSessionBindings(next);
  if (Object.keys(next.bindings).length === 0 && pendings.length === 0) await setBadge("");
  else if (pendings.length > 0) await setBadge("!", "#f59e0b");
}

async function onSocketMessage(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.type === "auth_ok") {
    socketAuthenticated = true;
    await setBadge("", "#22c55e");
    // After auth, request/accept reconcile so restart cannot leave stale authorizations.
    try {
      const state = await getSessionBindings();
      const closed = Object.entries(state.closedBindings || {})
        .filter(([, entry]) => Date.now() - Number(entry?.closedAt || 0) <= 5 * 60_000);
      for (const [bindingId, entry] of closed) {
        try {
          await sendClientRequest("binding.closed", { bindingId, sessionId: entry.sessionId });
        } catch {
          // Retry on the next authenticated reconnect while the tombstone is fresh.
        }
      }
      const install = await getLocalInstall();
      if (install) {
        // Server also pushes reconcile command via manager; pull as backup.
        const pull = await sendClientRequest("reconcile", {});
        if (pull?.ok && pull.result) {
          await applyReconcileSnapshot(pull.result);
        }
      }
    } catch {
      // If reconcile fails (e.g. empty server after restart), clear temporary bindings.
      await resetTemporaryState();
      debugBuffers.clear();
      cachedPendings = [];
    }
    return;
  }
  if (!msg || msg.protocolVersion !== PROTOCOL_VERSION) return;
  const install = await getLocalInstall();
  if (!install || msg.clientId !== install.clientId) return;

  if (!isEnvelopeFresh(msg.timestamp)) {
    return;
  }

  if (msg.requestId && (msg.kind === "request" || msg.kind === "cancel" || msg.kind === "event")) {
    const prev = recentInbound.get(msg.requestId);
    if (prev && msg.kind !== "cancel") return; // drop replay
    recentInbound.set(msg.requestId, Date.now());
    if (recentInbound.size > 400) {
      const first = recentInbound.keys().next().value;
      recentInbound.delete(first);
    }
  }

  if (msg.kind === "ping") {
    sendSocket({
      protocolVersion: PROTOCOL_VERSION,
      kind: "pong",
      requestId: msg.requestId,
      clientId: install.clientId,
      timestamp: Date.now(),
      payload: { t: Date.now() },
    });
    return;
  }

  if (msg.kind === "cancel") {
    const handle = abortByRequest.get(msg.requestId);
    if (handle) handle.aborted = true;
    // MV3: content scripts only receive tabs.sendMessage, not runtime.sendMessage.
    if (handle?.tabId != null) {
      void deliverCancelToTab(handle.tabId, msg.requestId);
    } else {
      // Fallback: notify every bound tab (still better than runtime broadcast).
      try {
        const state = await getSessionBindings();
        const tabIds = new Set(
          Object.values(state.bindings || {})
            .map((b) => b?.tabId)
            .filter((id) => typeof id === "number"),
        );
        for (const tabId of tabIds) {
          void deliverCancelToTab(tabId, msg.requestId);
        }
      } catch {
        // ignore
      }
    }
    return;
  }

  if (msg.kind === "event") {
    const payload = msg.payload || {};
    if (payload.event === "binding.pending") {
      const data = payload.data || null;
      if (data?.pendingRequestId) {
        // Upsert by pendingRequestId; keep multi-session pendings distinct.
        const rest = cachedPendings.filter((p) => p.pendingRequestId !== data.pendingRequestId);
        cachedPendings = [data, ...rest];
      }
      const state = await getSessionBindings();
      state.pendingRequests = cachedPendings;
      state.pendingRequest = cachedPendings.length === 1 ? cachedPendings[0] : null;
      await setSessionBindings(state);
      await setBadge("!", "#f59e0b");
    }
    return;
  }

  if (msg.kind === "request") {
    const result = await handleCommand(msg.requestId, msg.payload || {});
    sendSocket({
      protocolVersion: PROTOCOL_VERSION,
      kind: "response",
      requestId: msg.requestId,
      clientId: install.clientId,
      timestamp: Date.now(),
      payload: result,
    });
  }
}

async function sendClientRequest(command, params = {}) {
  const install = await getLocalInstall();
  if (!install || !socket || socket.readyState !== WebSocket.OPEN || !socketAuthenticated) {
    throw new Error("Extension bridge is not authenticated");
  }
  const requestId = crypto.randomUUID();
  const envelope = {
    protocolVersion: PROTOCOL_VERSION,
    kind: "request",
    requestId,
    clientId: install.clientId,
    timestamp: Date.now(),
    payload: { command, params },
  };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Client request timeout"));
    }, 15_000);
    const onMessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data || ""));
        if (msg.kind === "response" && msg.requestId === requestId) {
          cleanup();
          resolve(msg.payload);
        }
      } catch {
        // ignore
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket?.removeEventListener("message", onMessage);
    };
    socket.addEventListener("message", onMessage);
    sendSocket(envelope);
  });
}

  function errorResult(code, message, details) {
  return {
    ok: false,
    error: {
      code,
      message: String(message || code).slice(0, 1_000),
      recovery: recoveryForError(code),
      ...(details ? { details } : {}),
    },
  };
}

function recoveryForError(code) {
  if (code === "STALE_ELEMENT_REF") return "Run browser_find again and use a fresh elementRef.";
  if (code === "WRONG_ELEMENT_CONTEXT") return "Run browser_find on the selected binding and use its elementRef.";
  if (code === "ELEMENT_HIDDEN") return "Wait for the element to become visible or choose a visible control.";
  if (code === "ELEMENT_DISABLED") return "Wait for the control to become enabled or complete its prerequisite.";
  if (code === "ELEMENT_COVERED") return "Dismiss the covering UI or scroll the target into view, then retry.";
  if (code === "WAIT_TIMEOUT") return "Inspect the compact current state, then narrow the condition or retry.";
  if (code === "WAIT_CANCELLED" || code === "REQUEST_CANCELLED") return "The wait was cancelled; issue a new wait if needed.";
  if (code === "INVALID_SELECTOR") return "Use a valid bounded CSS selector and retry.";
  if (code === "INVALID_WAIT_CONDITION") return "Use a supported wait condition with the required value or selector.";
  return "See Snail Pi browser tool error recovery guidance.";
}

function actionErrorDetails(result, fallbackMeta) {
  const details = result?.details && typeof result.details === "object" ? result.details : {};
  return {
    reason: typeof details.reason === "string" ? details.reason.slice(0, 80) : undefined,
    action: typeof details.action === "string" ? details.action.slice(0, 40) : undefined,
    url: redactUrl(String(fallbackMeta?.url || "")).slice(0, 2_000),
    title: String(fallbackMeta?.title || "").slice(0, 200),
    documentId: String(fallbackMeta?.documentId || "").slice(0, 300),
  };
}

function stateSignature(state) {
  return JSON.stringify([
    state?.documentId,
    state?.url,
    state?.title,
    state?.readyState,
    state?.mutationVersion,
    state?.focus?.role,
    state?.focus?.name,
  ]);
}

function compactPageState(state) {
  return {
    url: redactUrl(String(state?.url || "")).slice(0, 2_000),
    title: String(state?.title || "").slice(0, 200),
    documentId: String(state?.documentId || "").slice(0, 300),
    contextId: String(state?.contextId || "").slice(0, 40),
    readyState: String(state?.readyState || "unknown").slice(0, 20),
    mutationVersion: Number(state?.mutationVersion) || 0,
    focus: state?.focus ? {
      role: String(state.focus.role || "").slice(0, 40),
      name: String(state.focus.name || "").slice(0, 120),
      sensitive: Boolean(state.focus.sensitive),
    } : null,
  };
}

function changeIndicators(before, after) {
  const focusBefore = JSON.stringify(before?.focus || null);
  const focusAfter = JSON.stringify(after?.focus || null);
  const urlChanged = String(before?.url || "") !== String(after?.url || "");
  const documentChanged = String(before?.documentId || "") !== String(after?.documentId || "");
  const focusChanged = focusBefore !== focusAfter;
  const domChanged = documentChanged || Number(before?.mutationVersion || 0) !== Number(after?.mutationVersion || 0);
  return { changed: urlChanged || documentChanged || focusChanged || domChanged, urlChanged, documentChanged, focusChanged, domChanged };
}

function sanitizeStateForAction(state, input) {
  const safe = JSON.parse(JSON.stringify(state || {}));
  const submitted = typeof input?.text === "string" ? input.text : "";
  if (submitted) {
    const submittedValues = [submitted];
    try {
      const encoded = encodeURIComponent(submitted);
      if (encoded !== submitted) submittedValues.push(encoded);
    } catch {
      // Keep the raw value as the only scrub token.
    }
    const scrub = (value) => typeof value === "string"
      ? submittedValues.reduce((current, token) => current.split(token).join("[redacted]"), value)
      : value;
    safe.url = scrub(safe.url);
    safe.title = scrub(safe.title);
    if (safe.focus) safe.focus.name = scrub(safe.focus.name);
  }
  return safe;
}

async function collectPostActionState(tabId, binding, before, actionParams) {
  const deadline = Date.now() + 800;
  let previousSignature = "";
  let stableReads = 0;
  let latest = before;
  await new Promise((resolve) => setTimeout(resolve, 75));

  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      return {
        stabilization: "pending",
        state: compactPageState(sanitizeStateForAction(latest, actionParams)),
        changes: { ...changeIndicators(before, latest), tabClosed: true },
      };
    }
    const tabUrl = tab.url || latest?.url || binding.url || "";
    const currentOrigin = originOf(tabUrl);
    if (currentOrigin && binding.origin && currentOrigin !== binding.origin) {
      const crossOriginState = {
        ...latest,
        url: tabUrl,
        title: tab.title || latest?.title || "",
        documentId: "",
        readyState: tab.status || "loading",
      };
      return {
        stabilization: "pending",
        state: compactPageState(sanitizeStateForAction(crossOriginState, actionParams)),
        changes: changeIndicators(before, crossOriginState),
      };
    }
    try {
      latest = await sendToContent(tabId, "state", {}, undefined);
    } catch {
      latest = { ...latest, url: tabUrl, title: tab.title || latest?.title || "", readyState: tab.status || "loading" };
    }
    const signature = stateSignature(latest);
    stableReads = signature === previousSignature ? stableReads + 1 : 0;
    previousSignature = signature;
    const tabStatus = String(tab.status || "");
    if (stableReads >= 1 && tabStatus === "complete" && latest?.readyState === "complete") {
      return {
        stabilization: "settled",
        state: compactPageState(sanitizeStateForAction(latest, actionParams)),
        changes: changeIndicators(before, latest),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }

  return {
    stabilization: "pending",
    state: compactPageState(sanitizeStateForAction(latest, actionParams)),
    changes: changeIndicators(before, latest),
  };
}

async function handleCommand(requestId, payload) {
  if (recentMutations.has(requestId)) return recentMutations.get(requestId);

  const command = payload.command;
  const params = payload.params || {};
  const cancelHandle = { aborted: false, tabId: undefined };
  abortByRequest.set(requestId, cancelHandle);

  try {
    if (command === "binding.closed") {
      const bindingId = typeof params.bindingId === "string" ? params.bindingId : "";
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
      if (!bindingId || !sessionId) return errorResult("INVALID_FRAME", "binding.closed requires bindingId and sessionId");
      const state = await getSessionBindings();
      const binding = state.bindings[bindingId];
      if (!binding || binding.sessionId !== sessionId) return errorResult("BINDING_NOT_FOUND", "Closed binding is not owned by session");
      delete state.bindings[bindingId];
      state.closedBindings = state.closedBindings || {};
      state.closedBindings[bindingId] = { closedAt: Date.now(), sessionId };
      for (const [ownerSessionId, primary] of Object.entries(state.primaryBySession)) {
        if (primary === bindingId) delete state.primaryBySession[ownerSessionId];
      }
      if (state.debugConsent) delete state.debugConsent[bindingId];
      debugBuffers.delete(bindingId);
      await setSessionBindings(state);
      return { ok: true, result: { closed: true, bindingId } };
    }

    if (command === "ping") {
      const state = await getSessionBindings();
      return { ok: true, result: { bindings: Object.values(state.bindings) } };
    }

    if (command === "reconcile") {
      await applyReconcileSnapshot(params);
      const state = await getSessionBindings();
      const pendings = Array.isArray(state.pendingRequests)
        ? state.pendingRequests
        : normalizePendings({ pending: state.pendingRequest });
      return {
        ok: true,
        result: {
          bindings: Object.values(state.bindings),
          pendings,
          pending: pendings.length === 1 ? pendings[0] : null,
        },
      };
    }

    if (command === "binding.revoke") {
      const state = await getSessionBindings();
      const auth = authorizeLocalBinding(state, payload, params, { mode: "manage" });
      if (!auth.ok) return errorResult(auth.code, auth.message);
      await revokeLocalBinding(auth.binding.bindingId);
      return { ok: true, result: { revoked: true } };
    }

    if (command === "binding.enable_debug") {
      const state = await getSessionBindings();
      const auth = authorizeLocalBinding(state, payload, params);
      if (!auth.ok) return errorResult(auth.code, auth.message);
      const binding = auth.binding;
      const consent = state.debugConsent?.[binding.bindingId];
      const hasPerm = await chrome.permissions.contains({ permissions: ["debugger"] });
      if (!hasPerm || !consent) {
        return errorResult(
          "CAPABILITY_REQUIRED",
          "Enable debug mode in the extension popup (grants optional debugger permission and local consent)",
        );
      }
      try {
        await attachDebugger(binding.tabId, binding.bindingId);
      } catch (error) {
        return mapDebuggerError(error);
      }
      binding.capabilities = Array.from(new Set([...(binding.capabilities || []), "debug_readonly", "dom"]));
      binding.state = "active_debug";
      state.bindings[binding.bindingId] = binding;
      await setSessionBindings(state);
      return { ok: true, result: { enabled: true } };
    }

    if (command === "binding.disable_debug") {
      // Authorize before any debugger detach / capability mutation.
      const state = await getSessionBindings();
      const auth = authorizeLocalBinding(state, payload, params, { mode: "manage" });
      if (!auth.ok) return errorResult(auth.code, auth.message);
      const binding = auth.binding;
      if (binding.tabId != null) await detachDebugger(binding.tabId, binding.bindingId);
      debugBuffers.delete(binding.bindingId);
      binding.capabilities = ["dom"];
      if (binding.state === "active_debug") binding.state = "active_dom";
      state.bindings[binding.bindingId] = binding;
      if (state.debugConsent) delete state.debugConsent[binding.bindingId];
      await setSessionBindings(state);
      return { ok: true, result: { disabled: true } };
    }

    // All page/debug commands require strict local authorization with routing identities.
    const state = await getSessionBindings();
    const auth = authorizeLocalBinding(state, payload, params);
    if (!auth.ok) return errorResult(auth.code, auth.message);
    const binding = auth.binding;
    const tabId = binding.tabId;
    if (typeof tabId !== "number") return errorResult("NO_BOUND_TAB", "No tab for command");
    // Track tab so bridge cancel can reach the content script via tabs.sendMessage.
    cancelHandle.tabId = tabId;

    if (command === "page.console" || command === "page.network") {
      if (!bindingHasCapability(binding, "debug_readonly")) {
        return errorResult("CAPABILITY_REQUIRED", "debug_readonly capability required");
      }
    }

    if (cancelHandle.aborted) return errorResult(command === "page.wait" ? "REQUEST_CANCELLED" : "REQUEST_TIMEOUT", "Browser command aborted");

    if (command === "page.snapshot") {
      const result = await sendToContent(tabId, "snapshot", params, requestId);
      if (result?.error) return errorResult(result.error, result.message);
      if (result?.contextId) {
        binding.contextId = String(result.contextId).slice(0, 40);
        state.bindings[binding.bindingId] = binding;
        await setSessionBindings(state);
      }
      return { ok: true, result };
    }
    if (command === "page.find") {
      const result = await sendToContent(tabId, "find", params, requestId);
      if (result?.error) return errorResult(result.error, result.message);
      if (result?.contextId) {
        binding.contextId = String(result.contextId).slice(0, 40);
        state.bindings[binding.bindingId] = binding;
        await setSessionBindings(state);
      }
      return { ok: true, result };
    }
    if (command === "page.act") {
      let before;
      try {
        before = await sendToContent(tabId, "state", {}, requestId);
      } catch {
        before = {
          documentId: binding.documentId,
          url: binding.url,
          title: binding.title,
          readyState: "unknown",
          mutationVersion: 0,
          focus: null,
        };
      }
      const refMatch = /^el_([^_]+)_\d+$/.exec(String(params.elementRef || ""));
      if (refMatch && before?.contextId && refMatch[1] !== before.contextId) {
        const belongsToOtherBinding = Object.values(state.bindings || {}).some((candidate) => (
          candidate?.bindingId !== binding.bindingId && candidate?.contextId === refMatch[1]
        ));
        const code = belongsToOtherBinding ? "WRONG_ELEMENT_CONTEXT" : "STALE_ELEMENT_REF";
        const message = belongsToOtherBinding
          ? "elementRef belongs to another binding context"
          : "elementRef belongs to an expired document context";
        return errorResult(code, message, actionErrorDetails({
          details: { reason: belongsToOtherBinding ? "wrong_context" : "document_changed" },
        }, before));
      }
      binding.contextId = before?.contextId || binding.contextId;
      state.bindings[binding.bindingId] = binding;
      await setSessionBindings(state);
      const result = await sendToContent(tabId, "act", params, requestId);
      if (result?.error) {
        return errorResult(result.error, result.message, actionErrorDetails(result, before));
      }
      const postAction = await collectPostActionState(tabId, binding, before, params);
      const out = { ok: true, result: { action: params.action, completed: true, postAction } };
      if (params.action && params.action !== "highlight") {
        recentMutations.set(requestId, out);
        if (recentMutations.size > 200) {
          const first = recentMutations.keys().next().value;
          recentMutations.delete(first);
        }
      }
      return out;
    }
    if (command === "page.wait") {
      const result = await sendToContent(tabId, "wait", params, requestId);
      if (result?.error) {
        const details = {
          condition: typeof params.condition === "string" ? params.condition : undefined,
          elapsedMs: Number(result.waitedMs) || undefined,
          state: result.state ? compactPageState(result.state) : undefined,
        };
        return errorResult(result.error, result.message, details);
      }
      if (cancelHandle.aborted) return errorResult("REQUEST_CANCELLED", "Browser wait cancelled");
      return { ok: true, result };
    }
    if (command === "page.screenshot") {
      return await captureScreenshot(tabId, params);
    }
    if (command === "page.console") {
      const buf = debugBuffers.get(binding.bindingId)?.console || [];
      const since = typeof params.since === "number" ? params.since : 0;
      const limit = Math.min(200, Number(params.limit) || 50);
      const levels = Array.isArray(params.levels) ? new Set(params.levels) : null;
      const items = buf
        .filter((item) => item.ts >= since && (!levels || levels.has(item.level)))
        .slice(-limit)
        .map((item) => ({
          ...item,
          text: sanitizeConsoleText(item.text || "", 2000),
        }));
      return { ok: true, result: { items, count: items.length } };
    }
    if (command === "page.network") {
      const buf = debugBuffers.get(binding.bindingId)?.network || [];
      const since = typeof params.since === "number" ? params.since : 0;
      const limit = Math.min(200, Number(params.limit) || 50);
      let items = buf.filter((item) => item.startedAt >= since);
      if (params.status === "failed") items = items.filter((i) => i.failed);
      if (params.status === "4xx") items = items.filter((i) => i.status >= 400 && i.status < 500);
      if (params.status === "5xx") items = items.filter((i) => i.status >= 500);
      if (Array.isArray(params.resourceTypes) && params.resourceTypes.length) {
        const set = new Set(params.resourceTypes);
        items = items.filter((i) => set.has(i.resourceType));
      }
      items = items.slice(-limit).map((item) => ({
        ...item,
        url: redactUrl(item.url || ""),
        errorText: item.errorText ? sanitizeConsoleText(item.errorText, 400) : undefined,
      }));
      return { ok: true, result: { items, count: items.length } };
    }

    return errorResult("INVALID_FRAME", `Unsupported command ${command}`);
  } catch (error) {
    return errorResult("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
  } finally {
    abortByRequest.delete(requestId);
  }
}

function mapDebuggerError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/already attached|another debugger|detached|not attached|Cannot access|permission/i.test(message)) {
    return errorResult("CAPABILITY_UNAVAILABLE", message);
  }
  return errorResult("CAPABILITY_UNAVAILABLE", message);
}

async function hasDebuggerPermission() {
  try {
    return await chrome.permissions.contains({ permissions: ["debugger"] });
  } catch {
    return false;
  }
}

async function attachDebugger(tabId, bindingId) {
  const permitted = await hasDebuggerPermission();
  if (!permitted) {
    throw new Error("Optional debugger permission not granted");
  }
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already attached/i.test(message)) {
      // Treat contention / foreign attach as unavailable rather than silently reusing.
      throw new Error("Debugger already attached by another client");
    }
    throw error;
  }
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  await chrome.debugger.sendCommand({ tabId }, "Log.enable");
  if (!debugBuffers.has(bindingId)) {
    debugBuffers.set(bindingId, { console: [], network: [], tabId, requestMethods: new Map() });
  } else {
    const buf = debugBuffers.get(bindingId);
    buf.tabId = tabId;
    if (!buf.requestMethods) buf.requestMethods = new Map();
  }
}

const MAX_TRACKED_NETWORK_REQUESTS = 500;

function rememberNetworkMethod(buf, requestId, method) {
  if (!buf.requestMethods) buf.requestMethods = new Map();
  if (!requestId) return;
  buf.requestMethods.set(requestId, {
    method: method || "GET",
    ts: Date.now(),
  });
  // Bound the map and drop oldest entries first.
  while (buf.requestMethods.size > MAX_TRACKED_NETWORK_REQUESTS) {
    const oldest = buf.requestMethods.keys().next().value;
    buf.requestMethods.delete(oldest);
  }
}

function peekNetworkMethod(buf, requestId) {
  if (!buf.requestMethods || !requestId) return "GET";
  const entry = buf.requestMethods.get(requestId);
  if (!entry) return "GET";
  return entry.method || "GET";
}

function takeNetworkMethod(buf, requestId) {
  if (!buf.requestMethods || !requestId) return "GET";
  const entry = buf.requestMethods.get(requestId);
  if (!entry) return "GET";
  buf.requestMethods.delete(requestId);
  return entry.method || "GET";
}

async function detachDebugger(tabId, bindingId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // ignore
  }
  if (bindingId) {
    debugBuffers.delete(bindingId);
    try {
      const state = await getSessionBindings();
      const binding = state.bindings[bindingId];
      if (binding) {
        binding.capabilities = ["dom"];
        if (binding.state === "active_debug") binding.state = "active_dom";
        state.bindings[bindingId] = binding;
        await setSessionBindings(state);
      }
    } catch {
      // ignore
    }
  }
}

async function readImageDimensions(dataUrl) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(blob);
      const dims = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return dims;
    }
  } catch {
    // fall through
  }
  return { width: 0, height: 0 };
}

async function captureScreenshot(tabId, params) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId != null) {
    try { await chrome.tabs.update(tabId, { active: true }); } catch { /* ignore */ }
  }
  let format = params.format === "png" ? "png" : "jpeg";
  let quality = typeof params.quality === "number" ? Math.max(30, Math.min(90, params.quality)) : 70;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format,
      quality: format === "jpeg" ? quality : undefined,
    });
    const comma = dataUrl.indexOf(",");
    const header = dataUrl.slice(0, comma);
    const base64 = dataUrl.slice(comma + 1);
    const mimeType = header.includes("image/jpeg") ? "image/jpeg" : "image/png";
    const dims = await readImageDimensions(dataUrl);

    // Ensure JSON envelope with base64 stays under bridge frame limit.
    if (base64.length <= MAX_SCREENSHOT_BASE64_CHARS) {
      return {
        ok: true,
        result: {
          mimeType,
          base64,
          width: dims.width,
          height: dims.height,
          url: redactUrl(tab.url || ""),
          origin: originOf(tab.url || ""),
          title: tab.title,
        },
      };
    }

    format = "jpeg";
    quality = Math.max(28, quality - 12);
  }

  return errorResult(
    "OUTPUT_LIMIT_EXCEEDED",
    `Screenshot exceeds transport limit (${MAX_SCREENSHOT_BASE64_CHARS} base64 chars). Narrow viewport or lower quality.`,
  );
}

chrome.debugger?.onEvent?.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (typeof tabId !== "number") return;
  let bindingId = null;
  for (const [id, buf] of debugBuffers) {
    if (buf.tabId === tabId) {
      bindingId = id;
      break;
    }
  }
  if (!bindingId) return;
  const buf = debugBuffers.get(bindingId);
  if (!buf) return;

  if (method === "Runtime.consoleAPICalled") {
    const level = params.type === "error" ? "error" : params.type === "warning" ? "warning" : params.type === "info" ? "info" : "log";
    const parts = (params.args || []).map((arg) => {
      if (arg?.value != null) return sanitizeConsoleValue(arg.value, 500);
      if (arg?.description) return sanitizeConsoleText(arg.description, 500);
      if (arg?.preview?.properties) {
        const preview = {};
        for (const p of arg.preview.properties.slice(0, 20)) {
          preview[p.name] = sanitizeConsoleValue(p.value ?? p.description ?? p.type, 200);
        }
        return preview;
      }
      return sanitizeConsoleText(String(arg?.type || "arg"), 100);
    });
    const text = sanitizeConsoleText(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "), 2000);
    buf.console.push({ ts: Date.now(), level, text });
    if (buf.console.length > 200) buf.console.shift();
  }
  if (method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails || {};
    const raw = details.exception?.description || details.text || details.exception?.value || "exception";
    // Redact stack frame URLs before joining so query credentials never leave the extension.
    const stack = details.stackTrace?.callFrames
      ? details.stackTrace.callFrames
        .map((f) => `${f.functionName || "?"}@${redactUrl(f.url || "")}:${f.lineNumber}`)
        .join("\n")
      : "";
    const text = sanitizeConsoleText(`${raw}\n${stack}`.trim(), 2000);
    buf.console.push({ ts: Date.now(), level: "error", text });
    if (buf.console.length > 200) buf.console.shift();
  }
  if (method === "Network.requestWillBeSent") {
    const req = params.request || {};
    rememberNetworkMethod(buf, params.requestId, req.method || "GET");
  }
  if (method === "Network.responseReceived") {
    const res = params.response || {};
    const url = redactUrl(res.url || "");
    // Peek only — keep requestId until loadingFinished/loadingFailed so a later
    // failure still reports the original method (e.g. POST, not default GET).
    const httpMethod = peekNetworkMethod(buf, params.requestId);
    buf.network.push({
      startedAt: Date.now(),
      url,
      method: httpMethod,
      status: res.status,
      resourceType: params.type || "other",
      failed: res.status >= 400,
      timingMs: res.timing?.receiveHeadersEnd,
    });
    if (buf.network.length > 200) buf.network.shift();
  }
  if (method === "Network.loadingFinished") {
    takeNetworkMethod(buf, params.requestId);
  }
  if (method === "Network.loadingFailed") {
    const httpMethod = takeNetworkMethod(buf, params.requestId);
    buf.network.push({
      startedAt: Date.now(),
      url: "",
      method: httpMethod,
      status: 0,
      resourceType: params.type || "other",
      failed: true,
      errorText: sanitizeConsoleText(String(params.errorText || "failed"), 400),
    });
    if (buf.network.length > 200) buf.network.shift();
  }
});

chrome.debugger?.onDetach?.addListener((source, reason) => {
  const tabId = source.tabId;
  void (async () => {
    const state = await getSessionBindings();
    let changed = false;
    for (const [bindingId, binding] of Object.entries(state.bindings)) {
      if (binding.tabId === tabId) {
        debugBuffers.delete(bindingId);
        binding.capabilities = ["dom"];
        if (binding.state === "active_debug") binding.state = "active_dom";
        if (state.debugConsent) delete state.debugConsent[bindingId];
        state.bindings[bindingId] = binding;
        changed = true;
        void emitEvent("debugger_detached", { bindingId, sessionId: binding.sessionId, reason });
      }
    }
    if (changed) await setSessionBindings(state);
  })();
});

async function emitEvent(event, data = {}) {
  const install = await getLocalInstall();
  if (!install || !socket || socket.readyState !== WebSocket.OPEN) return;
  sendSocket({
    protocolVersion: PROTOCOL_VERSION,
    kind: "event",
    requestId: crypto.randomUUID(),
    clientId: install.clientId,
    timestamp: Date.now(),
    payload: {
      event,
      bindingId: data.bindingId,
      sessionId: data.sessionId,
      data,
    },
  });
}

async function revokeLocalBinding(bindingId) {
  const state = await getSessionBindings();
  const binding = state.bindings[bindingId];
  if (binding?.tabId != null) await detachDebugger(binding.tabId, bindingId);
  delete state.bindings[bindingId];
  for (const [sessionId, primary] of Object.entries(state.primaryBySession)) {
    if (primary === bindingId) delete state.primaryBySession[sessionId];
  }
  if (state.debugConsent) delete state.debugConsent[bindingId];
  debugBuffers.delete(bindingId);
  await setSessionBindings(state);
}

async function acceptPendingForActiveTab(pendingRequestId) {
  const install = await getLocalInstall();
  if (!install) throw new Error("Extension is not paired");
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    await connectBridge();
    // brief wait for auth
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error("Extension bridge is not connected");
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error("No active tab");
  if (isRestrictedUrl(tab.url)) throw new Error("This page cannot be bound (restricted URL)");

  // Prefer WS pendings; fall back to authenticated HTTP pending list.
  let pendings = cachedPendings.slice();
  if (pendings.length === 0) {
    try {
      const pull = await sendClientRequest("binding.pending", {});
      pendings = normalizePendings(pull?.result);
      cachedPendings = pendings;
    } catch {
      pendings = [];
    }
  }
  if (pendings.length === 0) {
    const pendingRes = await fetch(BINDINGS_API(install.webPort), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "pending",
        clientId: install.clientId,
        installationSecret: install.installationSecret,
      }),
    });
    const pendingData = await pendingRes.json();
    if (!pendingRes.ok) throw new Error(pendingData.error || "Pending fetch failed");
    pendings = normalizePendings(pendingData);
    cachedPendings = pendings;
  }
  const pending = pickPending(pendings, pendingRequestId);
  if (!pending?.pendingRequestId) {
    if (pendings.length > 1) {
      throw new Error("Multiple sessions requested a tab — pick one session in the popup");
    }
    throw new Error("No pending bind request from Snail Pi");
  }

  await ensureContentScript(tab.id);
  const meta = await sendToContent(tab.id, "meta", {});

  // Acceptance travels over authenticated WS; server binds clientId from auth context.
  const accept = await sendClientRequest("binding.accept", {
    pendingRequestId: pending.pendingRequestId,
    tabId: tab.id,
    documentId: meta.documentId,
    origin: meta.origin || originOf(tab.url),
    title: meta.title || tab.title || "",
    url: meta.url || tab.url,
  });
  if (!accept?.ok) {
    throw new Error(accept?.error?.message || "Accept failed");
  }

  const result = accept.result || {};
  const bindingView = result.binding || {};
  const bindingId = bindingView.bindingId;
  if (!bindingId) throw new Error("Accept response missing bindingId");

  const state = await getSessionBindings();
  state.bindings[bindingId] = {
    bindingId,
    sessionId: result.sessionId || pending.sessionId,
    tabId: tab.id,
    documentId: result.documentId || meta.documentId,
    origin: result.origin || meta.origin || originOf(tab.url),
    title: meta.title || tab.title || "",
    url: meta.url || tab.url,
    capabilities: result.capabilities || bindingView.capabilities || ["dom"],
    state: result.state || bindingView.state || "active_dom",
  };
  if (!state.primaryBySession[state.bindings[bindingId].sessionId]) {
    state.primaryBySession[state.bindings[bindingId].sessionId] = bindingId;
  }
  cachedPendings = cachedPendings.filter((p) => p.pendingRequestId !== pending.pendingRequestId);
  state.pendingRequests = cachedPendings;
  state.pendingRequest = cachedPendings.length === 1 ? cachedPendings[0] : null;
  await setSessionBindings(state);
  await setBadge("ON", "#22c55e");
  return { binding: bindingView, pending };
}

async function grantDebugConsent(bindingId) {
  if (!bindingId) throw new Error("bindingId required");
  const granted = await chrome.permissions.request({ permissions: ["debugger"] });
  if (!granted) throw new Error("Debugger permission denied");
  const state = await getSessionBindings();
  if (!state.bindings[bindingId]) throw new Error("Unknown binding");
  state.debugConsent = state.debugConsent || {};
  state.debugConsent[bindingId] = { at: Date.now() };
  await setSessionBindings(state);
  return { ok: true, bindingId };
}

/** Explicit user confirmation required to resume a cross-origin suspended binding. */
async function resumeSuspendedBinding(bindingId) {
  if (!bindingId) throw new Error("bindingId required");
  const state = await getSessionBindings();
  const binding = state.bindings[bindingId];
  if (!binding) throw new Error("Unknown binding");
  if (binding.state !== "suspended") throw new Error("Binding is not suspended");
  if (typeof binding.tabId !== "number") throw new Error("No tab for binding");

  const tab = await chrome.tabs.get(binding.tabId);
  if (!tab?.url || isRestrictedUrl(tab.url)) throw new Error("This page cannot be bound (restricted URL)");

  await ensureContentScript(binding.tabId);
  const meta = await sendToContent(binding.tabId, "meta", {});
  const nextOrigin = meta.origin || originOf(meta.url || tab.url);
  const nextUrl = meta.url || tab.url;
  const nextTitle = meta.title || tab.title || binding.title || "";
  const nextDocumentId = meta.documentId;
  if (!nextDocumentId || !nextOrigin) throw new Error("Could not read page identity for resume");

  binding.documentId = nextDocumentId;
  binding.origin = nextOrigin;
  binding.url = nextUrl;
  binding.title = nextTitle;
  binding.capabilities = ["dom"];
  binding.state = "active_dom";
  state.bindings[bindingId] = binding;
  await setSessionBindings(state);
  await setBadge("ON", "#22c55e");
  await emitEvent("binding.resumed", {
    bindingId,
    sessionId: binding.sessionId,
    documentId: binding.documentId,
    origin: binding.origin,
    url: binding.url,
    title: binding.title,
  });
  return { ok: true, binding };
}

// Navigation tracking
chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const state = await getSessionBindings();
    for (const [bindingId, binding] of Object.entries(state.bindings)) {
      if (binding.tabId === tabId) {
        await detachDebugger(tabId, bindingId);
        delete state.bindings[bindingId];
        state.closedBindings = state.closedBindings || {};
        state.closedBindings[bindingId] = { closedAt: Date.now(), sessionId: binding.sessionId };
        if (state.debugConsent) delete state.debugConsent[bindingId];
        debugBuffers.delete(bindingId);
        await emitEvent("binding.revoked", { bindingId, sessionId: binding.sessionId, reason: "tab_closed" });
      }
    }
    await setSessionBindings(state);
  })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  void (async () => {
    const state = await getSessionBindings();
    for (const [bindingId, binding] of Object.entries(state.bindings)) {
      if (binding.tabId !== tabId) continue;
      const nextUrl = changeInfo.url || tab.url || binding.url;
      const nextOrigin = originOf(nextUrl);
      if (nextOrigin && binding.origin && nextOrigin !== binding.origin) {
        await detachDebugger(tabId, bindingId);
        binding.state = "suspended";
        binding.capabilities = ["dom"];
        binding.url = nextUrl;
        binding.origin = nextOrigin;
        binding.title = tab.title || binding.title;
        if (state.debugConsent) delete state.debugConsent[bindingId];
        await emitEvent("binding.suspended", {
          bindingId,
          sessionId: binding.sessionId,
          origin: nextOrigin,
          url: nextUrl,
          title: binding.title,
          documentId: `nav_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        });
      } else if (changeInfo.status === "complete") {
        try {
          const meta = await sendToContent(tabId, "meta", {});
          binding.documentId = meta.documentId;
          binding.title = meta.title || binding.title;
          binding.url = meta.url || binding.url;
          // While suspended, keep local metadata fresh but suppress passive binding.updated.
          // Resume requires explicit user confirmation (binding.resumed).
          if (binding.state === "suspended") {
            continue;
          }
          await emitEvent("binding.updated", {
            bindingId,
            sessionId: binding.sessionId,
            documentId: binding.documentId,
            origin: binding.origin,
            url: binding.url,
            title: binding.title,
          });
        } catch {
          // content may be unavailable briefly
        }
      }
    }
    await setSessionBindings(state);
  })();
});

// Popup messaging
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.channel !== "snail-pi-popup") return false;
  const run = async () => {
    if (message.type === "status") {
      const install = await getLocalInstall();
      const bindings = await getSessionBindings();
      let pendings = Array.isArray(bindings.pendingRequests) && bindings.pendingRequests.length
        ? bindings.pendingRequests
        : (cachedPendings.length ? cachedPendings : normalizePendings({ pending: bindings.pendingRequest }));
      if (install && socket && socket.readyState === WebSocket.OPEN && socketAuthenticated) {
        try {
          const pull = await sendClientRequest("binding.pending", {});
          const pulled = normalizePendings(pull?.result);
          if (pulled.length) {
            pendings = pulled;
            cachedPendings = pulled;
          }
        } catch {
          // keep cached
        }
      }
      const debuggerPermission = await hasDebuggerPermission();
      return {
        install: install ? { clientId: install.clientId, webPort: install.webPort, bridgePort: install.bridgePort, pairedAt: install.pairedAt } : null,
        connected: Boolean(socket && socket.readyState === WebSocket.OPEN && socketAuthenticated),
        bindings: Object.values(bindings.bindings),
        pendings,
        pending: pendings.length === 1 ? pendings[0] : null,
        debugConsent: bindings.debugConsent || {},
        debuggerPermission,
      };
    }
    if (message.type === "pair") {
      await pairWithCode(message.pairingCode, message.webPort || DEFAULT_WEB_PORT);
      return { ok: true };
    }
    if (message.type === "unpair") {
      const install = await getLocalInstall();
      if (install) {
        try {
          await fetch(`http://127.0.0.1:${install.webPort}/api/browser/unpair`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ clientId: install.clientId }),
          });
        } catch {
          // ignore
        }
      }
      try { socket?.close(); } catch { /* ignore */ }
      socket = null;
      socketAuthenticated = false;
      await clearLocalInstall();
      await resetTemporaryState();
      debugBuffers.clear();
      cachedPendings = [];
      await setBadge("");
      return { ok: true };
    }
    if (message.type === "accept") {
      return await acceptPendingForActiveTab(message.pendingRequestId);
    }
    if (message.type === "resume") {
      return await resumeSuspendedBinding(message.bindingId);
    }
    if (message.type === "grant_debug") {
      return await grantDebugConsent(message.bindingId);
    }
    if (message.type === "reconnect") {
      if (socket && !socketAuthenticated) {
        try { socket.close(); } catch { /* ignore */ }
        socket = null;
      }
      await connectBridge();
      return { ok: true };
    }
    if (message.type === "reset_temp") {
      await resetTemporaryState();
      debugBuffers.clear();
      return { ok: true };
    }
    return { error: "unknown" };
  };
  run().then(sendResponse).catch((error) => {
    sendResponse({ error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});

// Startup
void (async () => {
  const install = await getLocalInstall();
  if (install) await connectBridge();
})();
