"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatQuotaQueriedAt, quotaColor } from "@/lib/quota-display";
import type { GrokUsageResult } from "@/lib/grok-usage";

function UsagePie({ utilization, size = 18 }: { utilization: number | null; size?: number }) {
  const pct = utilization !== null ? Math.min(Math.max(utilization, 0), 100) : 0;
  const color = utilization !== null ? quotaColor(pct) : "var(--text-dim)";
  const background = utilization !== null
    ? `conic-gradient(${color} ${pct * 3.6}deg, rgba(148,163,184,0.18) 0deg)`
    : "conic-gradient(rgba(148,163,184,0.25) 0deg, rgba(148,163,184,0.25) 360deg)";

  return (
    <span
      title={utilization !== null ? `Grok ${Math.round(pct)}% used` : "Unknown usage"}
      style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
    >
      <span
        style={{
          width: size, height: size, borderRadius: "50%", background,
          border: "1px solid rgba(148,163,184,0.35)",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          boxSizing: "border-box",
        }}
      >
        <span
          style={{
            width: Math.max(6, Math.floor(size * 0.48)),
            height: Math.max(6, Math.floor(size * 0.48)),
            borderRadius: "50%", background: "var(--bg-panel)", opacity: 0.92,
          }}
        />
      </span>
    </span>
  );
}

