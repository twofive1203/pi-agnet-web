"use client";

import { useEffect, useRef, useState } from "react";
import {
  buildInboxFromRuns,
  loadPersistedInboxReadIds,
  unreadInboxCount,
} from "@/lib/automation-ui-state";

const POLL_MS = 15_000;

type InboxApiResponse = {
  runs?: Array<{
    id: string;
    taskId: string;
    status: string;
    summary?: string | null;
    completedAt?: string | null;
    createdAt: string;
  }>;
  omissions?: Array<{
    id: string;
    taskId: string;
    kind: string;
    reason?: string | null;
    count?: number | null;
    firstLocal?: string | null;
    lastLocal?: string | null;
    createdAt?: string | null;
  }>;
  error?: string;
};

/**
 * Lightweight Automation inbox poller for AppShell badge only.
 * Keeps the heavy Automation drawer out of the initial chat chunk while
 * unread counts stay live when the drawer is closed.
 */
export function useAutomationUnread(enabled = true): number {
  const [unread, setUnread] = useState(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const refresh = async () => {
      if (!enabledRef.current || cancelled) return;
      try {
        await fetch("/api/automations/session", {
          method: "POST",
          credentials: "same-origin",
        });
        const res = await fetch("/api/automations/inbox?limit=20&offset=0", {
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
        });
        const data = (await res.json().catch(() => ({}))) as InboxApiResponse;
        if (!res.ok || cancelled) return;
        const readIds = loadPersistedInboxReadIds();
        const items = buildInboxFromRuns(data.runs ?? [], readIds, data.omissions ?? []);
        if (!cancelled) setUnread(unreadInboxCount(items));
      } catch {
        // Badge stays at last known value; full panel surfaces errors when opened.
      }
    };

    void refresh();
    timer = setInterval(() => {
      void refresh();
    }, POLL_MS);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [enabled]);

  return unread;
}
