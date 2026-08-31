"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GitCommitDetail,
  GitGraphCommit,
  GitWorkbenchOperationRequest,
  GitWorkbenchOverview,
} from "@/lib/types";
import {
  GitWorkbenchClientError,
  fetchGitWorkbenchCommit,
  fetchGitWorkbenchLog,
  fetchGitWorkbenchOverview,
  runGitWorkbenchOperation,
} from "@/lib/git-workbench-client";
const GIT_WORKBENCH_MAX_COMMITS = 500;
const OPERATION_REFRESH_CODES = new Set([
  "STALE_REVISION",
  "STALE_HEAD",
  "STALE_HEAD_REF",
  "STALE_REF",
  "STALE_UPSTREAM",
  "CONFLICT_ABORTED",
  "CHECKOUT_CONFLICT",
  "GIT_TIMEOUT",
]);

export type GitWorkbenchOperationDraft = GitWorkbenchOperationRequest extends infer Request
  ? Request extends { cwd: string; expectedRevision: string }
    ? Omit<Request, "cwd" | "expectedRevision" | "expectedHead" | "expectedHeadRef">
    : never
  : never;

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useGitWorkbench(cwd: string | null) {
  const [overview, setOverview] = useState<GitWorkbenchOverview | null>(null);
  const [commits, setCommits] = useState<GitGraphCommit[]>([]);
  const [selectedScope, setSelectedScopeState] = useState("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [authorId, setAuthorId] = useState<string | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<GitWorkbenchClientError | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const overviewSeq = useRef(0);
  const logSeq = useRef(0);
  const detailSeq = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setOverview(null);
    setCommits([]);
    setSelectedScopeState("all");
    setQuery("");
    setDebouncedQuery("");
    setAuthorId(null);
    setSelectedHash(null);
    setDetail(null);
    setError(null);
    setDetailError(null);
    setOperationError(null);
    setRecoveryRequired(false);
    setHasMore(false);
  }, [cwd]);

  const refresh = useCallback(() => {
    setError(null);
    setRefreshVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    if (!cwd) return;
    const controller = new AbortController();
    const sequence = ++overviewSeq.current;
    setOverviewLoading(true);
    setError(null);
    void fetchGitWorkbenchOverview(cwd, controller.signal)
      .then((next) => {
        if (sequence !== overviewSeq.current) return;
        setOverview(next);
        const allowed = new Set([
          ...next.localBranches.map((ref) => ref.ref),
          ...next.remoteBranches.map((ref) => ref.ref),
          ...next.tags.map((ref) => ref.ref),
        ]);
        setSelectedScopeState((current) => current === "all" || allowed.has(current) ? current : "all");
        setAuthorId((current) => current && next.authors.some((author) => author.id === current) ? current : null);
      })
      .catch((loadError) => {
        if (controller.signal.aborted || sequence !== overviewSeq.current) return;
        setOverview(null);
        setError(messageFromError(loadError));
      })
      .finally(() => {
        if (sequence === overviewSeq.current) setOverviewLoading(false);
      });
    return () => controller.abort();
  }, [cwd, refreshVersion]);

  useEffect(() => {
    if (!cwd || !overview) return;
    const controller = new AbortController();
    const sequence = ++logSeq.current;
    setLogLoading(true);
    setError(null);
    setCommits([]);
    setHasMore(false);
    void fetchGitWorkbenchLog({
      cwd,
      revision: overview.revision,
      scope: selectedScope,
      query: debouncedQuery,
      authorId,
      offset: 0,
      signal: controller.signal,
    })
      .then((page) => {
        if (sequence !== logSeq.current) return;
        setCommits(page.commits);
        setHasMore(page.hasMore);
        setSelectedHash((current) => current && page.commits.some((commit) => commit.hash === current)
          ? current
          : page.commits[0]?.hash ?? null);
      })
      .catch((loadError) => {
        if (controller.signal.aborted || sequence !== logSeq.current) return;
        if (loadError instanceof GitWorkbenchClientError && loadError.code === "STALE_REVISION") {
          refresh();
          return;
        }
        setError(messageFromError(loadError));
      })
      .finally(() => {
        if (sequence === logSeq.current) setLogLoading(false);
      });
    return () => controller.abort();
  }, [authorId, cwd, debouncedQuery, overview, refresh, selectedScope]);

  useEffect(() => {
    if (!cwd || !selectedHash) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    const controller = new AbortController();
    const sequence = ++detailSeq.current;
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    void fetchGitWorkbenchCommit(cwd, selectedHash, controller.signal)
      .then((next) => {
        if (sequence === detailSeq.current) setDetail(next);
      })
      .catch((loadError) => {
        if (!controller.signal.aborted && sequence === detailSeq.current) setDetailError(messageFromError(loadError));
      })
      .finally(() => {
        if (sequence === detailSeq.current) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [cwd, selectedHash, overview?.revision]);

  const selectScope = useCallback((scope: string) => {
    setSelectedScopeState(scope);
    setSelectedHash(null);
    setDetail(null);
  }, []);

  const selectCommit = useCallback((commit: GitGraphCommit) => {
    setSelectedHash(commit.hash);
  }, []);

  const loadMore = useCallback(async () => {
    if (!cwd || !overview || !overview.revisionComplete || loadingMore || !hasMore || commits.length >= GIT_WORKBENCH_MAX_COMMITS) return;
    const sequence = ++logSeq.current;
    setLoadingMore(true);
    try {
      const page = await fetchGitWorkbenchLog({
        cwd,
        revision: overview.revision,
        scope: selectedScope,
        query: debouncedQuery,
        authorId,
        offset: commits.length,
      });
      if (sequence !== logSeq.current) return;
      setCommits((current) => {
        const seen = new Set(current.map((commit) => commit.hash));
        return [...current, ...page.commits.filter((commit) => !seen.has(commit.hash))].slice(0, GIT_WORKBENCH_MAX_COMMITS);
      });
      setHasMore(page.hasMore);
    } catch (loadError) {
      if (sequence !== logSeq.current) return;
      if (loadError instanceof GitWorkbenchClientError && loadError.code === "STALE_REVISION") refresh();
      else setError(messageFromError(loadError));
    } finally {
      if (sequence === logSeq.current) setLoadingMore(false);
    }
  }, [authorId, commits.length, cwd, debouncedQuery, hasMore, loadingMore, overview, refresh, selectedScope]);

  const operate = useCallback(async (draft: GitWorkbenchOperationDraft) => {
    if (!cwd || !overview || !overview.revisionComplete || operationBusy || recoveryRequired) return null;
    setOperationBusy(true);
    setOperationError(null);
    try {
      const requiresHead = ["cherry-pick", "reset", "revert", "reword", "drop"].includes(draft.action)
        || (draft.action === "create-branch" && Boolean(draft.checkout));
      const requiresHeadRef = requiresHead || draft.action === "checkout-local" || draft.action === "checkout-remote";
      const request = {
        ...draft,
        cwd,
        expectedRevision: overview.revision,
        ...(requiresHeadRef ? { expectedHeadRef: overview.headRef } : {}),
        ...(requiresHead && overview.head ? { expectedHead: overview.head } : {}),
      } as GitWorkbenchOperationRequest;
      const response = await runGitWorkbenchOperation(request);
      setOverview(response.overview);
      setCommits([]);
      setDetail(null);
      setSelectedHash(response.selectedHash);
      setHasMore(false);
      return response;
    } catch (operationFailure) {
      const clientError = operationFailure instanceof GitWorkbenchClientError
        ? operationFailure
        : new GitWorkbenchClientError(messageFromError(operationFailure), "NETWORK_ERROR", 0);
      setOperationError(clientError);
      if (clientError.recoveryRequired) {
        setRecoveryRequired(true);
        refresh();
      }
      if (OPERATION_REFRESH_CODES.has(clientError.code)) refresh();
      return null;
    } finally {
      setOperationBusy(false);
    }
  }, [cwd, operationBusy, overview, recoveryRequired, refresh]);

  const visibleRefCount = useMemo(() => overview
    ? overview.localBranches.length + overview.remoteBranches.length + overview.tags.length
    : 0, [overview]);

  return {
    overview,
    commits,
    selectedScope,
    query,
    authorId,
    selectedHash,
    detail,
    overviewLoading,
    logLoading,
    detailLoading,
    loadingMore,
    hasMore,
    error,
    detailError,
    operationError,
    operationBusy,
    recoveryRequired,
    visibleRefCount,
    setQuery,
    setAuthorId,
    selectScope,
    selectCommit,
    setSelectedHash,
    refresh,
    loadMore,
    operate,
    clearOperationError: () => setOperationError(null),
  };
}
