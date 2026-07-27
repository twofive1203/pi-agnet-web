"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppDialog } from "@/components/AppDialogProvider";
import { useI18n } from "@/components/I18nProvider";

type BindingView = {
  bindingId: string;
  title: string;
  origin: string;
  url: string;
  state: string;
  capabilities: string[];
  primary: boolean;
  lastActiveAt: number;
};

type PendingRequest = {
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
    pendingRequest?: PendingRequest | null;
    bindings?: BindingView[];
    primaryBindingId?: string | null;
  } | null;
  error?: string;
};

interface Props {
  sessionId: string | null;
  sessionLabel?: string;
  compact?: boolean;
  popover?: boolean;
}

export function BrowserBindingPanel({ sessionId, sessionLabel, compact, popover }: Props) {
  const appDialog = useAppDialog();
  const { t } = useI18n();
  const [status, setStatus] = useState<BrowserBindingStatusResponse | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(!compact || Boolean(popover));

  const realSession = Boolean(sessionId && !sessionId.startsWith("new-"));

  const refresh = useCallback(async () => {
    try {
      const qs = realSession ? `?sessionId=${encodeURIComponent(sessionId!)}` : "";
      const res = await fetch(`/api/browser/status${qs}`);
      const data = await res.json() as BrowserBindingStatusResponse;
      if (!res.ok) throw new Error(data.error || "Failed to load browser status");
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [realSession, sessionId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function enableAndPair() {
    setBusy(true);
    setError(null);
    try {
      await fetch("/api/browser/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "configure", enabled: true }),
      });
      const res = await fetch("/api/browser/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "issue" }),
      });
      const data = await res.json() as { pairingCode?: string; expiresAt?: number; error?: string };
      if (!res.ok) throw new Error(data.error || "Failed to issue pairing code");
      setPairingCode(data.pairingCode || null);
      setPairingExpiresAt(data.expiresAt || null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function requestBind() {
    if (!realSession || !sessionId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/browser/bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "request",
          sessionId,
          sessionLabel: sessionLabel || sessionId.slice(0, 8),
        }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error || "Failed to create bind request");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const revoke = useCallback(async (bindingId?: string) => {
    if (!realSession || !sessionId) return;
    const confirmed = await appDialog.confirm({
      title: bindingId ? t("panels.browser.revokeTitle") : t("panels.browser.revokeAllTitle"),
      message: bindingId ? t("panels.browser.revokeMessage") : t("panels.browser.revokeAllMessage"),
      tone: "danger",
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const res = await fetch("/api/browser/bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "revoke", sessionId, bindingId }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error || "Revoke failed");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [appDialog, realSession, refresh, sessionId, t]);

  async function setPrimary(bindingId: string) {
    if (!realSession || !sessionId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/browser/bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set_primary", sessionId, bindingId }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error || "set_primary failed");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleDebug(binding: BindingView, enable: boolean) {
    if (!realSession || !sessionId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/browser/bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: enable ? "enable_debug" : "disable_debug",
          sessionId,
          bindingId: binding.bindingId,
        }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error || "debug toggle failed");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const bindings = status?.session?.bindings ?? [];
  const pending = status?.session?.pendingRequest ?? null;
  const clients = status?.bridge?.connectedClients?.length ?? 0;
  const enabled = status?.featureEnabled === true;

  return (
    <div className={popover ? "browser-binding-panel browser-binding-panel-popover" : "browser-binding-panel"} style={{
      border: "1px solid var(--border, #333)",
      borderRadius: 12,
      padding: popover ? 12 : 10,
      fontSize: 12,
      background: "var(--bg-panel)",
      boxShadow: popover ? "0 18px 42px rgba(0,0,0,0.20)" : "none",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <strong>{t("panels.browser.title")}</strong>
        {!popover && (
          <button type="button" onClick={() => setOpen((v) => !v)} style={{ fontSize: 11 }}>
            {open ? t("common.hide") : t("common.show")}
          </button>
        )}
      </div>
      {!open ? (
        <div style={{ color: "var(--text-dim)", marginTop: 4 }}>
          {enabled ? `${clients} ext · ${bindings.length} tab(s)` : t("panels.browser.disabled")}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <div style={{ color: "var(--text-dim)" }}>
            {t("panels.browser.bridge")}: {status?.bridge?.running ? `127.0.0.1:${status.bridge.port}` : t("panels.browser.stopped")}
            {status?.bridge?.startError ? ` (${status.bridge.startError})` : ""}
            {" · "}
            {t("panels.browser.extension")}: {clients > 0 ? t("panels.browser.connected") : t("panels.browser.offline")}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <button type="button" disabled={busy} onClick={() => void enableAndPair()}>
              {pairingCode ? t("panels.browser.refreshPairingCode") : t("panels.browser.enableAndPair")}
            </button>
            <button type="button" disabled={busy || !realSession || !enabled} onClick={() => void requestBind()}>
              {t("panels.browser.connectTab")}
            </button>
            <button type="button" disabled={busy || bindings.length === 0} onClick={() => void revoke()}>
              {t("panels.browser.revokeAll")}
            </button>
          </div>

          {pairingCode && (
            <div style={{
              fontFamily: "ui-monospace, monospace",
              padding: 8,
              borderRadius: 8,
              background: "rgba(56,189,248,0.12)",
            }}>
              {t("panels.browser.pairingCode")}: <strong>{pairingCode}</strong>
              {pairingExpiresAt ? ` · ${t("panels.browser.expires")} ${new Date(pairingExpiresAt).toLocaleTimeString()}` : ""}
              <div style={{ color: "var(--text-dim)", marginTop: 4 }}>
                {t("panels.browser.pairingHint")} <code>extensions/chrome-tab-debug</code>
              </div>
            </div>
          )}

          {!realSession && (
            <div style={{ color: "var(--text-dim)" }}>
              {t("panels.browser.waitingForSession")}
            </div>
          )}

          {pending && (
            <div>
              {t("panels.browser.pendingRequest", { id: pending.pendingRequestId.slice(0, 10) })}
            </div>
          )}

          {bindings.length > 0 && (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
              {bindings.map((binding) => (
                <li key={binding.bindingId} style={{
                  border: "1px solid var(--border, #333)",
                  borderRadius: 8,
                  padding: 8,
                }}>
                  <div style={{ fontWeight: 600 }}>
                    {binding.primary ? "★ " : ""}{binding.title || binding.origin}
                  </div>
                  <div style={{ color: "var(--text-dim)", wordBreak: "break-all" }}>
                    {binding.state} · {binding.origin}
                    {binding.capabilities.includes("debug_readonly") ? " · debug" : ""}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                    {!binding.primary && (
                      <button type="button" disabled={busy} onClick={() => void setPrimary(binding.bindingId)}>
                        {t("panels.browser.setPrimary")}
                      </button>
                    )}
                    {binding.capabilities.includes("debug_readonly") ? (
                      <button type="button" disabled={busy} onClick={() => void toggleDebug(binding, false)}>
                        {t("panels.browser.disableDebug")}
                      </button>
                    ) : (
                      <button type="button" disabled={busy || binding.state === "suspended"} onClick={() => void toggleDebug(binding, true)}>
                        {t("panels.browser.enableDebug")}
                      </button>
                    )}
                    <button type="button" disabled={busy} onClick={() => void revoke(binding.bindingId)}>
                      {t("panels.browser.revoke")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {error && <div style={{ color: "#fca5a5" }}>{error}</div>}
        </div>
      )}
    </div>
  );
}
