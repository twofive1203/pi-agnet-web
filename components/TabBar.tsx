"use client";

import { getFileIcon } from "./FileIcons";
import { useI18n } from "@/components/I18nProvider";

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  line?: number;
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab }: Props) {
  const { t } = useI18n();

  return (
    <div className="preview-tab-bar" role="tablist" aria-label={t("common.workbench.preview")}>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={isActive ? 0 : -1}
            aria-selected={isActive}
            onClick={() => onSelectTab(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectTab(tab.id);
              }
            }}
            className={`preview-tab${isActive ? " is-active" : ""}`}
          >
            <span className="preview-tab-icon">{getFileIcon(tab.label, 13)}</span>
            <span className="preview-tab-label" title={tab.filePath}>
              {tab.label}
            </span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              className="preview-tab-close"
              title={t("chat.closeTab")}
              aria-label={`${t("chat.closeTab")}: ${tab.label}`}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
