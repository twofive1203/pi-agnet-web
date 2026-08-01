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
    return <span className={`subagent-observation-dot${counts.failed > 0 ? " is-danger" : " is-warning"}`} />;
  }
  if (counts.failed > 0) return <span className="subagent-observation-mark is-danger">!</span>;
  if (counts.completed > 0) return <span className="subagent-observation-mark is-success">✓</span>;
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
