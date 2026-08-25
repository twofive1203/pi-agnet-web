"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/components/I18nProvider";
import { SettingsButton } from "@/components/ui/SettingsPrimitives";
import type { GitStashEntry, GitStatusInfo } from "@/lib/types";

export type GitStashDialogRequest =
  | { type: "create"; trigger: HTMLElement }
  | {
    type: "action";
    action: "apply" | "pop" | "drop";
    entry: GitStashEntry;
    trigger: HTMLElement;
    expectedRevision: string;
    expectedTargetRevision: string;
    targetLabel: string;
  };

export function GitStashDialogs({
  request,
  status,
  busy,
  error,
  agentRunning,
  onClose,
  onCreate,
  onAction,
}: {
  request: GitStashDialogRequest | null;
  status: GitStatusInfo;
  busy: boolean;
  error: string | null;
  agentRunning: boolean;
  onClose: () => void;
  onCreate: (name: string, includeUntracked: boolean) => Promise<boolean>;
  onAction: (
    action: "apply" | "pop" | "drop",
    oid: string,
    reinstateIndex: boolean,
    expectedRevision: string,
    expectedTargetRevision: string,
  ) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [mounted, setMounted] = useState(false);
  const [name, setName] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [reinstateIndex, setReinstateIndex] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  const closeAndRestore = useCallback(() => {
    const trigger = request?.trigger;
    onClose();
    requestAnimationFrame(() => {
      if (trigger?.isConnected && !trigger.closest("[hidden]")) trigger.focus();
      else document.getElementById("git-panel-tab-stash")?.focus();
    });
  }, [onClose, request]);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!request) return;
    setName("");
    setIncludeUntracked(true);
    setReinstateIndex(false);
    setConfirmation("");
    const frame = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>("input, button:not(:disabled)")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        closeAndRestore();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, closeAndRestore, request]);

  if (!request || !mounted || typeof document === "undefined") return null;

  const isCreate = request.type === "create";
  const isDrop = request.type === "action" && request.action === "drop";
  const validName = Boolean(name.trim()) && name.trim().length <= 200 && !/[\r\n\0]/.test(name);
  const valid = isCreate ? validName : isDrop ? confirmation === request.entry.name : true;
  const worktreeActionBlocked = agentRunning && (isCreate || (request.type === "action" && request.action !== "drop"));
  const title = isCreate
    ? t("git.stashManager.createTitle")
    : t(`git.stashManager.${request.action}Title`);
  const description = isCreate
    ? t("git.stashManager.createDescription")
    : t(`git.stashManager.${request.action}Description`);
  const confirmLabel = isCreate
    ? t("git.stashManager.create")
    : t(`git.stashManager.${request.action}`);

  const submit = async () => {
    const success = request.type === "create"
      ? await onCreate(name.trim(), includeUntracked)
      : await onAction(
        request.action,
        request.entry.oid,
        reinstateIndex,
        request.expectedRevision,
        request.expectedTargetRevision,
      );
    if (success) closeAndRestore();
  };

  return createPortal(
    <div
      className="pi-modal-overlay git-stash-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="git-stash-dialog-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) closeAndRestore();
      }}
    >
      <div
        ref={panelRef}
        className="pi-modal-panel git-stash-dialog"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])];
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}
      >
        <div className="pi-modal-header">
          <div className="pi-modal-header-copy">
            <div id="git-stash-dialog-title" className="pi-modal-title">{title}</div>
            <div className="git-stash-dialog-subtitle">{description}</div>
          </div>
          <button type="button" className="pi-modal-close" onClick={closeAndRestore} disabled={busy} aria-label={t("common.close")}>×</button>
        </div>
        <div className="pi-modal-body git-stash-dialog-body">
          {request.type === "create" ? (
            <>
              <div className="git-stash-change-summary">
                <span>{t("git.stagedShort")}: <strong>{status.staged.length}</strong></span>
                <span>{t("git.unstagedShort")}: <strong>{status.unstaged.length}</strong></span>
                <span>{t("git.untracked")}: <strong>{status.untracked.length}</strong></span>
              </div>
              <label className="git-stash-field">
                <span>{t("git.stashManager.name")}</span>
                <input value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={200} autoComplete="off" />
                <small>{t("git.stashManager.nameHelp")}</small>
              </label>
              <label className="git-stash-check">
                <input type="checkbox" checked={includeUntracked} onChange={(event) => setIncludeUntracked(event.currentTarget.checked)} />
                <span>{t("git.stashManager.includeUntracked")}</span>
              </label>
              <div className="git-stash-dialog-note">{t("git.stashManager.ignoredExcluded")}</div>
            </>
          ) : (
            <>
              <div className="git-stash-dialog-target"><code>{request.entry.shortOid}</code><span>{request.entry.name}</span></div>
              <div className="git-stash-dialog-target"><span>{t("git.stashManager.currentTarget")}</span><strong>{request.targetLabel}</strong></div>
              {request.action !== "drop" && (
                <>
                  <label className="git-stash-check">
                    <input type="checkbox" checked={reinstateIndex} onChange={(event) => setReinstateIndex(event.currentTarget.checked)} />
                    <span>{t("git.stashManager.reinstateIndex")}</span>
                  </label>
                  <div className="git-stash-dialog-note is-warning">
                    {request.action === "apply" ? t("git.stashManager.applyKeeps") : t("git.stashManager.popDeletesOnSuccess")}
                  </div>
                </>
              )}
              {request.action === "drop" && (
                <label className="git-stash-field is-danger">
                  <span>{t("git.stashManager.typeName", { name: request.entry.name })}</span>
                  <input value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} autoComplete="off" />
                </label>
              )}
            </>
          )}
          {worktreeActionBlocked && <div className="git-stash-dialog-error" role="alert">{t("git.stashManager.agentRunningDisabled")}</div>}
          {error && <div className="git-stash-dialog-error" role="alert">{error}</div>}
        </div>
        <div className="pi-modal-footer">
          <SettingsButton onClick={closeAndRestore} disabled={busy}>{t("common.cancel")}</SettingsButton>
          <SettingsButton variant={isDrop ? "danger" : "primary"} onClick={() => void submit()} disabled={!valid || busy || worktreeActionBlocked}>
            {busy ? t("git.stashManager.running") : confirmLabel}
          </SettingsButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}
