"use client";

import { FormEvent, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/components/I18nProvider";

type LoginResponse = {
  ok?: boolean;
  error?: string;
  authRequired?: boolean;
};

export function ServerUnlockForm({ showHttpWarning }: { showHttpWarning: boolean }) {
  const { t } = useI18n();
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [accessKey, setAccessKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/server-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ accessKey }),
      });
      let data: LoginResponse = {};
      try {
        data = (await res.json()) as LoginResponse;
      } catch {
        data = {};
      }
      if (res.status === 429) {
        setError(t("access.rateLimited"));
        return;
      }
      if (res.status === 503) {
        setError(t("access.unavailable"));
        return;
      }
      if (!res.ok || data.ok === false) {
        setError(t("access.invalidKey"));
        return;
      }
      // Replace so the key never lingers in history; cookie is HttpOnly.
      window.location.replace("/");
    } catch {
      setError(t("access.networkError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="server-unlock-shell">
      <div className="server-unlock-card">
        <div className="server-unlock-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/snail-pi-logo.svg" alt="" width={48} height={48} className="server-unlock-logo" />
          <div>
            <h1 className="server-unlock-title">{t("access.title")}</h1>
            <p className="server-unlock-subtitle">{t("access.subtitle")}</p>
          </div>
        </div>

        {showHttpWarning && (
          <div className="server-unlock-warning" role="status">
            <strong>{t("access.httpWarningTitle")}</strong>
            <p>{t("access.httpWarningBody")}</p>
          </div>
        )}

        <form className="server-unlock-form" onSubmit={onSubmit} autoComplete="on">
          <label className="server-unlock-label" htmlFor={inputId}>
            {t("access.accessKeyLabel")}
          </label>
          <input
            ref={inputRef}
            id={inputId}
            name="access-key"
            type="password"
            autoComplete="current-password"
            spellCheck={false}
            className="server-unlock-input"
            placeholder={t("access.accessKeyPlaceholder")}
            value={accessKey}
            onChange={(e) => setAccessKey(e.target.value)}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            required
          />
          {error && (
            <p id={errorId} className="server-unlock-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="server-unlock-submit" disabled={busy || !accessKey.trim()}>
            {busy ? t("access.unlocking") : t("access.unlock")}
          </button>
        </form>
      </div>
    </div>
  );
}
