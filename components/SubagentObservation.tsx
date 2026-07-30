"use client";

import { Profiler, useSyncExternalStore } from "react";
import { SubagentPanel } from "./SubagentPanel";
import type { SubagentStore } from "@/lib/subagent-store";
import {
  recordSubagentClientMetric,
  SUBAGENT_BROWSER_OBSERVABILITY_ENABLED,
} from "@/lib/subagent-observability-client";

export function SubagentBadgeIndicator({ store }: { store: SubagentStore }) {
  const counts = useSyncExternalStore(
    store.subscribeCounts,
    store.getCountsSnapshot,
    store.getServerCountsSnapshot,
  );

  if (counts.running > 0) {
    return (
      <span style={{
        position: "absolute", top: 4, right: 4,
        width: 7, height: 7, borderRadius: "50%",
        background: counts.failed > 0 ? "#ef4444" : "#f59e0b",
      }} />
    );
  }
  if (counts.failed > 0) {
    return <span style={{ fontSize: 10, color: "#ef4444", marginLeft: 2 }}>!</span>;
  }
  if (counts.completed > 0) {
    return <span style={{ fontSize: 10, color: "#22c55e", marginLeft: 2 }}>✓</span>;
  }
  return null;
}

export function StoredSubagentPanel({ store }: { store: SubagentStore }) {
  const runs = useSyncExternalStore(
    store.subscribeRuns,
    store.getRunsSnapshot,
    store.getServerRunsSnapshot,
  );
  recordSubagentClientMetric("appShellSubagentRenders");

  const panel = <SubagentPanel runs={runs} />;
  if (!SUBAGENT_BROWSER_OBSERVABILITY_ENABLED) return panel;
  return (
    <Profiler
      id="SubagentPanel"
      onRender={(_id, _phase, actualDuration) => {
        recordSubagentClientMetric("panelRenderMs", actualDuration);
      }}
    >
      {panel}
    </Profiler>
  );
}
