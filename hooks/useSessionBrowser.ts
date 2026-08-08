"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectSummary, SessionInfo } from "@/lib/types";
import {
  ARCHIVED_SESSIONS_LIMIT,
  RECENT_SESSIONS_LIMIT,
  SESSION_SEARCH_DEBOUNCE_MS,
  SESSION_SEARCH_DEFAULT_LIMIT,
  SESSION_SEARCH_MIN_QUERY_CHARS,
} from "@/lib/session-reader-constants";
import { shouldApplySessionSearchResponse } from "@/lib/session-search-client";
import { mergeSessionsById } from "@/lib/sidebar-session-tree";

export { shouldApplySessionSearchResponse } from "@/lib/session-search-client";

export interface SessionPageResponse {
  sessions: SessionInfo[];
  total?: number;
  hasMore?: boolean;
  nextBefore?: string | null;
  nextBeforePath?: string | null;
  archivedCwds?: string[];
  archivedCounts?: Record<string, number>;
}

export interface SessionSearchResponse {
  sessions: SessionInfo[];
  total?: number;
  hasMore?: boolean;
  query?: string;
  cwd?: string;
  error?: string;
}

export interface UseSessionBrowserOptions {
  selectedCwd: string | null;
  selectedSessionId?: string | null;
  refreshKey?: number;
  /** Debounced search query from the sidebar input (not applied to paged lists). */
  searchQuery?: string;
  /** Called when a non-abort load error occurs. */
  onError?: (message: string) => void;
}

export interface UseSessionBrowserResult {
  projectSummaries: ProjectSummary[];
  projectSessions: SessionInfo[];
  projectSessionsCwd: string | null;
  projectSessionTotal: number;
  hasMoreSessions: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  archivedCwds: string[];
  archivedCounts: Record<string, number>;
  archivedSessions: SessionInfo[];
  archivedTotal: number;
  archivedHasMore: boolean;
  loadingMoreArchived: boolean;
  sessionRefreshDone: boolean;
  /** True when the sidebar is in independent search-results mode. */
  searchActive: boolean;
  searchResults: SessionInfo[];
  searchTotal: number;
  searchHasMore: boolean;
  searchLoading: boolean;
  searchError: string | null;
  loadSessions: (showLoading?: boolean) => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  loadArchivedSessions: (cwd: string, reset?: boolean) => Promise<void>;
  loadMoreArchivedSessions: () => Promise<void>;
  patchSessionIntoList: (info: SessionInfo) => void;
  setArchivedSessions: React.Dispatch<React.SetStateAction<SessionInfo[]>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}

async function readFetchError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data.error === "string" && data.error.trim()) return data.error;
  } catch {
    // ignore non-JSON bodies
  }
  return fallback;
}

/**
 * Sidebar session browser data layer: project summaries, paged active sessions,
 * paged archived sessions, abort/cwd isolation, and selected-session patches.
 */
