"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/components/I18nProvider";
import { SettingsButton } from "@/components/ui/SettingsPrimitives";
import type { CommitAction } from "./GitLogPane";
import type { GitWorkbenchOperationDraft } from "@/hooks/useGitWorkbench";
import type { GitCommitDetail, GitGraphCommit, GitResetMode, GitWorkbenchOverview, GitWorkbenchRef } from "@/lib/types";

export type GitWorkbenchDialogRequest =
  | { type: "commit"; action: CommitAction; commit: GitGraphCommit; detail: GitCommitDetail; trigger: HTMLElement }
  | { type: "ref"; action: "checkout" | "push"; ref: GitWorkbenchRef; trigger: HTMLElement };

export function GitWorkbenchDialogs({
  request,
  overview,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  request: GitWorkbenchDialogRequest | null;
  overview: GitWorkbenchOverview;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (draft: GitWorkbenchOperationDraft) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const [resetMode, setResetMode] = useState<GitResetMode>("mixed");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [checkout, setCheckout] = useState(false);
  const [remote, setRemote] = useState("");
  const [target, setTarget] = useState("");
  const [setUpstream, setSetUpstream] = useState(false);

  const closeAndRestore = useCallback(() => {
    onClose();
    if (request) requestAnimationFrame(() => request.trigger.focus());
  }, [onClose, request]);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!request) return;
    setResetMode("mixed");
    setConfirmation("");
    setCheckout(false);
    if (request.type === "commit") {
      setMessage([request.detail.subject, request.detail.body].filter(Boolean).join("\n\n"));
      setName("");
    } else if (request.action === "push") {
      const upstream = request.ref.upstreamRef?.replace(/^refs\/remotes\//, "") ?? "";
      const slash = upstream.indexOf("/");
      const upstreamRemote = slash > 0 ? upstream.slice(0, slash) : "";
      const upstreamTarget = slash > 0 ? upstream.slice(slash + 1) : "";
      setRemote(upstreamRemote || overview.remotes[0] || "");
      setTarget(upstreamTarget || request.ref.name);
      setSetUpstream(!request.ref.upstreamRef);
    } else {
      const remoteParts = request.ref.name.split("/");
      setName(request.ref.kind === "remote" ? remoteParts.slice(1).join("/") : request.ref.name);
    }
    const frame = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>("input, textarea, select, button:not(:disabled)")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [overview.remotes, request]);

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

  const copy = useMemo(() => dialogCopy(request, t), [request, t]);
  if (!request || !mounted || typeof document === "undefined") return null;

  const selectedCommit = request.type === "commit" ? request.detail : null;
  const shortHash = selectedCommit?.shortHash ?? "";
  const requiresConfirmation = request.type === "commit"
    && (request.action === "drop" || (request.action === "reset" && resetMode === "hard"));
  const valid = request.type === "commit"
    ? request.action === "reword"
      ? Boolean(message.trim())
      : request.action === "create-branch" || request.action === "create-tag"
        ? Boolean(name.trim())
        : requiresConfirmation
          ? confirmation === shortHash || confirmation === selectedCommit?.hash
          : true
    : request.action === "push"
      ? Boolean(remote && target)
      : request.ref.kind === "remote"
        ? Boolean(name.trim())
        : true;

  const submit = async () => {
    let draft: GitWorkbenchOperationDraft;
    if (request.type === "ref") {
      if (request.action === "push") {
        draft = {
          action: "push",
          ref: request.ref.ref,
          remote,
          target,
          setUpstream,
          expectedRefTip: request.ref.target,
        };
      } else if (request.ref.kind === "remote") {
        draft = { action: "checkout-remote", ref: request.ref.ref, localName: name.trim() };
      } else {
        draft = { action: "checkout-local", ref: request.ref.ref };
      }
    } else {
      switch (request.action) {
        case "cherry-pick": draft = { action: "cherry-pick", hash: request.commit.hash }; break;
        case "revert": draft = { action: "revert", hash: request.commit.hash }; break;
        case "reset": draft = { action: "reset", hash: request.commit.hash, mode: resetMode, confirmTarget: confirmation || undefined }; break;
        case "reword": draft = { action: "reword", hash: request.commit.hash, message }; break;
        case "drop": draft = { action: "drop", hash: request.commit.hash }; break;
        case "create-branch": draft = { action: "create-branch", hash: request.commit.hash, name: name.trim(), checkout }; break;
        case "create-tag": draft = { action: "create-tag", hash: request.commit.hash, name: name.trim() }; break;
      }
    }
    if (await onSubmit(draft)) closeAndRestore();
  };

  return createPortal(
    <div className="pi-modal-overlay git-workbench-dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="git-workbench-dialog-title" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) closeAndRestore();
    }}>
      <div
        ref={panelRef}
        className="pi-modal-panel git-workbench-dialog"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])];
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}
      >
        <div className="pi-modal-header">
          <div className="pi-modal-header-copy">
            <div id="git-workbench-dialog-title" className="pi-modal-title">{copy.title}</div>
            <div className="git-workbench-dialog-subtitle">{copy.subtitle}</div>
          </div>
          <button type="button" className="pi-modal-close" onClick={closeAndRestore} disabled={busy} aria-label={t("common.close")}>×</button>
        </div>
        <div className="pi-modal-body git-workbench-dialog-body">
          <p>{copy.description}</p>
          {selectedCommit && (
            <div className="git-workbench-dialog-target"><code>{shortHash}</code><span>{selectedCommit.subject}</span></div>
          )}
          {request.type === "commit" && request.action === "reset" && (
            <label className="git-workbench-field">
              <span>{t("git.workbench.dialog.resetMode")}</span>
              <select value={resetMode} onChange={(event) => setResetMode(event.currentTarget.value as GitResetMode)}>
                <option value="soft">Soft — {t("git.workbench.dialog.resetSoft")}</option>
                <option value="mixed">Mixed — {t("git.workbench.dialog.resetMixed")}</option>
                <option value="hard">Hard — {t("git.workbench.dialog.resetHard")}</option>
                <option value="keep">Keep — {t("git.workbench.dialog.resetKeep")}</option>
              </select>
            </label>
          )}
          {request.type === "commit" && request.action === "reword" && (
            <label className="git-workbench-field">
              <span>{t("git.workbench.dialog.commitMessage")}</span>
              <textarea value={message} onChange={(event) => setMessage(event.currentTarget.value)} rows={7} maxLength={16000} />
            </label>
          )}
          {request.type === "commit" && (request.action === "create-branch" || request.action === "create-tag") && (
            <>
              <label className="git-workbench-field">
                <span>{request.action === "create-branch" ? t("git.workbench.dialog.branchName") : t("git.workbench.dialog.tagName")}</span>
                <input value={name} onChange={(event) => setName(event.currentTarget.value)} autoComplete="off" />
              </label>
              {request.action === "create-branch" && (
                <label className="git-workbench-check"><input type="checkbox" checked={checkout} onChange={(event) => setCheckout(event.currentTarget.checked)} /> {t("git.workbench.dialog.checkoutBranch")}</label>
              )}
            </>
          )}
          {request.type === "ref" && request.action === "checkout" && request.ref.kind === "remote" && (
            <label className="git-workbench-field">
              <span>{t("git.workbench.dialog.localBranchName")}</span>
              <input value={name} onChange={(event) => setName(event.currentTarget.value)} autoComplete="off" />
            </label>
          )}
          {request.type === "ref" && request.action === "push" && (
            <>
              <div className="git-workbench-push-preview"><code>{request.ref.name}</code><span>→</span><code>{remote || "?"}/{target || "?"}</code></div>
              <div className="git-workbench-dialog-note">{t("git.workbench.dialog.outgoing", { count: request.ref.ahead ?? 0 })}</div>
              <label className="git-workbench-field">
                <span>{t("git.workbench.dialog.remote")}</span>
                <select value={remote} onChange={(event) => setRemote(event.currentTarget.value)}>
                  {overview.remotes.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
              <label className="git-workbench-field">
                <span>{t("git.workbench.dialog.targetBranch")}</span>
                <input value={target} onChange={(event) => setTarget(event.currentTarget.value)} autoComplete="off" />
              </label>
              {!request.ref.upstreamRef && <label className="git-workbench-check"><input type="checkbox" checked={setUpstream} onChange={(event) => setSetUpstream(event.currentTarget.checked)} /> {t("git.workbench.dialog.setUpstream")}</label>}
              <div className="git-workbench-dialog-note is-warning">{t("git.workbench.dialog.noForcePush")}</div>
            </>
          )}
          {requiresConfirmation && (
            <label className="git-workbench-field is-danger">
              <span>{t("git.workbench.dialog.typeHash", { hash: shortHash })}</span>
              <input value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value.trim())} autoComplete="off" />
            </label>
          )}
          {error && <div className="git-workbench-dialog-error" role="alert">{error}</div>}
        </div>
        <div className="pi-modal-footer">
          <SettingsButton onClick={closeAndRestore} disabled={busy}>{t("common.cancel")}</SettingsButton>
          <SettingsButton variant={copy.danger ? "danger" : "primary"} onClick={() => void submit()} disabled={!valid || busy}>
            {busy ? t("git.workbench.dialog.running") : copy.confirm}
          </SettingsButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function dialogCopy(
  request: GitWorkbenchDialogRequest | null,
  t: (key: string, params?: Record<string, string | number>) => string,
): { title: string; subtitle: string; description: string; confirm: string; danger: boolean } {
  if (!request) return { title: "", subtitle: "", description: "", confirm: "", danger: false };
  const subtitle = request.type === "commit" ? `${request.detail.shortHash} · ${request.detail.subject}` : request.ref.name;
  const key = request.type === "commit" ? request.action : request.action === "push" ? "push" : "checkout";
  return {
    title: t(`git.workbench.dialog.${key}.title`),
    subtitle,
    description: t(`git.workbench.dialog.${key}.description`),
    confirm: t(`git.workbench.dialog.${key}.confirm`),
    danger: key === "reset" || key === "drop",
  };
}
