/**
 * Browser Binding Manager — session-scoped temporary tab authorizations.
 * Routes commands only to the extension client that owns a binding.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  BrowserControlError,
  DEFAULT_PENDING_BINDING_TTL_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  clampTimeoutMs,
  formatBrowserToolError,
  toBindingView,
  type BrowserBindingRecord,
  type BrowserBindingView,
  type BrowserCapability,
  type BrowserCommandName,
  type BrowserCommandResponse,
  type BrowserEventPayload,
  type PendingBindingRequest,
  bindingHasCapability,
  browserResponseBudget,
  serializedBrowserResponseBytes,
  validateBrowserSnapshotParams,
  validateBrowserWaitParams,
  validateBrowserActParams,
  type BrowserExtensionFeature,
} from "./browser-protocol";
import {
  acceptBinding,
  clearAllBindings,
  closeBinding,
  createBindingStore,
  createPendingRequest,
  crossOriginNavigation,
  disableDebug,
  enableDebug,
  expirePendingRequests,
  getPrimaryBindingId,
  listSessionBindings,
  requireBinding,
  resolveTargetBinding,
  resumeBinding,
  revokeBinding,
  revokeSessionBindings,
  sameOriginNavigation,
  setPrimaryBinding,
  snapshotBindingStore,
  suspendBinding,
  touchBinding,
  type BindingStore,
} from "./browser-binding-state";
import { ensureBrowserBridgeStarted, getBrowserBridge, type BrowserBridge } from "./browser-bridge";
import { readBrowserBridgeState, unpairInstallation } from "./browser-pairing";
import { recordBrowserAudit } from "./browser-audit";
import { redactUrl, summarizeAuditParams } from "./browser-redaction";

export type BrowserSessionStatus = {
  featureEnabled: boolean;
  bridge: ReturnType<BrowserBridge["getStatus"]>;
  pendingRequest: PendingBindingRequest | null;
  bindings: BrowserBindingView[];
  primaryBindingId: string | null;
};

export type BrowserToolCommandInput = {
  sessionId: string;
  command: BrowserCommandName;
  bindingId?: string;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  requiredCapability?: BrowserCapability;
  requiredExtensionFeatures?: BrowserExtensionFeature[];
};

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export class BrowserBindingManager {
  private store: BindingStore = createBindingStore();
  private bridgeListenersAttached = false;
  private rateWindow = new Map<string, { count: number; resetAt: number }>();

  /** Idempotent bridge subscription (events + client request handler). */
  attachBridgeListeners(): void {
    if (this.bridgeListenersAttached) return;
    const bridge = getBrowserBridge();
    bridge.setClientRequestHandler(async (clientId, payload) => this.handleClientRequest(clientId, payload));
    bridge.onEvent((event) => {
      if (event.event === "extension.ready") {
        // Push reconciliation snapshot so extension clears stale session bindings after restart.
        void this.pushReconcile(event.clientId).catch(() => undefined);
        return;
      }
      if (event.event === "extension.disconnected") {
        // Outstanding requests already fail via bridge.
        return;
      }
      if (event.event === "debugger_detached" && event.bindingId) {
        const owned = this.requireOwnedBindingForEvent(event, event.bindingId);
        if (!owned) return;
        try {
          disableDebug(this.store, event.bindingId);
          recordBrowserAudit({
            action: "debugger_detached",
            status: "ok",
            bindingId: event.bindingId,
            sessionId: event.sessionId,
            clientId: event.clientId,
          });
        } catch {
          // ignore unknown binding
        }
        return;
      }
      if (
        (event.event === "binding.suspended"
          || event.event === "binding.updated"
          || event.event === "binding.resumed")
        && event.bindingId
      ) {
        const owned = this.requireOwnedBindingForEvent(event, event.bindingId);
        if (!owned) return;
        const data = event.data ?? {};
        try {
          if (event.event === "binding.suspended") {
            suspendBinding(this.store, event.bindingId, "cross_origin", {
              origin: typeof data.origin === "string" ? data.origin : undefined,
              title: typeof data.title === "string" ? data.title : undefined,
              url: typeof data.url === "string" ? data.url : undefined,
              documentId: typeof data.documentId === "string" ? data.documentId : undefined,
            });
          } else if (event.event === "binding.resumed") {
            // Explicit user re-confirmation from the extension only.
            if (typeof data.documentId === "string" && typeof data.origin === "string") {
              resumeBinding(this.store, event.bindingId, {
                documentId: data.documentId,
                origin: data.origin,
                url: typeof data.url === "string" ? data.url : data.origin,
                title: typeof data.title === "string" ? data.title : "",
              });
            }
          } else if (typeof data.documentId === "string") {
            const origin = typeof data.origin === "string" ? data.origin : "";
            const url = typeof data.url === "string" ? data.url : "";
            const title = typeof data.title === "string" ? data.title : "";
            // Passive binding.updated while suspended must not resume; metadata-only.
            if (owned.state === "suspended") {
              sameOriginNavigation(this.store, event.bindingId, {
                documentId: data.documentId,
                origin: origin || owned.origin,
                url: url || owned.url,
                title: title || owned.title,
              });
            } else if (origin && owned.origin && origin !== owned.origin) {
              crossOriginNavigation(this.store, event.bindingId, {
                documentId: data.documentId,
                origin,
                url,
                title,
              });
            } else {
              sameOriginNavigation(this.store, event.bindingId, {
                documentId: data.documentId,
                origin: origin || owned.origin,
                url: url || owned.url,
                title: title || owned.title,
              });
            }
          }
        } catch {
          // ignore
        }
        return;
      }
      if (event.event === "binding.revoked" && event.bindingId) {
        const owned = this.requireOwnedBindingForEvent(event, event.bindingId);
        if (!owned) return;
        try {
          if (event.data?.reason === "tab_closed") {
            closeBinding(this.store, event.bindingId);
          } else {
            revokeBinding(this.store, event.bindingId);
          }
        } catch {
          // ignore
        }
      }
    });
    this.bridgeListenersAttached = true;
  }

  async ensureReady(): Promise<void> {
    const state = readBrowserBridgeState();
    if (!state.enabled) {
      throw new BrowserControlError("FEATURE_DISABLED", "Browser control is disabled in settings");
    }
    await ensureBrowserBridgeStarted(state.port);
    this.attachBridgeListeners();
  }

  getPublicStatus(sessionId?: string): BrowserSessionStatus {
    const state = readBrowserBridgeState();
    const bridge = getBrowserBridge().getStatus();
    expirePendingRequests(this.store);
    let pendingRequest: PendingBindingRequest | null = null;
    let bindings: BrowserBindingView[] = [];
    let primaryBindingId: string | null = null;
    if (sessionId) {
      pendingRequest = [...this.store.pendingById.values()].find((p) => p.sessionId === sessionId) ?? null;
      primaryBindingId = getPrimaryBindingId(this.store, sessionId);
      bindings = listSessionBindings(this.store, sessionId).map((b) => toBindingView(b, primaryBindingId));
    }
    return {
      featureEnabled: state.enabled,
      bridge,
      pendingRequest,
      bindings,
      primaryBindingId,
    };
  }

  createPendingBindingRequest(input: {
    sessionId: string;
    sessionLabel?: string;
    ttlMs?: number;
  }): PendingBindingRequest {
    if (!input.sessionId || input.sessionId.startsWith("new-")) {
      throw new BrowserControlError("INVALID_FRAME", "A real session id is required before binding a tab");
    }
    expirePendingRequests(this.store);
    // Replace existing pending for session.
    for (const [id, pending] of this.store.pendingById) {
      if (pending.sessionId === input.sessionId) this.store.pendingById.delete(id);
    }
    const pending = createPendingRequest(this.store, {
      pendingRequestId: newId("pend"),
      sessionId: input.sessionId,
      sessionLabel: input.sessionLabel?.trim() || input.sessionId.slice(0, 8),
      requestedCapabilities: ["dom"],
      ttlMs: input.ttlMs ?? DEFAULT_PENDING_BINDING_TTL_MS,
    });
    recordBrowserAudit({
      action: "binding.request",
      status: "ok",
      sessionId: input.sessionId,
      params: { pendingRequestId: pending.pendingRequestId, expiresAt: pending.expiresAt },
    });
    // Notify paired extensions over authenticated channel (no HTTP accept).
    void this.broadcastEvent("binding.pending", {
      pendingRequestId: pending.pendingRequestId,
      sessionId: pending.sessionId,
      sessionLabel: pending.sessionLabel,
      expiresAt: pending.expiresAt,
      requestedCapabilities: pending.requestedCapabilities,
    }).catch(() => undefined);
    return pending;
  }

  /** All non-expired pending bind requests, newest first. */
  listOpenPendingRequests(): PendingBindingRequest[] {
    expirePendingRequests(this.store);
    const now = Date.now();
    return [...this.store.pendingById.values()]
      .filter((p) => p.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((p) => ({ ...p, requestedCapabilities: [...p.requestedCapabilities] }));
  }

  /**
   * Session-scoped pending lookup. Without sessionId, returns null when multiple
   * sessions have open requests (avoids cross-session bind mistakes).
   */
  getOpenPendingRequest(sessionId?: string): PendingBindingRequest | null {
    const all = this.listOpenPendingRequests();
    if (sessionId) {
      return all.find((p) => p.sessionId === sessionId) ?? null;
    }
    // Backward-compatible single-pending shortcut only when unambiguous.
    return all.length === 1 ? all[0]! : null;
  }

  /**
   * Accept a pending bind only from an authenticated paired extension client.
   * clientId must come from the bridge auth context — never from an untrusted HTTP body alone.
   */
  acceptPendingFromExtension(input: {
    pendingRequestId: string;
    clientId: string;
    tabId: number;
    documentId: string;
    origin: string;
    title: string;
    url: string;
    /** When true, caller proved extension channel auth (WS). Required for production accept. */
    authenticatedClient?: boolean;
  }): BrowserBindingView {
    if (!input.authenticatedClient) {
      throw new BrowserControlError(
        "AUTH_FAILED",
        "Binding acceptance requires the authenticated extension channel",
      );
    }
    if (!input.clientId || typeof input.tabId !== "number" || !Number.isInteger(input.tabId) || input.tabId < 0) {
      throw new BrowserControlError("INVALID_FRAME", "Invalid extension accept payload");
    }
    // Ensure pending exists and is still open before acceptBinding consumes it.
    expirePendingRequests(this.store);
    const pending = this.store.pendingById.get(input.pendingRequestId);
    if (!pending) {
      throw new BrowserControlError("BINDING_NOT_FOUND", "Pending binding request not found or expired");
    }
    if (!pending.sessionId || pending.sessionId.startsWith("new-")) {
      throw new BrowserControlError("INVALID_FRAME", "Pending request is not tied to a real session");
    }
    if (!getBrowserBridge().isClientConnected(input.clientId)) {
      throw new BrowserControlError("BRIDGE_DISCONNECTED", "Extension client is not connected");
    }

    const binding = acceptBinding(this.store, {
      bindingId: newId("bind"),
      pendingRequestId: input.pendingRequestId,
      clientId: input.clientId,
      tabId: input.tabId,
      documentId: input.documentId,
      origin: input.origin,
      title: input.title,
      url: input.url,
    });
    const primary = getPrimaryBindingId(this.store, binding.sessionId);
    recordBrowserAudit({
      action: "binding.accept",
      status: "ok",
      sessionId: binding.sessionId,
      bindingId: binding.bindingId,
      clientId: input.clientId,
      params: { origin: binding.origin, url: redactUrl(binding.url) },
    });
    return toBindingView(binding, primary);
  }

  listBindings(sessionId: string): BrowserBindingView[] {
    const primary = getPrimaryBindingId(this.store, sessionId);
    return listSessionBindings(this.store, sessionId).map((b) => toBindingView(b, primary));
  }

  setPrimary(sessionId: string, bindingId: string): BrowserBindingView[] {
    setPrimaryBinding(this.store, sessionId, bindingId);
    recordBrowserAudit({ action: "binding.set_primary", status: "ok", sessionId, bindingId });
    return this.listBindings(sessionId);
  }

  revoke(sessionId: string, bindingId?: string): BrowserBindingView[] {
    if (bindingId) {
      const binding = requireBinding(this.store, bindingId);
      if (binding.sessionId !== sessionId) {
        throw new BrowserControlError("BINDING_NOT_FOUND", "Binding does not belong to this session");
      }
      void this.notifyExtension(binding, "binding.revoke", {}).catch(() => undefined);
      revokeBinding(this.store, bindingId);
      recordBrowserAudit({ action: "binding.revoke", status: "ok", sessionId, bindingId });
    } else {
      const bindings = listSessionBindings(this.store, sessionId);
      for (const binding of bindings) {
        void this.notifyExtension(binding, "binding.revoke", {}).catch(() => undefined);
      }
      revokeSessionBindings(this.store, sessionId);
      recordBrowserAudit({ action: "binding.revoke_all", status: "ok", sessionId });
    }
    return this.listBindings(sessionId);
  }

  /** Called when a Pi session is destroyed or forked away. */
  invalidateSession(sessionId: string): void {
    const bindings = listSessionBindings(this.store, sessionId);
    for (const binding of bindings) {
      void this.notifyExtension(binding, "binding.revoke", { reason: "session_end" }).catch(() => undefined);
    }
    revokeSessionBindings(this.store, sessionId);
    for (const [id, pending] of this.store.pendingById) {
      if (pending.sessionId === sessionId) this.store.pendingById.delete(id);
    }
    recordBrowserAudit({ action: "session.invalidate", status: "ok", sessionId });
  }

  async enableDebug(sessionId: string, bindingId: string): Promise<BrowserBindingView> {
    const binding = this.requireSessionBinding(sessionId, bindingId);
    const response = await this.dispatch(binding, "binding.enable_debug", {});
    if (!response.ok) throw this.responseError(response);
    const updated = enableDebug(this.store, bindingId);
    const primary = getPrimaryBindingId(this.store, sessionId);
    recordBrowserAudit({ action: "binding.enable_debug", status: "ok", sessionId, bindingId });
    return toBindingView(updated, primary);
  }

  async disableDebug(sessionId: string, bindingId: string): Promise<BrowserBindingView> {
    const binding = this.requireSessionBinding(sessionId, bindingId);
    const response = await this.dispatch(binding, "binding.disable_debug", {});
    if (!response.ok) {
      // Still downgrade locally if extension failed after detach race.
      disableDebug(this.store, bindingId);
      throw this.responseError(response);
    }
    const updated = disableDebug(this.store, bindingId);
    const primary = getPrimaryBindingId(this.store, sessionId);
    recordBrowserAudit({ action: "binding.disable_debug", status: "ok", sessionId, bindingId });
    return toBindingView(updated, primary);
  }

  resumeSuspended(
    sessionId: string,
    bindingId: string,
    patch: { documentId: string; origin: string; title: string; url: string },
  ): BrowserBindingView {
    const binding = this.requireSessionBinding(sessionId, bindingId, { allowSuspended: true });
    if (binding.state !== "suspended") {
      throw new BrowserControlError("INVALID_FRAME", "Binding is not suspended");
    }
    const updated = resumeBinding(this.store, bindingId, patch);
    const primary = getPrimaryBindingId(this.store, sessionId);
    return toBindingView(updated, primary);
  }

  async runToolCommand(input: BrowserToolCommandInput): Promise<unknown> {
    try {
      return await this.runToolCommandInternal(input);
    } catch (error) {
      const formatted = formatBrowserToolError(error);
      recordBrowserAudit({
        action: `tool.${input.command}`,
        status: "error",
        code: formatted.code,
        sessionId: input.sessionId,
        bindingId: input.bindingId,
        params: summarizeAuditParams(input.params),
      });
      throw error;
    }
  }

  private async runToolCommandInternal(input: BrowserToolCommandInput): Promise<unknown> {
    await this.ensureReady();
    this.consumeRateLimit(`tool:${input.sessionId}`, 60, 60_000);

    if (input.command === "binding.list") {
      return { bindings: this.listBindings(input.sessionId) };
    }
    if (input.command === "binding.set_primary") {
      const bindingId = typeof input.params?.bindingId === "string" ? input.params.bindingId : input.bindingId;
      if (!bindingId) throw new BrowserControlError("BINDING_NOT_FOUND", "bindingId is required");
      return { bindings: this.setPrimary(input.sessionId, bindingId) };
    }

    if (input.command === "page.act") validateBrowserActParams(input.params ?? {});
    if (input.command === "page.snapshot") validateBrowserSnapshotParams(input.params ?? {});
    if (input.command === "page.wait") validateBrowserWaitParams(input.params ?? {});

    const binding = this.resolveBinding(input.sessionId, input.bindingId);
    if (input.requiredCapability && !bindingHasCapability(binding, input.requiredCapability)) {
      throw new BrowserControlError(
        binding.state === "active_dom" && input.requiredCapability === "debug_readonly"
          ? "CAPABILITY_REQUIRED"
          : "CAPABILITY_UNAVAILABLE",
        `Capability ${input.requiredCapability} is not available on this binding`,
      );
    }
    const advertisedFeatures = getBrowserBridge().getClientExtensionFeatures(binding.clientId);
    const missingFeatures = (input.requiredExtensionFeatures ?? [])
      .filter((feature) => !advertisedFeatures.includes(feature));
    if (missingFeatures.length > 0) {
      throw new BrowserControlError(
        "UNSUPPORTED_EXTENSION_CAPABILITY",
        `Connected extension does not advertise: ${missingFeatures.join(", ")}`,
        { missingFeatures, advertisedFeatures },
      );
    }

    const response = await this.dispatch(
      binding,
      input.command,
      input.params ?? {},
      { signal: input.signal, timeoutMs: input.timeoutMs },
    );
    if (!response.ok) throw this.responseError(response);
    const budget = browserResponseBudget(input.command);
    if (budget !== null) {
      const bytes = serializedBrowserResponseBytes(response.result);
      if (bytes > budget) {
        throw new BrowserControlError(
          "OUTPUT_LIMIT_EXCEEDED",
          `Browser response exceeded ${budget} bytes`,
          { command: input.command, bytes, budget },
        );
      }
    }
    touchBinding(this.store, binding.bindingId);
    recordBrowserAudit({
      action: `tool.${input.command}`,
      status: "ok",
      sessionId: input.sessionId,
      bindingId: binding.bindingId,
      clientId: binding.clientId,
      params: summarizeAuditParams(input.params),
    });
    return response.result;
  }

  /** Bridge restart policy: drop temporary bindings. */
  resetTemporaryState(): void {
    clearAllBindings(this.store);
    recordBrowserAudit({ action: "manager.reset", status: "ok" });
  }

  /** Bindings owned by a connected extension client (for reconcile snapshots). */
  listBindingsForClient(clientId: string): BrowserBindingRecord[] {
    return [...this.store.byId.values()]
      .filter((b) => b.clientId === clientId && b.state !== "closed")
      .map((b) => ({ ...b, capabilities: [...b.capabilities] }));
  }

  private async handleClientRequest(
    clientId: string,
    payload: Record<string, unknown>,
  ): Promise<BrowserCommandResponse> {
    const command = typeof payload.command === "string" ? payload.command : "";
    const params = (payload.params && typeof payload.params === "object" && !Array.isArray(payload.params))
      ? payload.params as Record<string, unknown>
      : {};

    try {
      if (command === "binding.closed") {
        const bindingId = typeof params.bindingId === "string" ? params.bindingId : "";
        const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
        if (!bindingId || !sessionId) throw new BrowserControlError("INVALID_FRAME", "binding.closed missing bindingId/sessionId");
        const owned = this.store.byId.get(bindingId);
        if (!owned || owned.clientId !== clientId || owned.sessionId !== sessionId) {
          throw new BrowserControlError("BINDING_NOT_FOUND", "Closed binding is not owned by this client");
        }
        closeBinding(this.store, bindingId);
        return { ok: true, result: { closed: true, bindingId } };
      }

      if (command === "binding.accept") {
        const pendingRequestId = typeof params.pendingRequestId === "string" ? params.pendingRequestId : "";
        const tabId = typeof params.tabId === "number" ? params.tabId : Number.NaN;
        const documentId = typeof params.documentId === "string" ? params.documentId : "";
        const origin = typeof params.origin === "string" ? params.origin : "";
        const title = typeof params.title === "string" ? params.title : "";
        const url = typeof params.url === "string" ? params.url : "";
        if (!pendingRequestId || !Number.isInteger(tabId) || !documentId || !origin || !url) {
          throw new BrowserControlError("INVALID_FRAME", "binding.accept missing required fields");
        }
        const view = this.acceptPendingFromExtension({
          pendingRequestId,
          clientId, // from authenticated WS — not caller-forged
          tabId,
          documentId,
          origin,
          title,
          url,
          authenticatedClient: true,
        });
        // Include internal fields only for the extension (not model tools).
        const full = this.store.byId.get(view.bindingId);
        return {
          ok: true,
          result: {
            binding: view,
            sessionId: full?.sessionId,
            tabId: full?.tabId,
            documentId: full?.documentId,
            origin: full?.origin,
            capabilities: full?.capabilities,
            state: full?.state,
          },
        };
      }

      if (command === "binding.pending") {
        const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
        const pendings = sessionId
          ? this.listOpenPendingRequests().filter((p) => p.sessionId === sessionId)
          : this.listOpenPendingRequests();
        return {
          ok: true,
          result: {
            pendings,
            // Unambiguous single pending only; multi-session must pick explicitly.
            pending: pendings.length === 1 ? pendings[0] : (sessionId ? pendings[0] ?? null : null),
          },
        };
      }

      if (command === "reconcile") {
        const bindings = this.listBindingsForClient(clientId);
        const pendings = this.listOpenPendingRequests();
        const primaryBySession = Object.fromEntries(
          [...new Set(bindings.map((binding) => binding.sessionId))]
            .map((sessionId) => [sessionId, getPrimaryBindingId(this.store, sessionId)]),
        );
        return {
          ok: true,
          result: {
            bindings: bindings.map((b) => ({
              bindingId: b.bindingId,
              sessionId: b.sessionId,
              tabId: b.tabId,
              documentId: b.documentId,
              origin: b.origin,
              title: b.title,
              url: b.url,
              capabilities: b.capabilities,
              state: b.state,
            })),
            primaryBySession,
            pendings,
            pending: pendings.length === 1 ? pendings[0] : null,
          },
        };
      }

      throw new BrowserControlError("INVALID_FRAME", `Unsupported client command: ${command}`);
    } catch (error) {
      const formatted = formatBrowserToolError(error);
      return {
        ok: false,
        error: {
          code: formatted.code,
          message: formatted.message,
          recovery: formatted.recovery,
          details: formatted.details,
        },
      };
    }
  }

  private async pushReconcile(clientId: string): Promise<void> {
    const bridge = getBrowserBridge();
    if (!bridge.isClientConnected(clientId)) return;
    const bindings = this.listBindingsForClient(clientId);
    const pendings = this.listOpenPendingRequests();
    const primaryBySession = Object.fromEntries(
      [...new Set(bindings.map((binding) => binding.sessionId))]
        .map((sessionId) => [sessionId, getPrimaryBindingId(this.store, sessionId)]),
    );
    await bridge.sendCommand(
      clientId,
      {
        command: "reconcile",
        sessionId: "",
        params: {
          bindings: bindings.map((b) => ({
            bindingId: b.bindingId,
            sessionId: b.sessionId,
            tabId: b.tabId,
            documentId: b.documentId,
            origin: b.origin,
            title: b.title,
            url: b.url,
            capabilities: b.capabilities,
            state: b.state,
          })),
          primaryBySession,
          pendings,
          pending: pendings.length === 1 ? pendings[0] : null,
        },
      },
      { timeoutMs: 5_000 },
    );
  }

  private async broadcastEvent(event: BrowserEventPayload["event"] | "binding.pending", data: Record<string, unknown>): Promise<void> {
    const bridge = getBrowserBridge();
    const status = bridge.getStatus();
    for (const client of status.connectedClients) {
      try {
        await bridge.sendEvent(client.clientId, {
          event: event as BrowserEventPayload["event"],
          data,
          sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
        });
      } catch {
        // ignore per-client failures
      }
    }
  }

  unpairClient(clientId: string): void {
    // Revoke bindings for client
    for (const binding of [...this.store.byId.values()]) {
      if (binding.clientId === clientId) {
        try { revokeBinding(this.store, binding.bindingId); } catch { /* ignore */ }
      }
    }
    unpairInstallation(clientId);
    recordBrowserAudit({ action: "installation.unpair", status: "ok", clientId });
  }

  exportSnapshot() {
    return snapshotBindingStore(this.store);
  }

  /**
   * Binding-scoped lifecycle events must come from the owning extension client
   * and carry the binding's sessionId. Reject forged multi-client transitions.
   */
  private requireOwnedBindingForEvent(
    event: { clientId: string; sessionId?: string },
    bindingId: string,
  ): BrowserBindingRecord | null {
    try {
      const binding = requireBinding(this.store, bindingId);
      if (binding.clientId !== event.clientId) return null;
      if (typeof event.sessionId !== "string" || event.sessionId !== binding.sessionId) return null;
      return binding;
    } catch {
      return null;
    }
  }

  private requireSessionBinding(
    sessionId: string,
    bindingId: string,
    options?: { allowSuspended?: boolean },
  ): BrowserBindingRecord {
    const binding = requireBinding(this.store, bindingId);
    if (binding.sessionId !== sessionId) {
      throw new BrowserControlError("BINDING_NOT_FOUND", "Binding does not belong to this session");
    }
    if (binding.state === "closed") {
      throw new BrowserControlError("TAB_CLOSED", "The browser tab was closed");
    }
    if (!options?.allowSuspended && binding.state === "suspended") {
      throw new BrowserControlError("BINDING_SUSPENDED", "Binding is suspended");
    }
    return { ...binding, capabilities: [...binding.capabilities] };
  }

  private resolveBinding(sessionId: string, bindingId?: string): BrowserBindingRecord {
    return resolveTargetBinding(this.store, sessionId, bindingId);
  }

  private async dispatch(
    binding: BrowserBindingRecord,
    command: BrowserCommandName,
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<BrowserCommandResponse> {
    const bridge = getBrowserBridge();
    if (!bridge.isClientConnected(binding.clientId)) {
      throw new BrowserControlError("BRIDGE_DISCONNECTED", "Owning extension is not connected");
    }
    const commandTimeoutMs = clampTimeoutMs(options?.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
    const transportTimeoutMs = command === "page.wait" ? commandTimeoutMs + 2_000 : commandTimeoutMs;
    return bridge.sendCommand(
      binding.clientId,
      {
        command,
        sessionId: binding.sessionId,
        bindingId: binding.bindingId,
        params: {
          ...params,
          // Internal routing fields for extension; never returned to model.
          __tabId: binding.tabId,
          __documentId: binding.documentId,
          __origin: binding.origin,
        },
        deadlineMs: commandTimeoutMs,
      },
      {
        timeoutMs: transportTimeoutMs,
        timeoutCode: command === "page.wait" ? "WAIT_TIMEOUT" : "REQUEST_TIMEOUT",
        abortCode: command === "page.wait" ? "REQUEST_CANCELLED" : "REQUEST_TIMEOUT",
        signal: options?.signal,
        requestId: randomUUID(),
      },
    );
  }

  private async notifyExtension(
    binding: BrowserBindingRecord,
    command: BrowserCommandName,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      const bridge = getBrowserBridge();
      if (!bridge.isClientConnected(binding.clientId)) return;
      await bridge.sendCommand(
        binding.clientId,
        {
          command,
          sessionId: binding.sessionId,
          bindingId: binding.bindingId,
          params: {
            ...params,
            __tabId: binding.tabId,
            __documentId: binding.documentId,
            __origin: binding.origin,
          },
        },
        { timeoutMs: 5_000 },
      );
    } catch {
      // best-effort
    }
  }

  private responseError(response: BrowserCommandResponse): BrowserControlError {
    const code = response.error?.code ?? "INTERNAL_ERROR";
    const rawDetails = response.error?.details;
    let details: Record<string, unknown> | undefined;
    if (rawDetails) {
      try {
        details = serializedBrowserResponseBytes(rawDetails) <= 8 * 1024
          ? rawDetails
          : { truncated: true };
      } catch {
        details = { truncated: true };
      }
    }
    return new BrowserControlError(
      code,
      String(response.error?.message ?? code).slice(0, 1_000),
      details,
    );
  }

  private consumeRateLimit(key: string, max: number, windowMs: number): void {
    const now = Date.now();
    const current = this.rateWindow.get(key);
    if (!current || current.resetAt <= now) {
      this.rateWindow.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    current.count += 1;
    if (current.count > max) {
      throw new BrowserControlError("RATE_LIMITED", "Too many browser tool calls");
    }
  }
}

export const PART1_BROWSER_EXTENSION_FEATURES: BrowserExtensionFeature[] = [
  "element_diagnostics_v1",
  "post_action_state_v1",
];
export const SEMANTIC_BROWSER_EXTENSION_FEATURE = "semantic_actions_v1" as const;

declare global {
  var __piBrowserBindingManager: BrowserBindingManager | undefined;
}

export function getBrowserBindingManager(): BrowserBindingManager {
  if (!globalThis.__piBrowserBindingManager) {
    globalThis.__piBrowserBindingManager = new BrowserBindingManager();
  }
  // Attach listeners eagerly so extension.ready reconcile works even before ensureReady().
  try {
    globalThis.__piBrowserBindingManager.attachBridgeListeners();
  } catch {
    // bridge may not exist yet
  }
  return globalThis.__piBrowserBindingManager;
}

export function formatToolErrorResult(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError: true;
} {
  const formatted = formatBrowserToolError(error);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        error: formatted.code,
        message: formatted.message,
        recovery: formatted.recovery,
        details: formatted.details,
      }, null, 2),
    }],
    details: formatted,
    isError: true,
  };
}
