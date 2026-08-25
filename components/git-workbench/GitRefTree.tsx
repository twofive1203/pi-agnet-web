"use client";

import { useCallback, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import type { GitWorkbenchOverview, GitWorkbenchRef } from "@/lib/types";
import { GitContextMenu, type GitContextMenuItem } from "./GitContextMenu";

type RefAction = "checkout" | "push";

interface MenuState {
  x: number;
  y: number;
  trigger: HTMLElement;
  ref: GitWorkbenchRef;
}

export function GitRefTree({
  overview,
  selectedScope,
  writesDisabled,
  onSelectScope,
  onAction,
}: {
  overview: GitWorkbenchOverview;
  selectedScope: string;
  writesDisabled: boolean;
  onSelectScope: (scope: string) => void;
  onAction: (action: RefAction, ref: GitWorkbenchRef, trigger: HTMLElement) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState({ local: false, remote: false, tag: false });
  const [menu, setMenu] = useState<MenuState | null>(null);

  const openMenu = useCallback((ref: GitWorkbenchRef, trigger: HTMLElement, x: number, y: number) => {
    setMenu({ ref, trigger, x, y });
  }, []);

  const menuItems = menu ? (() => {
    const items: GitContextMenuItem[] = [];
    if (menu.ref.kind === "local") {
      const checkoutReason = writesDisabled
        ? t("git.workbench.writeBlocked")
        : menu.ref.current
          ? t("git.switchDisabledCurrent")
          : menu.ref.checkedOutPath
            ? t("git.workbench.reason.branchInUse")
            : undefined;
      items.push({
        id: "checkout",
        label: t("git.workbench.actions.checkout"),
        disabled: Boolean(checkoutReason),
        reason: checkoutReason,
        onSelect: () => onAction("checkout", menu.ref, menu.trigger),
      });
      items.push({
        id: "push",
        label: t("git.workbench.actions.push"),
        disabled: writesDisabled,
        reason: writesDisabled ? t("git.workbench.writeBlocked") : undefined,
        onSelect: () => onAction("push", menu.ref, menu.trigger),
      });
    } else if (menu.ref.kind === "remote") {
      items.push({
        id: "checkout",
        label: t("git.workbench.actions.checkoutTracking"),
        disabled: writesDisabled,
        reason: writesDisabled ? t("git.workbench.writeBlocked") : undefined,
        onSelect: () => onAction("checkout", menu.ref, menu.trigger),
      });
    }
    return items;
  })() : [];

  return (
    <aside className="git-workbench-refs" aria-label={t("git.workbench.refs") }>
      <button
        type="button"
        className={`git-workbench-ref-row is-all${selectedScope === "all" ? " is-selected" : ""}`}
        onClick={() => onSelectScope("all")}
      >
        <span className="git-workbench-ref-icon">◎</span>
        <span>{t("git.workbench.all")}</span>
      </button>
      <RefGroup
        id="local"
        label={t("git.workbench.local")}
        refs={overview.localBranches}
        expanded={expanded.local}
        truncated={overview.truncation.refs}
        selectedScope={selectedScope}
        onToggle={() => setExpanded((current) => ({ ...current, local: !current.local }))}
        onSelect={onSelectScope}
        onOpenMenu={openMenu}
      />
      <RefGroup
        id="remote"
        label={t("git.workbench.remote")}
        refs={overview.remoteBranches}
        expanded={expanded.remote}
        truncated={overview.truncation.refs}
        selectedScope={selectedScope}
        onToggle={() => setExpanded((current) => ({ ...current, remote: !current.remote }))}
        onSelect={onSelectScope}
        onOpenMenu={openMenu}
      />
      <RefGroup
        id="tag"
        label={t("git.workbench.tags")}
        refs={overview.tags}
        expanded={expanded.tag}
        truncated={overview.truncation.refs}
        selectedScope={selectedScope}
        onToggle={() => setExpanded((current) => ({ ...current, tag: !current.tag }))}
        onSelect={onSelectScope}
        onOpenMenu={openMenu}
      />
      <div className="git-workbench-remote-note">{t("git.workbench.remoteSnapshotHelp")}</div>
      {menu && menuItems.length > 0 && (
        <GitContextMenu x={menu.x} y={menu.y} trigger={menu.trigger} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </aside>
  );
}

function RefGroup({
  id,
  label,
  refs,
  expanded,
  truncated,
  selectedScope,
  onToggle,
  onSelect,
  onOpenMenu,
}: {
  id: "local" | "remote" | "tag";
  label: string;
  refs: GitWorkbenchRef[];
  expanded: boolean;
  truncated: boolean;
  selectedScope: string;
  onToggle: () => void;
  onSelect: (scope: string) => void;
  onOpenMenu: (ref: GitWorkbenchRef, trigger: HTMLElement, x: number, y: number) => void;
}) {
  return (
    <section className="git-workbench-ref-group">
      <button type="button" className="git-workbench-ref-group-header" onClick={onToggle} aria-expanded={expanded} aria-controls={`git-ref-${id}`}>
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        <span>{label}</span>
        <span className="git-workbench-ref-count">{refs.length}{truncated ? "+" : ""}</span>
      </button>
      {expanded && (
        <div id={`git-ref-${id}`}>
          {refs.length === 0 ? <div className="git-workbench-ref-empty">—</div> : refs.map((ref) => (
            <div
              key={ref.ref}
              className={`git-workbench-ref-row${selectedScope === ref.ref ? " is-selected" : ""}`}
              onContextMenu={(event) => {
                if (ref.kind === "tag") return;
                event.preventDefault();
                onOpenMenu(ref, event.currentTarget, event.clientX, event.clientY);
              }}
            >
              <button type="button" className="git-workbench-ref-select" onClick={() => onSelect(ref.ref)} title={ref.name}>
                <span className="git-workbench-ref-icon">{ref.kind === "tag" ? "◇" : ref.current ? "●" : ref.kind === "remote" ? "⇣" : "○"}</span>
                <span className="git-workbench-ref-name">{ref.name}</span>
                {ref.upstreamName && <small>{ref.upstreamName}</small>}
              </button>
              {ref.kind !== "tag" && (
                <button
                  type="button"
                  className="git-workbench-more-button"
                  aria-label={`${ref.name} actions`}
                  onClick={(event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    onOpenMenu(ref, event.currentTarget, rect.right, rect.bottom);
                  }}
                >
                  ⋯
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
