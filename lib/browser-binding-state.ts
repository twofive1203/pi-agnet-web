/**
 * Pure binding state machine and ownership invariants for browser tab control.
 * No I/O — unit-testable transitions only.
 */

import {
  BrowserControlError,
  type BindingState,
  type BrowserBindingRecord,
  type BrowserCapability,
  type PendingBindingRequest,
  isActiveBindingState,
} from "./browser-protocol";

export type BindingStoreSnapshot = {
  bindings: BrowserBindingRecord[];
  /** sessionId -> primary bindingId */
  primaryBySession: Record<string, string | null>;
  pending: PendingBindingRequest[];
};

export type BindingStore = {
  /** bindingId -> record */
  byId: Map<string, BrowserBindingRecord>;
  /** `${clientId}:${tabId}` -> bindingId */
  byTabKey: Map<string, string>;
  /** sessionId -> Set<bindingId> */
  bySession: Map<string, Set<string>>;
  /** sessionId -> primary bindingId */
  primaryBySession: Map<string, string>;
  /** pendingRequestId -> pending */
  pendingById: Map<string, PendingBindingRequest>;
};

export function tabKey(clientId: string, tabId: number): string {
  return `${clientId}:${tabId}`;
}

export function createBindingStore(snapshot?: BindingStoreSnapshot): BindingStore {
  const store: BindingStore = {
    byId: new Map(),
    byTabKey: new Map(),
    bySession: new Map(),
    primaryBySession: new Map(),
    pendingById: new Map(),
  };
  if (!snapshot) return store;
  for (const binding of snapshot.bindings) {
    store.byId.set(binding.bindingId, { ...binding, capabilities: [...binding.capabilities] });
    store.byTabKey.set(tabKey(binding.clientId, binding.tabId), binding.bindingId);
    let set = store.bySession.get(binding.sessionId);
    if (!set) {
      set = new Set();
      store.bySession.set(binding.sessionId, set);
    }
    set.add(binding.bindingId);
  }
  for (const [sessionId, primary] of Object.entries(snapshot.primaryBySession)) {
    if (primary) store.primaryBySession.set(sessionId, primary);
  }
  for (const pending of snapshot.pending) {
    store.pendingById.set(pending.pendingRequestId, { ...pending });
  }
  return store;
}

export function snapshotBindingStore(store: BindingStore): BindingStoreSnapshot {
  return {
    bindings: [...store.byId.values()].map((b) => ({ ...b, capabilities: [...b.capabilities] })),
    primaryBySession: Object.fromEntries(
      [...store.bySession.keys()].map((sessionId) => [sessionId, store.primaryBySession.get(sessionId) ?? null]),
    ),
    pending: [...store.pendingById.values()].map((p) => ({ ...p })),
  };
}

function ensureSessionSet(store: BindingStore, sessionId: string): Set<string> {
  let set = store.bySession.get(sessionId);
  if (!set) {
    set = new Set();
    store.bySession.set(sessionId, set);
  }
  return set;
}

export function createPendingRequest(
  store: BindingStore,
  input: Omit<PendingBindingRequest, "createdAt" | "expiresAt"> & { ttlMs: number; now?: number },
): PendingBindingRequest {
  const now = input.now ?? Date.now();
  const pending: PendingBindingRequest = {
    pendingRequestId: input.pendingRequestId,
    sessionId: input.sessionId,
    sessionLabel: input.sessionLabel,
    requestedCapabilities: [...input.requestedCapabilities],
    createdAt: now,
    expiresAt: now + input.ttlMs,
  };
  store.pendingById.set(pending.pendingRequestId, pending);
  return pending;
}

export function expirePendingRequests(store: BindingStore, now = Date.now()): string[] {
  const expired: string[] = [];
  for (const [id, pending] of store.pendingById) {
    if (pending.expiresAt <= now) {
      store.pendingById.delete(id);
      expired.push(id);
    }
  }
  return expired;
}

export function getPendingRequest(store: BindingStore, pendingRequestId: string, now = Date.now()): PendingBindingRequest {
  expirePendingRequests(store, now);
  const pending = store.pendingById.get(pendingRequestId);
  if (!pending) throw new BrowserControlError("BINDING_NOT_FOUND", "Pending binding request not found or expired");
  return pending;
}