export function useSessionBrowser(options: UseSessionBrowserOptions): UseSessionBrowserResult {
  const { selectedCwd, selectedSessionId, refreshKey, searchQuery = "", onError } = options;

  const [projectSummaries, setProjectSummaries] = useState<ProjectSummary[]>([]);
  const [projectSessions, setProjectSessions] = useState<SessionInfo[]>([]);
  const [projectSessionsCwd, setProjectSessionsCwd] = useState<string | null>(null);
  const [projectSessionTotal, setProjectSessionTotal] = useState(0);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [nextBeforePath, setNextBeforePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [archivedCwds, setArchivedCwds] = useState<string[]>([]);
  const [archivedCounts, setArchivedCounts] = useState<Record<string, number>>({});
  const [archivedSessions, setArchivedSessions] = useState<SessionInfo[]>([]);
  const [archivedTotal, setArchivedTotal] = useState(0);
  const [archivedHasMore, setArchivedHasMore] = useState(false);
  const [archivedNextBefore, setArchivedNextBefore] = useState<string | null>(null);
  const [archivedNextBeforePath, setArchivedNextBeforePath] = useState<string | null>(null);
  const [loadingMoreArchived, setLoadingMoreArchived] = useState(false);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);

  const [searchResults, setSearchResults] = useState<SessionInfo[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchActive, setSearchActive] = useState(false);

  const selectedCwdRef = useRef<string | null>(null);
  selectedCwdRef.current = selectedCwd;
  const browseAbortRef = useRef<AbortController | null>(null);
  const moreAbortRef = useRef<AbortController | null>(null);
  const archivedAbortRef = useRef<AbortController | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchSeqRef = useRef(0);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const abortBrowseRequests = useCallback(() => {
    browseAbortRef.current?.abort();
    moreAbortRef.current?.abort();
    const next = new AbortController();
    browseAbortRef.current = next;
    return next;
  }, []);

  const applyArchivedMeta = useCallback((data: SessionPageResponse) => {
    if (data.archivedCwds) setArchivedCwds(data.archivedCwds);
    if (data.archivedCounts) setArchivedCounts(data.archivedCounts);
  }, []);

  const loadProjectSessions = useCallback(async (cwd: string, signal?: AbortSignal) => {
    const params = new URLSearchParams({
      cwd,
      limit: String(RECENT_SESSIONS_LIMIT),
    });
    const res = await fetch(`/api/sessions?${params}`, { signal });
    if (!res.ok) throw new Error(await readFetchError(res, `HTTP ${res.status}`));
    const data = (await res.json()) as SessionPageResponse;
    if (signal?.aborted) return;
    // Drop stale responses from a previous project after a fast cwd switch.
    if (selectedCwdRef.current !== cwd) return;

    setProjectSessions(data.sessions ?? []);
    setProjectSessionsCwd(cwd);
    setProjectSessionTotal(data.total ?? data.sessions?.length ?? 0);
    setHasMoreSessions(Boolean(data.hasMore));
    setNextBefore(data.nextBefore ?? null);
    setNextBeforePath(data.nextBeforePath ?? null);
    applyArchivedMeta(data);
  }, [applyArchivedMeta]);

  const loadProjectSummaries = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch("/api/sessions?view=projects", { signal });
    if (!res.ok) throw new Error(await readFetchError(res, `HTTP ${res.status}`));
    const data = (await res.json()) as {
      projects: ProjectSummary[];
      archivedCwds?: string[];
      archivedCounts?: Record<string, number>;
    };
    if (signal?.aborted) return data;
    setProjectSummaries(data.projects ?? []);
    if (data.archivedCwds) setArchivedCwds(data.archivedCwds);
    if (data.archivedCounts) setArchivedCounts(data.archivedCounts);
    return data;
  }, []);

  const loadSessions = useCallback(async (showLoading = false) => {
    const controller = abortBrowseRequests();
    const requestCwd = selectedCwdRef.current;
    try {
      if (showLoading) setLoading(true);
      await loadProjectSummaries(controller.signal);
      if (controller.signal.aborted) return;
      // Re-read cwd after summaries: user may have switched projects mid-flight.
      const cwd = selectedCwdRef.current;
      if (cwd) {
        // If cwd changed during summaries, the selectedCwd effect owns the session load.
        if (cwd === requestCwd || requestCwd == null) {
          await loadProjectSessions(cwd, controller.signal);
        }
      }
      if (controller.signal.aborted) return;
      setError(null);
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      const message = String(e);
      setError(message);
      onErrorRef.current?.(message);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [abortBrowseRequests, loadProjectSessions, loadProjectSummaries]);

  const loadMoreSessions = useCallback(async () => {
    const cwd = selectedCwdRef.current;
    if (!cwd || !hasMoreSessions || loadingMore || !nextBefore) return;

    moreAbortRef.current?.abort();
    const controller = new AbortController();
    moreAbortRef.current = controller;

    try {
      setLoadingMore(true);
      const params = new URLSearchParams({
        cwd,
        limit: String(RECENT_SESSIONS_LIMIT),
        before: nextBefore,
      });
      if (nextBeforePath) params.set("beforePath", nextBeforePath);
      const res = await fetch(`/api/sessions?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error(await readFetchError(res, `HTTP ${res.status}`));
      const data = (await res.json()) as SessionPageResponse;
      if (controller.signal.aborted) return;
      if (selectedCwdRef.current !== cwd) return;

      setProjectSessions((prev) => mergeSessionsById(prev, data.sessions ?? [], "append"));
      setProjectSessionsCwd(cwd);
      setProjectSessionTotal(data.total ?? projectSessionTotal);
      setHasMoreSessions(Boolean(data.hasMore));
      setNextBefore(data.nextBefore ?? null);
      setNextBeforePath(data.nextBeforePath ?? null);
      applyArchivedMeta(data);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      const message = String(e);
      setError(message);
      onErrorRef.current?.(message);
    } finally {
      setLoadingMore(false);
    }
  }, [
    applyArchivedMeta,
    hasMoreSessions,
    loadingMore,
    nextBefore,
    nextBeforePath,
    projectSessionTotal,
  ]);

  const loadArchivedSessions = useCallback(async (cwd: string, reset = true) => {
    archivedAbortRef.current?.abort();
    const controller = new AbortController();
    archivedAbortRef.current = controller;
    try {
      const params = new URLSearchParams({
        cwd,
        limit: String(ARCHIVED_SESSIONS_LIMIT),
      });
      const res = await fetch(`/api/sessions/archived?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error(await readFetchError(res, `HTTP ${res.status}`));
      const data = (await res.json()) as SessionPageResponse & { total?: number };
      if (controller.signal.aborted) return;
      if (selectedCwdRef.current !== cwd) return;
      setArchivedSessions(data.sessions ?? []);
      setArchivedTotal(data.total ?? data.sessions?.length ?? 0);
      setArchivedHasMore(Boolean(data.hasMore));
      setArchivedNextBefore(data.nextBefore ?? null);
      setArchivedNextBeforePath(data.nextBeforePath ?? null);
      setError(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      const message = String(e);
      // Keep previous rows on refresh failure; only clear when intentionally resetting empty.
      if (reset) {
        // Do not wipe existing archived rows on failure — caller still sees last good page.
      }
      setError(message);
      onErrorRef.current?.(message);
    }
  }, []);

  const loadMoreArchivedSessions = useCallback(async () => {
    const cwd = selectedCwdRef.current;
    if (!cwd || !archivedHasMore || loadingMoreArchived || !archivedNextBefore) return;

    archivedAbortRef.current?.abort();
    const controller = new AbortController();
    archivedAbortRef.current = controller;
    try {
      setLoadingMoreArchived(true);
      const params = new URLSearchParams({
        cwd,
        limit: String(ARCHIVED_SESSIONS_LIMIT),
        before: archivedNextBefore,
      });
      if (archivedNextBeforePath) params.set("beforePath", archivedNextBeforePath);
      const res = await fetch(`/api/sessions/archived?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error(await readFetchError(res, `HTTP ${res.status}`));
      const data = (await res.json()) as SessionPageResponse;
      if (controller.signal.aborted) return;
      if (selectedCwdRef.current !== cwd) return;
      setArchivedSessions((prev) => mergeSessionsById(prev, data.sessions ?? [], "append"));
      setArchivedTotal(data.total ?? archivedTotal);
      setArchivedHasMore(Boolean(data.hasMore));
      setArchivedNextBefore(data.nextBefore ?? null);
      setArchivedNextBeforePath(data.nextBeforePath ?? null);
      setError(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      const message = String(e);
      setError(message);
      onErrorRef.current?.(message);
    } finally {
      setLoadingMoreArchived(false);
    }
  }, [archivedHasMore, archivedNextBefore, archivedNextBeforePath, archivedTotal, loadingMoreArchived]);

  const patchSessionIntoList = useCallback((info: SessionInfo) => {
    const cwd = selectedCwdRef.current;
    if (!cwd || info.cwd !== cwd || info.archived) return;
    setProjectSessions((prev) => {
      if (selectedCwdRef.current !== cwd) return prev;
      if (prev.some((s) => s.id === info.id)) return prev;
      return mergeSessionsById([info, ...prev], [], "append");
    });
    setProjectSessionsCwd(cwd);
  }, []);

  // Initial + refreshKey reload.
  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    void loadSessions(isFirst);
  }, [loadSessions, refreshKey]);

  // Independent workspace search mode (does not mutate paged projectSessions).
  useEffect(() => {
    const cwd = selectedCwd;
    const trimmed = searchQuery.trim();

    searchAbortRef.current?.abort();

    if (!cwd || trimmed.length < SESSION_SEARCH_MIN_QUERY_CHARS) {
      searchSeqRef.current += 1;
      setSearchActive(false);
      setSearchResults([]);
      setSearchTotal(0);
      setSearchHasMore(false);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }

    setSearchActive(true);
    setSearchLoading(true);
    setSearchError(null);

    const requestCwd = cwd;
    const requestSeq = ++searchSeqRef.current;
    const controller = new AbortController();
    searchAbortRef.current = controller;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const params = new URLSearchParams({
            cwd: requestCwd,
            q: trimmed,
            includeArchived: "1",
            limit: String(SESSION_SEARCH_DEFAULT_LIMIT),
          });
          const res = await fetch(`/api/sessions/search?${params}`, {
            signal: controller.signal,
          });
          if (!res.ok) {
            throw new Error(await readFetchError(res, `HTTP ${res.status}`));
          }
          const data = (await res.json()) as SessionSearchResponse;
          if (
            !shouldApplySessionSearchResponse({
              aborted: controller.signal.aborted,
              requestCwd,
              activeCwd: selectedCwdRef.current,
              requestSeq,
              latestSeq: searchSeqRef.current,
            })
          ) {
            return;
          }
          setSearchResults(data.sessions ?? []);
          setSearchTotal(data.total ?? data.sessions?.length ?? 0);
          setSearchHasMore(Boolean(data.hasMore));
          setSearchError(null);
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") return;
          if (
            !shouldApplySessionSearchResponse({
              aborted: controller.signal.aborted,
              requestCwd,
              activeCwd: selectedCwdRef.current,
              requestSeq,
              latestSeq: searchSeqRef.current,
            })
          ) {
            return;
          }
          const message = String(e);
          setSearchError(message);
          setSearchResults([]);
          setSearchTotal(0);
          setSearchHasMore(false);
        } finally {
          if (
            shouldApplySessionSearchResponse({
              aborted: false,
              requestCwd,
              activeCwd: selectedCwdRef.current,
              requestSeq,
              latestSeq: searchSeqRef.current,
            })
          ) {
            setSearchLoading(false);
          }
        }
      })();
    }, SESSION_SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [selectedCwd, searchQuery, refreshKey]);

  // On project change: isolate previous project's sessions and load first page only.
  useEffect(() => {
    setProjectSessions([]);
    setProjectSessionsCwd(null);
    setProjectSessionTotal(0);
    setHasMoreSessions(false);
    setNextBefore(null);
    setNextBeforePath(null);
    setArchivedSessions([]);
    setArchivedTotal(0);
    setArchivedHasMore(false);
    setArchivedNextBefore(null);
    setArchivedNextBeforePath(null);
    // Search state is owned by the searchQuery effect; clear only the loading latch here.
    searchAbortRef.current?.abort();

    if (!selectedCwd) return;

    const controller = abortBrowseRequests();
    void loadProjectSessions(selectedCwd, controller.signal).catch((e) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (selectedCwdRef.current === selectedCwd) {
        const message = String(e);
        setError(message);
        onErrorRef.current?.(message);
      }
    });
    return () => controller.abort();
  }, [selectedCwd, abortBrowseRequests, loadProjectSessions]);

  // Keep a directly-opened session visible even when it falls outside the recent window.
  useEffect(() => {
    if (!selectedSessionId || !selectedCwd) return;
    if (projectSessionsCwd === selectedCwd && projectSessions.some((s) => s.id === selectedSessionId)) {
      return;
    }
    if (archivedSessions.some((s) => s.id === selectedSessionId)) return;

    const controller = new AbortController();
    const requestCwd = selectedCwd;
    void (async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(selectedSessionId)}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { info?: SessionInfo | null };
        const info = data.info;
        if (!info || info.cwd !== requestCwd || info.archived) return;
        if (selectedCwdRef.current !== requestCwd) return;
        patchSessionIntoList(info);
      } catch {
        // ignore abort / not-found
      }
    })();
    return () => controller.abort();
  }, [
    selectedSessionId,
    selectedCwd,
    projectSessions,
    projectSessionsCwd,
    archivedSessions,
    patchSessionIntoList,
  ]);

  useEffect(() => {
    return () => {
      if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
      browseAbortRef.current?.abort();
      moreAbortRef.current?.abort();
      archivedAbortRef.current?.abort();
      searchAbortRef.current?.abort();
    };
  }, []);

  return {
    projectSummaries,
    projectSessions,
    projectSessionsCwd,
    projectSessionTotal,
    hasMoreSessions,
    loading,
    loadingMore,
    error,
    archivedCwds,
    archivedCounts,
    archivedSessions,
    archivedTotal,
    archivedHasMore,
    loadingMoreArchived,
    sessionRefreshDone,
    searchActive,
    searchResults,
    searchTotal,
    searchHasMore,
    searchLoading,
    searchError,
    loadSessions,
    loadMoreSessions,
    loadArchivedSessions,
    loadMoreArchivedSessions,
    patchSessionIntoList,
    setArchivedSessions,
    setError,
  };
}