export function GrokUsagePanel() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPosition, setPanelPosition] = useState<{ top: number; right: number } | null>(null);
  const [usageResult, setUsageResult] = useState<GrokUsageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updatePanelPosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPanelPosition({
      top: rect.bottom,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, []);

  const loadUsage = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const mode = forceRefresh ? "refresh" : "cache";
      const res = await fetch(`/api/auth/usage/grok-cli?mode=${mode}`);
      const data = await res.json() as GrokUsageResult & { error?: string };
      if (data.success && data.monthly) {
        setError(null);
        setUsageResult(data);
        return;
      }
      // Keep previous successful result in memory on live failure / empty cache.
      if (data.error) setError(data.error);
      setUsageResult((prev) => {
        if (prev?.success && prev.monthly && forceRefresh) return prev;
        return data;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Usage query failed");
      if (!forceRefresh) setUsageResult(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load cache on mount
  useEffect(() => {
    void loadUsage(false);
  }, [loadUsage]);

  useEffect(() => {
    if (!open) return;
    updatePanelPosition();
  }, [open, updatePanelPosition]);

  useEffect(() => {
    if (!open) return;

    const handleOutsideInteraction = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    updatePanelPosition();
    document.addEventListener("pointerdown", handleOutsideInteraction, true);
    document.addEventListener("focusin", handleOutsideInteraction, true);
    document.addEventListener("scroll", updatePanelPosition, true);
    window.addEventListener("resize", updatePanelPosition);
    window.visualViewport?.addEventListener("resize", updatePanelPosition);
    window.visualViewport?.addEventListener("scroll", updatePanelPosition);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handleOutsideInteraction, true);
      document.removeEventListener("focusin", handleOutsideInteraction, true);
      document.removeEventListener("scroll", updatePanelPosition, true);
      window.removeEventListener("resize", updatePanelPosition);
      window.visualViewport?.removeEventListener("resize", updatePanelPosition);
      window.visualViewport?.removeEventListener("scroll", updatePanelPosition);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, updatePanelPosition]);

  // Data for compact display
  const monthly = usageResult?.monthly ?? null;
  const weekly = usageResult?.weekly ?? null;
  const monthlyUtilization = monthly?.utilization ?? null;
  const weeklyUtilization = weekly?.creditUsagePercent ?? null;
  const refreshText = usageResult?.queriedAt ? formatQuotaQueriedAt(usageResult.queriedAt) : "Not queried";
  const compactStatus = loading ? "Loading" : error ? "Error" : refreshText;

  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", height: "100%" }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (!open) updatePanelPosition();
          setOpen((value) => !value);
        }}
        title="Grok usage"
        aria-label="Grok usage"
        aria-expanded={open}
        aria-controls="grok-usage-popover"
        style={{
          height: 26,
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "0 9px",
          borderRadius: 999,
          border: "1px solid rgba(148,163,184,0.28)",
          background: "rgba(15,23,42,0.10)",
          backdropFilter: "blur(10px)",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 11,
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ fontWeight: 700, color: "var(--text)" }}>Grok</span>
        <span>{compactStatus}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {monthly && <UsagePie utilization={monthlyUtilization} />}
        </span>
      </button>

      {open && panelPosition && typeof document !== "undefined" && createPortal((
        <div
          ref={panelRef}
          id="grok-usage-popover"
          className="grok-usage-popover"
          role="dialog"
          aria-label="Grok usage details"
          style={{
            position: "fixed",
            top: panelPosition.top,
            right: panelPosition.right,
            zIndex: 550,
            width: 360,
            maxHeight: `min(650px, calc(100dvh - ${panelPosition.top + 8}px))`,
            overflow: "auto",
            border: "1px solid rgba(148,163,184,0.30)",
            borderRadius: 12,
            background: "color-mix(in srgb, var(--bg-panel) 86%, transparent)",
            boxShadow: "0 18px 45px rgba(0,0,0,0.28)",
            backdropFilter: "blur(14px)",
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 800 }}>Grok usage</div>
              <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 11 }}>
                {loading ? "Loading…" : `Updated: ${refreshText}`}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void loadUsage(true)}
              disabled={loading}
              title="Refresh Grok usage"
              aria-label="Refresh Grok usage"
              style={{
                width: 30, height: 30, border: "1px solid var(--border)", borderRadius: 7,
                background: "var(--bg)",
                color: loading ? "var(--text-dim)" : "var(--accent)",
                cursor: loading ? "default" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: 0, flexShrink: 0,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 0 1-9 9 8.8 8.8 0 0 1-6.36-2.64" />
                <path d="M3 12a9 9 0 0 1 9-9 8.8 8.8 0 0 1 6.36 2.64" />
                <path d="M3 4v8h8" />
                <path d="M21 20v-8h-8" />
              </svg>
            </button>
          </div>

          {error && (
            <div style={{ color: "#f87171", fontSize: 12, lineHeight: 1.45 }}>{error}</div>
          )}

          {!monthly ? (
            <div style={{
              display: "flex", alignItems: "center", gap: 10, padding: 10,
              borderRadius: 9, background: "rgba(148,163,184,0.08)",
              border: "1px solid var(--border)",
            }}>
              <UsagePie utilization={null} size={34} />
              <div style={{ color: "var(--text-dim)", fontSize: 12, lineHeight: 1.45 }}>
                Grok CLI usage not available. Click refresh to query xAI billing.
                {!usageResult?.configured && !usageResult?.envBypass && (
                  <> Make sure Grok is logged in via Models → xAI or Grok CLI, or set GROK_CLI_OAUTH_TOKEN.</>
                )}
              </div>
            </div>
          ) : monthly && (
            <div style={{
              display: "grid", gridTemplateColumns: "42px 1fr auto", alignItems: "center", gap: 10,
              padding: 9, borderRadius: 9, border: "1px solid var(--border)",
              background: "rgba(148,163,184,0.08)",
            }}>
              <UsagePie utilization={monthlyUtilization} size={30} />
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 700 }}>Monthly credits</span>
                <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
                  Used {monthly.used.toLocaleString()} · Limit {monthly.monthlyLimit.toLocaleString()} · Remaining {monthly.remaining.toLocaleString()}
                  {monthly.billingPeriodEnd && (
                    <> · Resets {new Date(monthly.billingPeriodEnd).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</>
                  )}
                </span>
              </div>
              <span style={{ color: quotaColor(monthlyUtilization ?? 0), fontSize: 15, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
                {Math.round(monthlyUtilization ?? 0)}%
              </span>
            </div>
          )}

          {weekly && (
            <div style={{
              display: "grid", gridTemplateColumns: "42px 1fr auto", alignItems: "center", gap: 10,
              padding: 9, borderRadius: 9, border: "1px solid var(--border)",
              background: "rgba(148,163,184,0.08)",
            }}>
              <UsagePie utilization={weeklyUtilization} size={30} />
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 700 }}>Weekly credits</span>
                <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
                  {weekly.billingPeriodEnd && `Resets ${new Date(weekly.billingPeriodEnd).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`}
                </span>
              </div>
              <span style={{ color: quotaColor(weeklyUtilization ?? 0), fontSize: 15, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
                {Math.round(weeklyUtilization ?? 0)}%
              </span>
            </div>
          )}

          <div style={{ color: "var(--text-dim)", fontSize: 10, lineHeight: 1.5 }}>
            {usageResult?.envBypass && (
              <div style={{ color: "#fb923c", marginTop: 4 }}>Using GROK_CLI_OAUTH_TOKEN environment variable. No automatic refresh.</div>
            )}
            Only manual refresh available. No auto-refresh scheduler.
          </div>
        </div>
      ), document.body)}
    </div>
  );
}
