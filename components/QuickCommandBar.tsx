"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/components/I18nProvider";
import Tooltip from "./Tooltip";
import type { QuickCommandsApi } from "@/hooks/useQuickCommands";
import { isQuickCommandActiveStatus } from "@/lib/quick-command-types";

interface Props {
  api: QuickCommandsApi;
}

const MENU_WIDTH = 420;

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

/**
 * Top-bar entry for project quick commands. Replaces the old inline bar above
 * the composer: a single icon button opens a portal-hosted dropdown (the top
 * bar clips overflow), keeping execution state out of the chat input area.
 */
export function QuickCommandBar({ api }: Props) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const {
    projectCwd,
    commands,
    runningCount,
    latestResult,
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

  const updatePosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.min(
      Math.max(8, rect.right - MENU_WIDTH),
      Math.max(8, window.innerWidth - MENU_WIDTH - 8),
    );
    setPosition({ top: rect.bottom + 6, left });
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    updatePosition();

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        buttonRef.current?.focus();
      }
    };

    window.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen, updatePosition]);

  if (!projectCwd) return null;

  const count = commands.length;
  const buttonLabel =
    count === 0
      ? t("panels.quickCommands.configureFirst")
      : t("panels.quickCommands.triggerWithCount", { count });

  const activeRun = runDetail && isQuickCommandActiveStatus(runDetail.status) ? runDetail : null;

  return (
    <>
      <Tooltip content={buttonLabel} position="bottom">
        <button
          ref={buttonRef}
          type="button"
          className="icon-round context-action quick-command-top-button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          aria-label={buttonLabel}
          onClick={() => {
            if (count === 0) {
              void openConfig();
              return;
            }
            setMenuOpen((open) => !open);
          }}
        >
          <span className="quick-command-top-icon" aria-hidden>⚡</span>
          {runningCount > 0 && (
            <span
              className="quick-command-top-badge"
              title={t("panels.quickCommands.runningCount", { count: runningCount })}
            >
              {runningCount}
            </span>
          )}
        </button>
      </Tooltip>

      {menuOpen && count > 0 && position && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            className="quick-command-menu"
            role="menu"
            style={{ top: position.top, left: position.left }}
          >
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

            {toast && <div className="quick-command-toast quick-command-menu-note" role="status">{toast}</div>}
            {error && <div className="quick-command-error quick-command-menu-note" role="alert">{error}</div>}

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

            {(latestResult || activeRun) && (
              <div className="quick-command-menu-result">
                {activeRun && (
                  <button
                    type="button"
                    className="quick-command-result-chip is-running"
                    onClick={() => {
                      setMenuOpen(false);
                      setPanelOpen(true);
                      setPanelCollapsed(false);
                      focusRun(activeRun, { expand: true });
                    }}
                  >
                    <span className="quick-command-result-name" title={activeRun.name}>{activeRun.name}</span>
                    <span className="quick-command-result-status">{t("panels.quickCommands.liveRunning", { name: activeRun.name })}</span>
                  </button>
                )}
                {latestResult && (
                  <div className={`quick-command-result-chip is-${latestResult.status}`} role="status">
                    <span className="quick-command-result-name" title={latestResult.name}>{latestResult.name}</span>
                    <span className="quick-command-result-status">{statusLabel(latestResult.status, t)}</span>
                    <span className="quick-command-result-meta">{formatDuration(latestResult.durationMs)}</span>
                    <span className="quick-command-result-actions">
                      <button
                        type="button"
                        className="quick-command-result-action"
                        onClick={() => {
                          setMenuOpen(false);
                          focusRun(latestResult, { expand: true });
                        }}
                      >
                        {t("panels.quickCommands.viewOutput")}
                      </button>
                      <button
                        type="button"
                        className="quick-command-result-action"
                        onClick={() => {
                          setMenuOpen(false);
                          void startCommand(latestResult.commandId);
                        }}
                      >
                        {t("panels.quickCommands.rerun")}
                      </button>
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
