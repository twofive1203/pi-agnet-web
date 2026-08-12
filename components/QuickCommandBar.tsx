"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import type { QuickCommandsApi } from "@/hooks/useQuickCommands";
import { isQuickCommandActiveStatus } from "@/lib/quick-command-types";

interface Props {
  api: QuickCommandsApi;
}

function statusLabel(
  status: string | null | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  switch (status) {
    case "starting":
      return t("panels.quickCommands.statusStarting");
    case "running":
      return t("panels.quickCommands.statusRunning");
    case "succeeded":
      return t("panels.quickCommands.statusSucceeded");
    case "failed":
      return t("panels.quickCommands.statusFailed");
    case "cancelled":
      return t("panels.quickCommands.statusCancelled");
    case "timed_out":
      return t("panels.quickCommands.statusTimedOut");
    case "interrupted":
      return t("panels.quickCommands.statusInterrupted");
    default:
      return "";
  }
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export function QuickCommandBar({ api }: Props) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const {
    projectCwd,
    commands,
    runningCount,
    latestResult,
    loading,
    error,
    toast,
    busyCommandId,
    startCommand,
    openConfig,
    focusRun,
    setPanelOpen,
    setPanelCollapsed,
    runDetail,
  } = api;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  if (!projectCwd) return null;

  const count = commands.length;
  const triggerLabel =
    count === 0
      ? t("panels.quickCommands.configureFirst")
      : t("panels.quickCommands.triggerWithCount", { count });

  return (
    <div className="quick-command-bar" ref={rootRef}>
      <div className="quick-command-bar-row">
        <button
          type="button"
          className={`quick-command-trigger${menuOpen ? " is-open" : ""}${runningCount > 0 ? " is-running" : ""}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          onClick={() => {
            if (count === 0) {
              void openConfig();
              return;
            }
            setMenuOpen((open) => !open);
          }}
        >
          <span className="quick-command-trigger-icon" aria-hidden>⚡</span>
          <span className="quick-command-trigger-label">{triggerLabel}</span>
          {runningCount > 0 && (
            <span className="quick-command-running-badge" title={t("panels.quickCommands.runningCount", { count: runningCount })}>
              {runningCount}
            </span>
          )}
        </button>

        {latestResult && (
          <div className={`quick-command-result-chip is-${latestResult.status}`} role="status">
            <span className="quick-command-result-name" title={latestResult.name}>{latestResult.name}</span>
            <span className="quick-command-result-status">{statusLabel(latestResult.status, t)}</span>
            <span className="quick-command-result-meta">{formatDuration(latestResult.durationMs)}</span>
            <button
              type="button"
              className="quick-command-result-action"
              onClick={() => {
                focusRun(latestResult, { expand: true });
              }}
            >
              {t("panels.quickCommands.viewOutput")}
            </button>
            <button
              type="button"
              className="quick-command-result-action"
              onClick={() => {
                void startCommand(latestResult.commandId);
              }}
            >
              {t("panels.quickCommands.rerun")}
            </button>
          </div>
        )}

        {runDetail && isQuickCommandActiveStatus(runDetail.status) && (
          <button
            type="button"
            className="quick-command-live-chip"
            onClick={() => {
              setPanelOpen(true);
              setPanelCollapsed(false);
              focusRun(runDetail, { expand: true });
            }}
          >
            {t("panels.quickCommands.liveRunning", { name: runDetail.name })}
          </button>
        )}

        {(toast === "running" || toast) && (
          <span className="quick-command-toast" role="status">
            {toast === "running" ? t("panels.quickCommands.alreadyRunning") : toast}
          </span>
        )}

        {error && <span className="quick-command-error" role="alert">{error}</span>}
        {loading && count === 0 && <span className="quick-command-muted">{t("panels.quickCommands.loading")}</span>}
      </div>

      {menuOpen && count > 0 && (
        <div className="quick-command-menu" id={menuId} role="menu">
          <div className="quick-command-menu-header">
            <span>{t("panels.quickCommands.menuTitle")}</span>
            <button
              type="button"
              className="quick-command-menu-manage"
              onClick={() => {
                setMenuOpen(false);
                void openConfig();
              }}
            >
              {t("panels.quickCommands.manage")}
            </button>
          </div>
          <ul className="quick-command-menu-list">
            {commands.map((command) => {
              const active = Boolean(command.activeRunId && command.activeStatus && isQuickCommandActiveStatus(command.activeStatus));
              const busy = busyCommandId === command.id;
              return (
                <li key={command.id}>
                  <button
                    type="button"
                    role="menuitem"
                    className={`quick-command-menu-item${active ? " is-active" : ""}`}
                    disabled={busy}
                    onClick={() => {
                      setMenuOpen(false);
                      void startCommand(command.id);
                    }}
                  >
                    <span className="quick-command-menu-item-main">
                      <span className="quick-command-menu-item-name">{command.name}</span>
                      {command.description && (
                        <span className="quick-command-menu-item-desc">{command.description}</span>
                      )}
                      <span className="quick-command-menu-item-cmd" title={command.command}>{command.command}</span>
                    </span>
                    <span className="quick-command-menu-item-meta">
                      {active
                        ? statusLabel(command.activeStatus, t)
                        : command.confirmBeforeRun
                          ? t("panels.quickCommands.needsConfirm")
                          : t("panels.quickCommands.run")}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
