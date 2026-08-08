/** Default max active sessions returned for one project in the sidebar browser. */
export const RECENT_SESSIONS_LIMIT = 10;

/** Default max archived sessions returned per page for one project. */
export const ARCHIVED_SESSIONS_LIMIT = 20;

/**
 * Max extra ancestor sessions auto-included when a page's fork parents fall
 * outside the current window (parent-closure for sidebar tree stability).
 */
export const PARENT_CLOSURE_LIMIT = 10;

/** Client debounce for workspace session search requests (ms). */
export const SESSION_SEARCH_DEBOUNCE_MS = 250;

/** Minimum non-whitespace query length before the client issues a search. */
export const SESSION_SEARCH_MIN_QUERY_CHARS = 1;

/** Default max sessions returned by workspace search. */
export const SESSION_SEARCH_DEFAULT_LIMIT = 50;

/** Hard cap on workspace search results. */
export const SESSION_SEARCH_MAX_LIMIT = 100;
