"use client";

import type { WorkflowTaskDetail } from "@/lib/workflow-types";
import type { WorkflowPhaseLabel } from "@/lib/workflow-guidance";
import { useT } from "./I18nProvider";

interface Props {
  task: Pick<WorkflowTaskDetail, "id" | "title" | "status" | "activeRunId">;
  phase: WorkflowPhaseLabel;
  onClick: () => void;
}

function phaseColor(phase: WorkflowPhaseLabel): string {
  switch (phase) {
    case "finish":
      return "#22c55e";
    case "execute":
      return "#60a5fa";
    case "plan":
      return "#f59e0b";
    default:
      return "var(--text-dim)";
  }
}

export function WorkflowSessionWidget({ task, phase, onClick }: Props) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      title={t("workflow.sessionWidgetTitle")}
      style={{
        position: "fixed",
        right: 18,
        bottom: 88,
        zIndex: 240,
        maxWidth: 280,
        textAlign: "left",
        border: "1px solid var(--border)",
        borderRadius: 14,
        background: "color-mix(in srgb, var(--bg-panel) 92%, transparent)",
        boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
        padding: "10px 12px",
        cursor: "pointer",
        color: "var(--text)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: phaseColor(phase) }}>
          Workflow · {t(`workflow.phase.${phase}`)}
        </span>
        {task.activeRunId && (
          <span style={{ fontSize: 10, color: "#f59e0b", fontWeight: 700 }}>{t("workflow.running")}</span>
        )}
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {task.title}
      </div>
      <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
        {task.id} · {t(`workflow.status.${task.status}`)}
      </div>
    </button>
  );
}
