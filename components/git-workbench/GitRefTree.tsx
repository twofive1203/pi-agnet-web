"use client";

import { useCallback, useMemo, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { buildGitRemoteRefGroups } from "@/lib/git-workbench-client";
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
  const [expandedRemotes, setExpandedRemotes] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const remoteGroups = useMemo(
    () => buildGitRemoteRefGroups(overview.remotes, overview.remoteBranches),
    [overview.remoteBranches, overview.remotes],
  );

  const openMenu = useCallback((ref: GitWorkbenchRef, trigger: HTMLElement, x: number, y: number) => {
    setMenu({ ref, trigger, x, y });
  }, []);

  const toggleRemote = useCallback((remote: string) => {
    setExpandedRemotes((current) => {
      const next = new Set(current);
      if (next.has(remote)) next.delete(remote);
      else next.add(remote);
      return next;
    });
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
      <RemoteRefGroup
        label={t("git.workbench.remote")}
        groups={remoteGroups}
        expanded={expanded.remote}
        expandedRemotes={expandedRemotes}
        truncated={overview.truncation.refs}
        selectedScope={selectedScope}
        onToggle={() => setExpanded((current) => ({ ...current, remote: !current.remote }))}
        onToggleRemote={toggleRemote}
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
  id: "local" | "tag";
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
            <RefRow
              key={ref.ref}
              refItem={ref}
              selectedScope={selectedScope}
              onSelect={onSelect}
              onOpenMenu={onOpenMenu}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RemoteRefGroup({
  label,
  groups,
  expanded,
  expandedRemotes,
  truncated,
  selectedScope,
  onToggle,
  onToggleRemote,
  onSelect,
  onOpenMenu,
}: {
  label: string;
  groups: ReturnType<typeof buildGitRemoteRefGroups>;
  expanded: boolean;
  expandedRemotes: Set<string>;
  truncated: boolean;
  selectedScope: string;
  onToggle: () => void;
  onToggleRemote: (remote: string) => void;
  onSelect: (scope: string) => void;
  onOpenMenu: (ref: GitWorkbenchRef, trigger: HTMLElement, x: number, y: number) => void;
}) {
  return (
    <section className="git-workbench-ref-group">
      <button type="button" className="git-workbench-ref-group-header" onClick={onToggle} aria-expanded={expanded} aria-controls="git-ref-remote">
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        <span>{label}</span>
        <span className="git-workbench-ref-count">{groups.length}{truncated ? "+" : ""}</span>
      </button>
      {expanded && (
        <div id="git-ref-remote" className="git-workbench-remote-list">
          {groups.length === 0 ? <div className="git-workbench-ref-empty">—</div> : groups.map((group, index) => {
            const remoteExpanded = expandedRemotes.has(group.remote);
            const branchContainerId = `git-ref-remote-${index}`;
            return (
              <div key={group.remote} className="git-workbench-remote-group">
                <button
                  type="button"
                  className="git-workbench-remote-group-header"
                  onClick={() => onToggleRemote(group.remote)}
                  aria-expanded={remoteExpanded}
                  aria-controls={branchContainerId}
                >
                  <span aria-hidden="true">{remoteExpanded ? "▾" : "▸"}</span>
                  <span aria-hidden="true">▱</span>
                  <span>{group.remote}</span>
                  <span className="git-workbench-ref-count">{group.refs.length}</span>
                </button>
                {remoteExpanded && (
                  <div id={branchContainerId} className="git-workbench-remote-branches">
                    {group.refs.length === 0 ? <div className="git-workbench-ref-empty">—</div> : group.refs.map((ref) => (
                      <RefRow
                        key={ref.ref}
                        refItem={ref}
                        displayName={ref.name.startsWith(`${group.remote}/`) ? ref.name.slice(group.remote.length + 1) : ref.name}
                        selectedScope={selectedScope}
                        onSelect={onSelect}
                        onOpenMenu={onOpenMenu}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function RefRow({
  refItem,
  displayName = refItem.name,
  selectedScope,
  onSelect,
  onOpenMenu,
}: {
  refItem: GitWorkbenchRef;
  displayName?: string;
  selectedScope: string;
  onSelect: (scope: string) => void;
  onOpenMenu: (ref: GitWorkbenchRef, trigger: HTMLElement, x: number, y: number) => void;
}) {
  return (
    <div
      className={`git-workbench-ref-row${selectedScope === refItem.ref ? " is-selected" : ""}`}
      onContextMenu={(event) => {
        if (refItem.kind === "tag") return;
        event.preventDefault();
        onOpenMenu(refItem, event.currentTarget, event.clientX, event.clientY);
      }}
    >
      <button type="button" className="git-workbench-ref-select" onClick={() => onSelect(refItem.ref)} title={refItem.name}>
        <span className="git-workbench-ref-icon">{refItem.kind === "tag" ? "◇" : refItem.current ? "●" : refItem.kind === "remote" ? "⇣" : "○"}</span>
        <span className="git-workbench-ref-name">{displayName}</span>
        {refItem.upstreamName && <small>{refItem.upstreamName}</small>}
      </button>
      {refItem.kind !== "tag" && (
        <button
          type="button"
          className="git-workbench-more-button"
          aria-label={`${refItem.name} actions`}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenMenu(refItem, event.currentTarget, rect.right, rect.bottom);
          }}
        >
          ⋯
        </button>
      )}
    </div>
  );
}
