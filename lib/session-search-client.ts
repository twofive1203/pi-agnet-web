/**
 * Client-safe helpers for workspace session search request isolation.
 * Kept free of React so smoke tests can import without the client bundle.
 */

/** Pure gate for applying a debounced search response after cwd/query races. */
export function shouldApplySessionSearchResponse(options: {
  aborted: boolean;
  requestCwd: string;
  activeCwd: string | null;
  requestSeq: number;
  latestSeq: number;
}): boolean {
  if (options.aborted) return false;
  if (options.requestSeq !== options.latestSeq) return false;
  if (options.activeCwd !== options.requestCwd) return false;
  return true;
}
