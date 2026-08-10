"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SESSION_TAB_HEARTBEAT_MS,
  SESSION_TAB_STALE_MS,
  applySessionTabMessage,
  buildSessionTabMessage,
  createSessionTabId,
  isSessionTabMessage,
  pruneStaleSessionTabPeers,
  sessionTabChannelName,
  summarizeSessionTabPresence,
  type SessionTabPeer,
  type SessionTabPresence,
  type SessionTabRole,
} from "@/lib/session-tab-coordination";

export interface SessionTabLockState {
  /** True when this tab must not send/steer/edit the session. */
  writeLocked: boolean;
  role: SessionTabRole;
  hasOtherTabs: boolean;
  presence: SessionTabPresence | null;
  /** Explicit user action: take write ownership from other tabs. */
  takeOverWrite: () => void;
  /** Supported in this browser (BroadcastChannel available). */
  supported: boolean;
}

/**
 * Coordinate write ownership for one session across browser tabs.
 * New sessions (no id yet) skip coordination until a real id exists.
 */
export function useSessionTabLock(sessionId: string | null | undefined): SessionTabLockState {
  const supported =
    typeof window !== "undefined" && typeof BroadcastChannel !== "undefined";

  const tabIdRef = useRef<string>("");
  if (!tabIdRef.current) tabIdRef.current = createSessionTabId();

  const peersRef = useRef<Map<string, SessionTabPeer>>(new Map());
  const claimsWriteRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const [presence, setPresence] = useState<SessionTabPresence | null>(null);

  const publishPresence = useCallback((sessionIdValue: string) => {
    const pruned = pruneStaleSessionTabPeers(peersRef.current, {
      now: Date.now(),
      staleMs: SESSION_TAB_STALE_MS,
    });
    peersRef.current = pruned;
    const next = summarizeSessionTabPresence({
      sessionId: sessionIdValue,
      localTabId: tabIdRef.current,
      peers: pruned,
      localClaimsWrite: claimsWriteRef.current,
    });
    setPresence(next);
    return next;
  }, []);

  const post = useCallback((message: ReturnType<typeof buildSessionTabMessage>) => {
    try {
      channelRef.current?.postMessage(message);
    } catch {
      // Channel may be closed during teardown.
    }
  }, []);

  const takeOverWrite = useCallback(() => {
    if (!sessionId || !supported) return;
    claimsWriteRef.current = true;
    const msg = buildSessionTabMessage({
      type: "claim_write",
      sessionId,
      tabId: tabIdRef.current,
      role: "writer",
    });
    post(msg);
    publishPresence(sessionId);
  }, [post, publishPresence, sessionId, supported]);

  useEffect(() => {
    if (!sessionId || !supported) {
      peersRef.current = new Map();
      claimsWriteRef.current = false;
      setPresence(null);
      return;
    }

    const localTabId = tabIdRef.current;
    claimsWriteRef.current = false;
    peersRef.current = new Map();

    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(sessionTabChannelName(sessionId));
    } catch {
      setPresence(null);
      return;
    }
    channelRef.current = channel;

    const onMessage = (event: MessageEvent) => {
      if (!isSessionTabMessage(event.data)) return;
      if (event.data.sessionId !== sessionId) return;
      if (event.data.tabId === localTabId) return;

      if (event.data.type === "claim_write" && event.data.tabId !== localTabId) {
        claimsWriteRef.current = false;
      }

      peersRef.current = applySessionTabMessage(peersRef.current, event.data, {
        localTabId,
        now: Date.now(),
      });

      // Answer hello so the new tab learns about an existing writer quickly.
      if (event.data.type === "hello") {
        const current = publishPresence(sessionId);
        post(
          buildSessionTabMessage({
            type: "heartbeat",
            sessionId,
            tabId: localTabId,
            role: current.role,
          }),
        );
        return;
      }

      publishPresence(sessionId);
    };

    channel.addEventListener("message", onMessage);

    // Announce presence without claiming write; election + heartbeats converge.
    post(
      buildSessionTabMessage({
        type: "hello",
        sessionId,
        tabId: localTabId,
      }),
    );
    publishPresence(sessionId);

    const heartbeat = window.setInterval(() => {
      const current = publishPresence(sessionId);
      post(
        buildSessionTabMessage({
          type: "heartbeat",
          sessionId,
          tabId: localTabId,
          role: current.role,
        }),
      );
    }, SESSION_TAB_HEARTBEAT_MS);

    const onPageHide = () => {
      post(
        buildSessionTabMessage({
          type: "bye",
          sessionId,
          tabId: localTabId,
          role: claimsWriteRef.current ? "writer" : undefined,
        }),
      );
    };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener("pagehide", onPageHide);
      try {
        channel.postMessage(
          buildSessionTabMessage({
            type: "bye",
            sessionId,
            tabId: localTabId,
          }),
        );
      } catch {
        // ignore
      }
      channel.removeEventListener("message", onMessage);
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [post, publishPresence, sessionId, supported]);

  return useMemo(() => {
    const role = presence?.role ?? "writer";
    const hasOtherTabs = presence?.hasOtherTabs ?? false;
    // Only lock when another tab is actually present and we are not writer.
    const writeLocked = Boolean(sessionId) && supported && hasOtherTabs && role !== "writer";
    return {
      writeLocked,
      role,
      hasOtherTabs,
      presence,
      takeOverWrite,
      supported,
    };
  }, [presence, sessionId, supported, takeOverWrite]);
}
