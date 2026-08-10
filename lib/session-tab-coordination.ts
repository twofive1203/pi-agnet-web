/**
 * Same-session multi-tab coordination (browser-only).
 *
 * Pure helpers + message contract for BroadcastChannel.
 * Default policy: elect one writer among live tabs; later tabs stay read-only
 * until the user explicitly takes over. Server/SDK concurrency remains the
 * hard backstop for overlapping prompts.
 */

export const SESSION_TAB_CHANNEL_PREFIX = "pi-web:session-tab:v1:";
export const SESSION_TAB_HEARTBEAT_MS = 2_000;
export const SESSION_TAB_STALE_MS = 6_000;
export const SESSION_TAB_PROTOCOL_VERSION = 1 as const;

export type SessionTabRole = "writer" | "reader";

export type SessionTabMessageType =
  | "hello"
  | "heartbeat"
  | "bye"
  | "claim_write"
  | "yield_write";

export interface SessionTabMessage {
  v: typeof SESSION_TAB_PROTOCOL_VERSION;
  type: SessionTabMessageType;
  sessionId: string;
  tabId: string;
  /** Present on heartbeat when this tab currently believes it is writer/reader. */
  role?: SessionTabRole;
  /** Optional claim target acknowledgment. */
  toTabId?: string;
  ts: number;
}

export interface SessionTabPeer {
  tabId: string;
  role: SessionTabRole;
  lastSeen: number;
}

export interface SessionTabPresence {
  localTabId: string;
  sessionId: string;
  role: SessionTabRole;
  writerTabId: string | null;
  peers: SessionTabPeer[];
  /** True when another live tab is present (regardless of write ownership). */
  hasOtherTabs: boolean;
}

export function sessionTabChannelName(sessionId: string): string {
  return `${SESSION_TAB_CHANNEL_PREFIX}${encodeURIComponent(sessionId)}`;
}

export function createSessionTabId(now = Date.now()): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return `tab_${now.toString(36)}_${rand.replace(/-/g, "").slice(0, 12)}`;
}

export function isSessionTabMessage(value: unknown): value is SessionTabMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as Partial<SessionTabMessage>;
  if (msg.v !== SESSION_TAB_PROTOCOL_VERSION) return false;
  if (typeof msg.sessionId !== "string" || !msg.sessionId) return false;
  if (typeof msg.tabId !== "string" || !msg.tabId) return false;
  if (typeof msg.ts !== "number" || !Number.isFinite(msg.ts)) return false;
  switch (msg.type) {
    case "hello":
    case "heartbeat":
    case "bye":
    case "claim_write":
    case "yield_write":
      return true;
    default:
      return false;
  }
}

export function buildSessionTabMessage(
  partial: Omit<SessionTabMessage, "v" | "ts"> & { ts?: number },
): SessionTabMessage {
  return {
    v: SESSION_TAB_PROTOCOL_VERSION,
    ts: partial.ts ?? Date.now(),
    type: partial.type,
    sessionId: partial.sessionId,
    tabId: partial.tabId,
    role: partial.role,
    toTabId: partial.toTabId,
  };
}

/**
 * Reduce peer map after receiving one message. Does not decide local role;
 * call resolveSessionTabRole afterward.
 */
export function applySessionTabMessage(
  peers: Map<string, SessionTabPeer>,
  message: SessionTabMessage,
  options?: { now?: number; localTabId?: string },
): Map<string, SessionTabPeer> {
  const now = options?.now ?? Date.now();
  const next = new Map(peers);
  if (options?.localTabId && message.tabId === options.localTabId) return next;

  if (message.type === "bye") {
    next.delete(message.tabId);
    return next;
  }

  if (message.type === "claim_write") {
    for (const [id, peer] of next) {
      next.set(id, {
        ...peer,
        role: id === message.tabId ? "writer" : "reader",
        lastSeen: id === message.tabId ? message.ts || now : peer.lastSeen,
      });
    }
    next.set(message.tabId, {
      tabId: message.tabId,
      role: "writer",
      lastSeen: message.ts || now,
    });
    return next;
  }

  // hello: peer is alive; role unknown until election/heartbeat.
  // heartbeat/yield: honor advertised role when present.
  const role: SessionTabRole =
    message.type === "heartbeat" && message.role === "writer"
      ? "writer"
      : message.type === "yield_write"
        ? "reader"
        : message.role === "writer"
          ? "writer"
          : "reader";

  next.set(message.tabId, {
    tabId: message.tabId,
    role,
    lastSeen: message.ts || now,
  });
  return next;
}

/** Drop peers that have not heartbeated recently. */
export function pruneStaleSessionTabPeers(
  peers: Map<string, SessionTabPeer>,
  options?: { now?: number; staleMs?: number },
): Map<string, SessionTabPeer> {
  const now = options?.now ?? Date.now();
  const staleMs = options?.staleMs ?? SESSION_TAB_STALE_MS;
  const next = new Map<string, SessionTabPeer>();
  for (const [id, peer] of peers) {
    if (now - peer.lastSeen <= staleMs) next.set(id, peer);
  }
  return next;
}

/**
 * Decide local role given known live peers.
 * - Explicit local claim always wins until another claim arrives.
 * - Else prefer a single remote writer when present.
 * - Else elect the lexicographically smallest live tabId so simultaneous
 *   first-open tabs converge without thrash.
 */
export function resolveSessionTabRole(input: {
  localTabId: string;
  peers: ReadonlyMap<string, SessionTabPeer> | SessionTabPeer[];
  /** When true, local tab insists on write (after user takeover). */
  localClaimsWrite?: boolean;
}): { role: SessionTabRole; writerTabId: string } {
  const peers = Array.isArray(input.peers) ? input.peers : [...input.peers.values()];

  if (input.localClaimsWrite) {
    return { role: "writer", writerTabId: input.localTabId };
  }

  const remoteWriters = peers
    .filter((peer) => peer.role === "writer")
    .map((peer) => peer.tabId)
    .sort();
  if (remoteWriters.length > 0) {
    return { role: "reader", writerTabId: remoteWriters[0] };
  }

  const liveIds = [input.localTabId, ...peers.map((peer) => peer.tabId)].sort();
  const writerTabId = liveIds[0] ?? input.localTabId;
  return {
    role: writerTabId === input.localTabId ? "writer" : "reader",
    writerTabId,
  };
}

export function summarizeSessionTabPresence(input: {
  sessionId: string;
  localTabId: string;
  peers: ReadonlyMap<string, SessionTabPeer> | SessionTabPeer[];
  localClaimsWrite?: boolean;
}): SessionTabPresence {
  const peersArr = Array.isArray(input.peers) ? input.peers : [...input.peers.values()];
  const { role, writerTabId } = resolveSessionTabRole({
    localTabId: input.localTabId,
    peers: peersArr,
    localClaimsWrite: input.localClaimsWrite,
  });
  return {
    localTabId: input.localTabId,
    sessionId: input.sessionId,
    role,
    writerTabId,
    peers: peersArr,
    hasOtherTabs: peersArr.length > 0,
  };
}
