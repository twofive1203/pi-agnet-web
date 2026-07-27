"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type BrowserBindingView = {
  bindingId: string;
  title: string;
  origin: string;
  url: string;
  state: string;
  capabilities: string[];
  primary: boolean;
  lastActiveAt: number;
};

export type BrowserPendingRequest = {
  pendingRequestId: string;
  sessionId: string;
  sessionLabel: string;
  expiresAt: number;
};

export type BrowserBindingStatusResponse = {
  featureEnabled?: boolean;
  bridge?: {
    running?: boolean;
    port?: number;
    connectedClients?: Array<{ clientId: string }>;
    startError?: string;
  };
  installations?: Array<{ clientId: string; createdAt: number }>;
  session?: {
    pendingRequest?: BrowserPendingRequest | null;
    bindings?: BrowserBindingView[];
    primaryBindingId?: string | null;
  } | null;
  pendings?: BrowserPendingRequest[];
  pendingGlobal?: BrowserPendingRequest | null;
  error?: string;
};

export type BrowserTone = "connected" | "disconnected" | "warning";

function isRealSession(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId && !sessionId.startsWith("new-"));
}

function getStatusTone(
  status: BrowserBindingStatusResponse | null,
  error: string | null,
  realSession: boolean,
): BrowserTone {
  if (error || status?.error || status?.bridge?.startError) return "warning";

  const enabled = status?.featureEnabled === true;
  const bridgeRunning = status?.bridge?.running === true;
  const clients = status?.bridge?.connectedClients?.length ?? 0;
  const bindings = status?.session?.bindings?.length ?? 0;

  if (enabled && bridgeRunning && clients > 0 && (!realSession || bindings > 0)) return "connected";
  return "disconnected";
}

type Options = {
  sessionId: string | null;
  /** When true, poll more frequently (popover open / active use). */
  active?: boolean;
  /** When false, do not poll (panel reuses parent/shared status). */
  enabled?: boolean;
};

/**
 * Shared browser-bridge status poller.
 * Trigger owns the poller; panel can pass enabled:false and consume shared props.
 */
export function useBrowserBridgeStatus({ sessionId, active = false, enabled = true }: Options) {
  const [status, setStatus] = useState<BrowserBindingStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const realSession = isRealSession(sessionId);
  const mountedRef = useRef(true);
  const inFlightRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    if (inFlightRef.current) {
      await inFlightRef.current;
      return;
    }
    const run = (async () => {
      setLoading(true);
      try {
        const qs = realSession && sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
        const res = await fetch(`/api/browser/status${qs}`);
        const data = await res.json() as BrowserBindingStatusResponse;
        if (!res.ok) throw new Error(data.error || "Failed to load browser status");
        if (!mountedRef.current) return;
        setStatus(data);
        setError(null);
      } catch (err) {
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    })();
    inFlightRef.current = run.finally(() => {
      inFlightRef.current = null;
    });
    await inFlightRef.current;
  }, [enabled, realSession, sessionId]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    // Active UI (open popover): 4s. Idle badge only: 15s.
    const intervalMs = active ? 4_000 : 15_000;
    const timer = setInterval(() => {
      void refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, enabled, refresh]);

  const tone = useMemo(
    () => getStatusTone(status, error, realSession),
    [error, realSession, status],
  );

  return {
    status,
    error,
    loading,
    tone,
    realSession,
    refresh,
    setError,
    setStatus,
  };
}

export function browserToneColor(tone: BrowserTone): string {
  if (tone === "connected") return "#22c55e";
  if (tone === "warning") return "#f59e0b";
  return "#ef4444";
}

export function browserToneLabel(tone: BrowserTone, t: (key: string) => string): string {
  if (tone === "connected") return t("panels.browser.statusConnected");
  if (tone === "warning") return t("panels.browser.statusWarning");
  return t("panels.browser.statusDisconnected");
}
