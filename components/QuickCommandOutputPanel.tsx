"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useI18n } from "@/components/I18nProvider";
import type { QuickCommandsApi } from "@/hooks/useQuickCommands";
import { isQuickCommandActiveStatus, isQuickCommandTerminalStatus } from "@/lib/quick-command-types";

const HEADER_HEIGHT = 36;
const MIN_DOCK_HEIGHT = 160;
const DEFAULT_DOCK_HEIGHT = 260;

interface Props {
  api: QuickCommandsApi;
}

function getTerminalTheme(): ITheme {
  return {
    background: "#0b1220",
    foreground: "#e2e8f0",
    cursor: "#93c5fd",
    selectionBackground: "rgba(59,130,246,0.35)",
    black: "#0f172a",
    red: "#f87171",
    green: "#4ade80",
    yellow: "#fbbf24",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#e2e8f0",
    brightBlack: "#64748b",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fde68a",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#f8fafc",
  };
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
      return t("panels.quickCommands.statusIdle");
  }
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export function QuickCommandOutputPanel({ api }: Props) {
  const { t } = useI18n();
  const {
    panelOpen,
    panelCollapsed,
    setPanelCollapsed,
    setPanelOpen,
    runDetail,
    recentRuns,
    activeRuns,
    focusRun,
    cancelActiveRun,
    rerunActive,
    clearEndedView,
    streamError,
    deepLinkUnavailable,
    clearDeepLinkUnavailable,
  } = api;

  const [dockHeight, setDockHeight] = useState(DEFAULT_DOCK_HEIGHT);
  const [elapsedMs, setElapsedMs] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenRunIdRef = useRef<string | null>(null);
  const writtenLenRef = useRef(0);

  const tabs = useMemo(() => {
    const map = new Map<string, typeof runDetail extends infer R ? NonNullable<R> | (typeof recentRuns)[number] : never>();
    for (const run of [...activeRuns, ...recentRuns]) {
      if (!map.has(run.id)) map.set(run.id, run);
    }
    if (runDetail) map.set(runDetail.id, runDetail);
    return Array.from(map.values()).slice(0, 12);
  }, [activeRuns, recentRuns, runDetail]);

  useEffect(() => {
    if (!runDetail || !isQuickCommandActiveStatus(runDetail.status)) {
      setElapsedMs(runDetail?.durationMs ?? 0);
      return;
    }
    const started = Date.parse(runDetail.startedAt);
    const tick = () => setElapsedMs(Math.max(0, Date.now() - started));
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [runDetail]);

  useEffect(() => {
    if (!panelOpen || panelCollapsed) return;
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: true,
      disableStdin: true,
      fontFamily: "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12,
      theme: getTerminalTheme(),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    writtenRunIdRef.current = null;
    writtenLenRef.current = 0;

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // ignore fit races during unmount
      }
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [panelOpen, panelCollapsed]);

  useEffect(() => {
    const term = termRef.current;
    if (!term || !runDetail) return;
    const text = runDetail.outputText ?? "";
    if (writtenRunIdRef.current !== runDetail.id) {
      term.reset();
      term.write(text);
      writtenRunIdRef.current = runDetail.id;
      writtenLenRef.current = text.length;
      return;
    }
    if (text.length < writtenLenRef.current) {
      term.reset();
      term.write(text);
      writtenLenRef.current = text.length;
      return;
    }
    if (text.length > writtenLenRef.current) {
      term.write(text.slice(writtenLenRef.current));
      writtenLenRef.current = text.length;
    }
  }, [runDetail]);

  if (!panelOpen) return null;

  const active = runDetail;
  const running = active ? isQuickCommandActiveStatus(active.status) : false;
  const finished = active ? isQuickCommandTerminalStatus(active.status) : false;

  const handleDockResizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = dockHeight;
    const onMove = (moveEvent: PointerEvent) => {
      const delta = startY - moveEvent.clientY;
      setDockHeight(Math.max(MIN_DOCK_HEIGHT, Math.min(Math.round(window.innerHeight * 0.7), startHeight + delta)));
      window.requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
        } catch {
          // ignore
        }
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      className={`quick-command-panel-root${panelCollapsed ? " is-collapsed" : ""}`}
      style={{ height: panelCollapsed ? HEADER_HEIGHT : dockHeight, minHeight: panelCollapsed ? HEADER_HEIGHT : MIN_DOCK_HEIGHT }}
    >
      {!panelCollapsed && (
        <div
          className="quick-command-panel-resize"
          onPointerDown={handleDockResizePointerDown}
          title={t("panels.quickCommands.resize")}
        />
      )}
      <div className="quick-command-panel-header" style={{ height: HEADER_HEIGHT }}>
        <button
          type="button"
          className="quick-command-panel-icon-btn"
          onClick={() => setPanelCollapsed((value) => !value)}
          title={panelCollapsed ? t("panels.quickCommands.expand") : t("panels.quickCommands.collapse")}
        >
          {panelCollapsed ? "▴" : "▾"}
        </button>
        <span className="quick-command-panel-title">{t("panels.quickCommands.panelTitle")}</span>
        <span className={`quick-command-panel-status is-${active?.status ?? "idle"}`}>
          {statusLabel(active?.status, t)}
        </span>
        {active && (
          <>
            <span className="quick-command-panel-meta" title={active.name}>{active.name}</span>
            <span className="quick-command-panel-meta">{formatDuration(running ? elapsedMs : active.durationMs)}</span>
            {finished && active.exitCode != null && (
              <span className="quick-command-panel-meta">exit {active.exitCode}</span>
            )}
            {finished && active.exitCode == null && active.exitReason && (
              <span className="quick-command-panel-meta" title={active.exitReason}>{active.exitReason}</span>
            )}
          </>
        )}
        <div className="quick-command-panel-actions">
          {running && (
            <button type="button" className="quick-command-panel-action danger" onClick={() => void cancelActiveRun()}>
              {t("panels.quickCommands.stop")}
            </button>
          )}
          {finished && (
            <button type="button" className="quick-command-panel-action" onClick={() => void rerunActive()}>
              {t("panels.quickCommands.rerun")}
            </button>
          )}
          {finished && (
            <button type="button" className="quick-command-panel-action" onClick={() => void clearEndedView()}>
              {t("panels.quickCommands.clear")}
            </button>
          )}
          <button
            type="button"
            className="quick-command-panel-icon-btn"
            title={t("panels.quickCommands.closePanel")}
            onClick={() => {
              // Closing the panel must not stop the run (R9).
              clearDeepLinkUnavailable();
              setPanelOpen(false);
            }}
          >
            ×
          </button>
        </div>
      </div>

      {!panelCollapsed && tabs.length > 0 && (
        <div className="quick-command-panel-tabs" role="tablist" aria-label={t("panels.quickCommands.runs")}>
          {tabs.map((run) => (
            <button
              key={run.id}
              type="button"
              role="tab"
              aria-selected={run.id === active?.id}
              className={`quick-command-panel-tab is-${run.status}${run.id === active?.id ? " is-active" : ""}`}
              onClick={() => focusRun(run, { expand: true })}
              title={run.command}
            >
              <span>{run.name}</span>
              <span className="quick-command-panel-tab-status">{statusLabel(run.status, t)}</span>
            </button>
          ))}
        </div>
      )}

      {!panelCollapsed && streamError && (
        <div className="quick-command-panel-stream-error" role="status">{streamError}</div>
      )}

      {!panelCollapsed && deepLinkUnavailable && (
        <div className="quick-command-panel-stream-error" role="status">
          {t("panels.quickCommands.deepLinkUnavailable")}
        </div>
      )}

      {!panelCollapsed && (
        <div className="quick-command-panel-body">
          {!active ? (
            <div className="quick-command-panel-empty">
              {deepLinkUnavailable
                ? t("panels.quickCommands.deepLinkUnavailable")
                : t("panels.quickCommands.noActiveOutput")}
            </div>
          ) : (
            <div ref={hostRef} className="quick-command-xterm-host" />
          )}
        </div>
      )}
    </div>
  );
}