export function consumePendingRequest(store: BindingStore, pendingRequestId: string, now = Date.now()): PendingBindingRequest {
  const pending = getPendingRequest(store, pendingRequestId, now);
  store.pendingById.delete(pendingRequestId);
  return pending;
}

export function acceptBinding(
  store: BindingStore,
  input: {
    bindingId: string;
    pendingRequestId: string;
    clientId: string;
    tabId: number;
    documentId: string;
    origin: string;
    title: string;
    url: string;
    now?: number;
  },
): BrowserBindingRecord {
  const now = input.now ?? Date.now();
  const pending = consumePendingRequest(store, input.pendingRequestId, now);

  const existingTab = store.byTabKey.get(tabKey(input.clientId, input.tabId));
  if (existingTab) {
    const owner = store.byId.get(existingTab);
    if (owner && owner.sessionId !== pending.sessionId && isActiveBindingState(owner.state)) {
      throw new BrowserControlError("TAB_ALREADY_BOUND", "Tab is already bound to another session", {
        bindingId: owner.bindingId,
        sessionId: owner.sessionId,
      });
    }
    if (owner) revokeBinding(store, owner.bindingId, now);
  }

  const capabilities: BrowserCapability[] = pending.requestedCapabilities.includes("dom")
    ? ["dom"]
    : ["dom"];

  const record: BrowserBindingRecord = {
    bindingId: input.bindingId,
    sessionId: pending.sessionId,
    clientId: input.clientId,
    tabId: input.tabId,
    documentId: input.documentId,
    origin: input.origin,
    title: input.title,
    url: input.url,
    capabilities,
    state: "active_dom",
    createdAt: now,
    lastValidatedAt: now,
    lastActiveAt: now,
  };

  store.byId.set(record.bindingId, record);
  store.byTabKey.set(tabKey(record.clientId, record.tabId), record.bindingId);
  ensureSessionSet(store, record.sessionId).add(record.bindingId);

  if (!store.primaryBySession.get(record.sessionId)) {
    store.primaryBySession.set(record.sessionId, record.bindingId);
  }

  return { ...record, capabilities: [...record.capabilities] };
}

function recomputePrimary(store: BindingStore, sessionId: string, now: number): string | null {
  const ids = store.bySession.get(sessionId);
  if (!ids || ids.size === 0) {
    store.primaryBySession.delete(sessionId);
    return null;
  }
  const active = [...ids]
    .map((id) => store.byId.get(id))
    .filter((b): b is BrowserBindingRecord => b != null && (isActiveBindingState(b.state) || b.state === "suspended"))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt || b.createdAt - a.createdAt);
  if (active.length === 0) {
    store.primaryBySession.delete(sessionId);
    return null;
  }
  const next = active[0].bindingId;
  store.primaryBySession.set(sessionId, next);
  // touch selected primary
  const binding = store.byId.get(next);
  if (binding) binding.lastActiveAt = Math.max(binding.lastActiveAt, now);
  return next;
}

export function revokeBinding(store: BindingStore, bindingId: string, now = Date.now()): BrowserBindingRecord {
  const binding = store.byId.get(bindingId);
  if (!binding) throw new BrowserControlError("BINDING_NOT_FOUND", `Unknown bindingId: ${bindingId}`);

  binding.state = "revoked";
  binding.lastValidatedAt = now;
  store.byId.delete(bindingId);
  store.byTabKey.delete(tabKey(binding.clientId, binding.tabId));
  const sessionSet = store.bySession.get(binding.sessionId);
  sessionSet?.delete(bindingId);
  if (sessionSet && sessionSet.size === 0) store.bySession.delete(binding.sessionId);

  const primary = store.primaryBySession.get(binding.sessionId);
  if (primary === bindingId) {
    recomputePrimary(store, binding.sessionId, now);
  }

  return { ...binding, capabilities: [...binding.capabilities] };
}

export function revokeSessionBindings(store: BindingStore, sessionId: string, now = Date.now()): BrowserBindingRecord[] {
  const ids = [...(store.bySession.get(sessionId) ?? [])];
  return ids.map((id) => revokeBinding(store, id, now));
}

