import type { SessionPerformanceSummary } from "./types";

/**
 * Keep the newest cumulative performance summary when live SSE and session-detail
 * responses complete out of order. A missing detail summary must not erase live
 * samples collected during a brand-new session's first prompt.
 */
export function selectLatestSessionPerformance(
  current: SessionPerformanceSummary | null,
  candidate: SessionPerformanceSummary | null | undefined,
): SessionPerformanceSummary | null {
  if (!candidate) return current;
  if (!current || candidate.sampleCount >= current.sampleCount) return candidate;
  return current;
}
