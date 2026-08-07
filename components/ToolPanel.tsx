"use client";

import { useEffect, useMemo, useRef } from "react";
import { useI18n } from "@/components/I18nProvider";

export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
}

export type ToolPreset = "all" | "read-only" | "none";

const READ_ONLY_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);

export function getPresetFromTools(tools: ToolEntry[]): ToolPreset {
  const activeTools = tools.filter(t => t.active);
  if (activeTools.length === 0) return "none";
  if (activeTools.length === tools.length) return "all";

  const hasOnlyReadOnlyTools = activeTools.every(t => READ_ONLY_TOOL_NAMES.has(t.name));
  return hasOnlyReadOnlyTools ? "read-only" : "all";
}

interface Props {
  tools: ToolEntry[];
  onPreset: (preset: ToolPreset) => void;
  onClose: () => void;
}

export function ToolPanel({ tools, onPreset, onClose }: Props) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const current = getPresetFromTools(tools);

  const presets = useMemo(() => ([
    { id: "all" as const, label: t("chat.toolPresetAll"), desc: t("chat.toolPresetAllDesc") },
    { id: "read-only" as const, label: t("chat.toolPresetReadOnly"), desc: t("chat.toolPresetReadOnlyDesc") },
    { id: "none" as const, label: t("chat.toolPresetOff"), desc: t("chat.toolPresetOffDesc") },
  ]), [t]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const currentIndex = presets.findIndex(p => p.id === current);

  return (
    <div ref={panelRef} className="tool-preset-panel">
      <div className="tool-preset-segments">
        {presets.map((preset) => {
          const isActive = current === preset.id;
          return (
            <button
              key={preset.id}
              className={isActive ? "tool-preset-segment is-active" : "tool-preset-segment"}
              onClick={() => { onPreset(preset.id); onClose(); }}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <div className="tool-preset-description">
        {currentIndex >= 0 ? presets[currentIndex].desc : ""}
        {current === "none" && <span>{t("chat.toolPresetNoneExtra")}</span>}
      </div>

      <div className="tool-preset-track">
        {presets.map((_, i) => (
          <div key={i} className={i <= currentIndex ? "tool-preset-track-step is-complete" : "tool-preset-track-step"} />
        ))}
      </div>

      <div className="tool-preset-footnote">{t("chat.toolPresetFootnote")}</div>
    </div>
  );
}