export function suspendBinding(
  store: BindingStore,
  bindingId: string,
  reason: "cross_origin" | "debugger_conflict" | "manual",
  patch?: Partial<Pick<BrowserBindingRecord, "origin" | "title" | "url" | "documentId">>,
  now = Date.now(),
): BrowserBindingRecord {
  const binding = requireBinding(store, bindingId);
  if (binding.state === "revoked" || binding.state === "expired") {
    throw new BrowserControlError("BINDING_NOT_FOUND", "Binding is no longer active");
  }
  binding.state = "suspended";
  binding.capabilities = binding.capabilities.filter((c) => c === "dom");
  if (!binding.capabilities.includes("dom")) binding.capabilities = ["dom"];
  if (patch?.origin) binding.origin = patch.origin;
  if (patch?.title) binding.title = patch.title;
  if (patch?.url) binding.url = patch.url;
  if (patch?.documentId) binding.documentId = patch.documentId;
  binding.lastValidatedAt = now;
  binding.lastActiveAt = now;
  void reason;
  return { ...binding, capabilities: [...binding.capabilities] };
}

export function resumeBinding(
  store: BindingStore,
  bindingId: string,
  patch: Pick<BrowserBindingRecord, "documentId" | "origin" | "title" | "url">,
  now = Date.now(),
): BrowserBindingRecord {
  const binding = requireBinding(store, bindingId);
  if (binding.state !== "suspended" && !isActiveBindingState(binding.state)) {
    throw new BrowserControlError("BINDING_NOT_FOUND", "Binding cannot be resumed");
  }
  binding.documentId = patch.documentId;
  binding.origin = patch.origin;
  binding.title = patch.title;
  binding.url = patch.url;
  binding.state = "active_dom";
  binding.capabilities = ["dom"];
  binding.lastValidatedAt = now;
  binding.lastActiveAt = now;
  return { ...binding, capabilities: [...binding.capabilities] };
}

export function enableDebug(store: BindingStore, bindingId: string, now = Date.now()): BrowserBindingRecord {
  const binding = requireBinding(store, bindingId);
  if (!isActiveBindingState(binding.state) && binding.state !== "suspended") {
    throw new BrowserControlError("BINDING_SUSPENDED", "Binding is not active");
  }
  if (binding.state === "suspended") {
    throw new BrowserControlError("BINDING_SUSPENDED", "Re-confirm the tab before enabling debug mode");
  }
  if (!binding.capabilities.includes("debug_readonly")) {
    binding.capabilities = [...binding.capabilities, "debug_readonly"];
  }
  binding.state = "active_debug";
  binding.lastValidatedAt = now;
  binding.lastActiveAt = now;
  return { ...binding, capabilities: [...binding.capabilities] };
}

export function disableDebug(store: BindingStore, bindingId: string, now = Date.now()): BrowserBindingRecord {
  const binding = requireBinding(store, bindingId);
  binding.capabilities = binding.capabilities.filter((c) => c !== "debug_readonly");
  if (!binding.capabilities.includes("dom")) binding.capabilities = ["dom", ...binding.capabilities];
  if (binding.state === "active_debug") binding.state = "active_dom";
  binding.lastValidatedAt = now;
  binding.lastActiveAt = now;
  return { ...binding, capabilities: [...binding.capabilities] };
}

export function setPrimaryBinding(store: BindingStore, sessionId: string, bindingId: string, now = Date.now()): string {
  const binding = requireBinding(store, bindingId);
  if (binding.sessionId !== sessionId) {
    throw new BrowserControlError("BINDING_NOT_FOUND", "Binding does not belong to this session");
  }
  if (binding.state === "revoked" || binding.state === "expired") {
    throw new BrowserControlError("BINDING_NOT_FOUND", "Binding is no longer available");
  }
  store.primaryBySession.set(sessionId, bindingId);
  binding.lastActiveAt = now;
  return bindingId;
}

