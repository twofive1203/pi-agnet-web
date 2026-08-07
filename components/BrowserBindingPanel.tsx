"use client";

import { useCallback, useState } from "react";
import { useAppDialog } from "@/components/AppDialogProvider";
import { useI18n } from "@/components/I18nProvider";
import { formatTime } from "@/lib/i18n";
import {
  useBrowserBridgeStatus,
  type BrowserBindingStatusResponse,
  type BrowserBindingView,
} from "@/hooks/useBrowserBridgeStatus";

export type { BrowserBindingStatusResponse };

interface Props {
  sessionId: string | null;
  sessionLabel?: string;
  compact?: boolean;
  popover?: boolean;
  /** When provided by BrowserBindingTrigger, avoid a second poller. */
  sharedStatus?: BrowserBindingStatusResponse | null;
  sharedError?: string | null;
  onSharedRefresh?: () => Promise<void>;
}

export function BrowserBindingPanel({
  sessionId,
  sessionLabel,
  compact,
  popover,
  sharedStatus,
  sharedError,
  onSharedRefresh,
}: Props) {
  const appDialog = useAppDialog();
  const { t, locale } = useI18n();
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [open, setOpen] = useState(!compact || Boolean(popover));

  const ownsPoller = !onSharedRefresh;
  const polled = useBrowserBridgeStatus({
    sessionId,
    // Standalone panel only polls while expanded; shared mode disables this poller.
    active: ownsPoller && open,
    enabled: ownsPoller,
  });

  const status = onSharedRefresh ? (sharedStatus ?? null) : polled.status;
  const error = localError || (onSharedRefresh ? (sharedError ?? null) : polled.error);
  const realSession = Boolean(sessionId && !sessionId.startsWith("new-"));

  const polledRefresh = polled.refresh;
  const refresh = useCallback(async () => {
    if (onSharedRefresh) {
      await onSharedRefresh();
      return;
    }
    await polledRefresh();
  }, [onSharedRefresh, polledRefresh]);

  async function enableAndPair() {
    setBusy(true);
    setLocalError(null);
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
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function requestBind() {
    if (!realSession || !sessionId) return;
    setBusy(true);
    setLocalError(null);
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
      setLocalError(err instanceof Error ? err.message : String(err));
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
      setLocalError(err instanceof Error ? err.message : String(err));
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
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleDebug(binding: BrowserBindingView, enable: boolean) {
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
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const bindings = status?.session?.bindings ?? [];
  const pending = status?.session?.pendingRequest ?? null;
  const clients = status?.bridge?.connectedClients?.length ?? 0;
  const enabled = status?.featureEnabled === true;

  return (
    <div className={popover ? "browser-binding-panel browser-binding-panel-popover" : "browser-binding-panel"}>
      <div className="browser-binding-header">
        <strong>{t("panels.browser.title")}</strong>
        {!popover && (
          <button className="browser-binding-button" type="button" onClick={() => setOpen((v) => !v)}>
            {open ? t("common.hide") : t("common.show")}
          </button>
        )}
      </div>
      {!open ? (
        <div className="browser-binding-summary">
          {enabled ? `${clients} ext · ${bindings.length} tab(s)` : t("panels.browser.disabled")}
        </div>
      ) : (
        <div className="browser-binding-body">
          <div className="browser-binding-meta">
            {t("panels.browser.bridge")}: {status?.bridge?.running ? `127.0.0.1:${status.bridge.port}` : t("panels.browser.stopped")}
            {status?.bridge?.startError ? ` (${status.bridge.startError})` : ""}
            {" · "}
            {t("panels.browser.extension")}: {clients > 0 ? t("panels.browser.connected") : t("panels.browser.offline")}
          </div>

          <div className="browser-binding-actions">
            <button className="browser-binding-button" type="button" disabled={busy} onClick={() => void enableAndPair()}>
              {pairingCode ? t("panels.browser.refreshPairingCode") : t("panels.browser.enableAndPair")}
            </button>
            <button className="browser-binding-button" type="button" disabled={busy || !realSession || !enabled} onClick={() => void requestBind()}>
              {t("panels.browser.connectTab")}
            </button>
            <button className="browser-binding-button is-danger" type="button" disabled={busy || bindings.length === 0} onClick={() => void revoke()}>
              {t("panels.browser.revokeAll")}
            </button>
          </div>

          {pairingCode && (
            <div className="browser-binding-pairing">
              {t("panels.browser.pairingCode")}: <strong>{pairingCode}</strong>
              {pairingExpiresAt ? ` · ${t("panels.browser.expires")} ${formatTime(pairingExpiresAt, locale)}` : ""}
              <div className="browser-binding-meta browser-binding-pairing-hint">
                {t("panels.browser.pairingHint")} <code>extensions/chrome-tab-debug</code>
              </div>
            </div>
          )}

          {!realSession && (
            <div className="browser-binding-meta">
              {t("panels.browser.waitingForSession")}
            </div>
          )}

          {pending && (
            <div className="browser-binding-pending">
              {t("panels.browser.pendingRequest", { id: pending.pendingRequestId.slice(0, 10) })}
            </div>
          )}

          {bindings.length > 0 && (
            <ul className="browser-binding-list">
              {bindings.map((binding) => (
                <li key={binding.bindingId} className="browser-binding-item">
                  <div className="browser-binding-item-title">
                    {binding.primary ? "★ " : ""}{binding.title || binding.origin}
                  </div>
                  <div className="browser-binding-meta browser-binding-origin">
                    {binding.state} · {binding.origin}
                    {binding.state === "closed" ? ` · ${t("panels.browser.closedState")}` : ""}
                    {binding.capabilities.includes("debug_readonly") ? " · debug" : ""}
                  </div>
                  <div className="browser-binding-actions browser-binding-item-actions">
                    {!binding.primary && binding.state !== "closed" && (
                      <button className="browser-binding-button" type="button" disabled={busy} onClick={() => void setPrimary(binding.bindingId)}>
                        {t("panels.browser.setPrimary")}
                      </button>
                    )}
                    {binding.capabilities.includes("debug_readonly") ? (
                      <button className="browser-binding-button" type="button" disabled={busy || binding.state === "closed"} onClick={() => void toggleDebug(binding, false)}>
                        {t("panels.browser.disableDebug")}
                      </button>
                    ) : binding.state !== "closed" ? (
                      <button className="browser-binding-button" type="button" disabled={busy || binding.state === "suspended"} onClick={() => void toggleDebug(binding, true)}>
                        {t("panels.browser.enableDebug")}
                      </button>
                    ) : null}
                    <button className="browser-binding-button is-danger" type="button" disabled={busy} onClick={() => void revoke(binding.bindingId)}>
                      {t("panels.browser.revoke")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {error && <div className="browser-binding-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