export function touchBinding(
  store: BindingStore,
  bindingId: string,
  patch?: Partial<Pick<BrowserBindingRecord, "title" | "url" | "documentId" | "origin" | "state">>,
  now = Date.now(),
): BrowserBindingRecord {
  const binding = requireBinding(store, bindingId);
  if (patch?.title !== undefined) binding.title = patch.title;
  if (patch?.url !== undefined) binding.url = patch.url;
  if (patch?.documentId !== undefined) binding.documentId = patch.documentId;
  if (patch?.origin !== undefined) binding.origin = patch.origin;
  if (patch?.state !== undefined) binding.state = patch.state;
  binding.lastValidatedAt = now;
  binding.lastActiveAt = now;
  return { ...binding, capabilities: [...binding.capabilities] };
}

export function sameOriginNavigation(
  store: BindingStore,
  bindingId: string,
  next: Pick<BrowserBindingRecord, "documentId" | "title" | "url" | "origin">,
  now = Date.now(),
): BrowserBindingRecord {
  const binding = requireBinding(store, bindingId);
  if (!isActiveBindingState(binding.state) && binding.state !== "suspended") {
    throw new BrowserControlError("BINDING_NOT_FOUND", "Binding is not navigable");
  }
  if (originOf(next.origin || next.url) !== originOf(binding.origin)) {
    return suspendBinding(store, bindingId, "cross_origin", next, now);
  }
  binding.documentId = next.documentId;
  binding.title = next.title;
  binding.url = next.url;
  binding.origin = next.origin || originOf(next.url);
  binding.lastValidatedAt = now;
  binding.lastActiveAt = now;
  // Passive same-origin navigation must never auto-resume a suspended binding.
  // Resume requires explicit user confirmation via resumeBinding().
  return { ...binding, capabilities: [...binding.capabilities] };
}

export function crossOriginNavigation(
  store: BindingStore,
  bindingId: string,
  next: Pick<BrowserBindingRecord, "documentId" | "title" | "url" | "origin">,
  now = Date.now(),
): BrowserBindingRecord {
  return suspendBinding(store, bindingId, "cross_origin", {
    documentId: next.documentId,
    title: next.title,
    url: next.url,
    origin: next.origin || originOf(next.url),
  }, now);
}

export function listSessionBindings(store: BindingStore, sessionId: string): BrowserBindingRecord[] {
  const ids = store.bySession.get(sessionId);
  if (!ids) return [];
  return [...ids]
    .map((id) => store.byId.get(id))
    .filter((b): b is BrowserBindingRecord => Boolean(b))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export function getPrimaryBindingId(store: BindingStore, sessionId: string): string | null {
  return store.primaryBySession.get(sessionId) ?? null;
}

export function resolveTargetBinding(
  store: BindingStore,
  sessionId: string,
  bindingId?: string,
): BrowserBindingRecord {
  const id = bindingId || getPrimaryBindingId(store, sessionId);
  if (!id) throw new BrowserControlError("NO_BOUND_TAB", "No browser tab is bound to this session");
  const binding = requireBinding(store, id);
  if (binding.sessionId !== sessionId) {
    throw new BrowserControlError("BINDING_NOT_FOUND", "Binding does not belong to this session");
  }
  if (binding.state === "suspended") {
    throw new BrowserControlError("BINDING_SUSPENDED", "Binding is suspended after navigation");
  }
  if (!isActiveBindingState(binding.state)) {
    throw new BrowserControlError("BINDING_NOT_FOUND", `Binding state is ${binding.state}`);
  }
  return { ...binding, capabilities: [...binding.capabilities] };
}

export function requireBinding(store: BindingStore, bindingId: string): BrowserBindingRecord {
  const binding = store.byId.get(bindingId);
  if (!binding) throw new BrowserControlError("BINDING_NOT_FOUND", `Unknown bindingId: ${bindingId}`);
  return binding;
}

export function clearAllBindings(store: BindingStore): void {
  store.byId.clear();
  store.byTabKey.clear();
  store.bySession.clear();
  store.primaryBySession.clear();
  store.pendingById.clear();
}

export function canTransition(from: BindingState, to: BindingState): boolean {
  const allowed: Record<BindingState, BindingState[]> = {
    pending: ["active_dom", "expired", "revoked"],
    active_dom: ["active_debug", "suspended", "revoked"],
    active_debug: ["active_dom", "suspended", "revoked"],
    suspended: ["active_dom", "revoked"],
    revoked: [],
    expired: [],
  };
  return allowed[from]?.includes(to) ?? false;
}

function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}
