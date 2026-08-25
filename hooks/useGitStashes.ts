"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GitStashDetailResponse, GitStashListResponse } from "@/lib/types";
import {
  GitStashClientError,
  createGitStash,
  fetchGitStashDetail,
  fetchGitStashes,
  runGitStashAction,
} from "@/lib/git-stash-client";

function clientError(error: unknown): GitStashClientError {
  return error instanceof GitStashClientError
    ? error
    : new GitStashClientError(error instanceof Error ? error.message : String(error), "NETWORK_ERROR", 0);
}

export function useGitStashes(
  cwd: string | null,
  enabled: boolean,
  onStatusChanged?: (dirty: boolean) => void,
) {
  const [projection, setProjection] = useState<GitStashListResponse | null>(null);
  const [selectedOid, setSelectedOid] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitStashDetailResponse | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<GitStashClientError | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const cwdRef = useRef(cwd);
  const detailCache = useRef(new Map<string, GitStashDetailResponse>());
  const revisionRef = useRef<string | null>(null);

  cwdRef.current = cwd;

  const applyProjection = useCallback((next: GitStashListResponse, preferredOid?: string | null) => {
    if (revisionRef.current !== next.revision) {
      detailCache.current.clear();
      revisionRef.current = next.revision;
    }
    setProjection(next);
    setSelectedOid((current) => {
      if (preferredOid && next.entries.some((entry) => entry.oid === preferredOid)) return preferredOid;
      if (current && next.entries.some((entry) => entry.oid === current)) return current;
      return next.entries[0]?.oid ?? null;
    });
    onStatusChanged?.(next.target.isDirty);
  }, [onStatusChanged]);

  const refresh = useCallback(async (preferredOid?: string | null) => {
    if (!cwd) return null;
    const requestCwd = cwd;
    const sequence = ++listSequence.current;
    setListLoading(true);
    setListError(null);
    try {
      const next = await fetchGitStashes(requestCwd);
      if (sequence !== listSequence.current || cwdRef.current !== requestCwd) return null;
      applyProjection(next, preferredOid);
      return next;
    } catch (error) {
      if (sequence !== listSequence.current || cwdRef.current !== requestCwd) return null;
      setListError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      if (sequence === listSequence.current && cwdRef.current === requestCwd) setListLoading(false);
    }
  }, [applyProjection, cwd]);

  useEffect(() => {
    listSequence.current += 1;
    detailSequence.current += 1;
    detailCache.current.clear();
    revisionRef.current = null;
    setProjection(null);
    setSelectedOid(null);
    setDetail(null);
    setListError(null);
    setDetailError(null);
    setOperationError(null);
    setOperationBusy(false);
  }, [cwd]);

  useEffect(() => {
    if (!enabled || !cwd || projection) return;
    const controller = new AbortController();
    const requestCwd = cwd;
    const sequence = ++listSequence.current;
    setListLoading(true);
    setListError(null);
    void fetchGitStashes(cwd, controller.signal)
      .then((next) => {
        if (sequence === listSequence.current && cwdRef.current === requestCwd) applyProjection(next);
      })
      .catch((error) => {
        if (!controller.signal.aborted && sequence === listSequence.current && cwdRef.current === requestCwd) {
          setListError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (sequence === listSequence.current && cwdRef.current === requestCwd) setListLoading(false);
      });
    return () => controller.abort();
  }, [applyProjection, cwd, enabled, projection]);

  useEffect(() => {
    if (!enabled || !cwd || !selectedOid) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    const cached = detailCache.current.get(selectedOid);
    if (cached) {
      setDetail(cached);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    const requestCwd = cwd;
    const sequence = ++detailSequence.current;
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    void fetchGitStashDetail(cwd, selectedOid, controller.signal)
      .then((next) => {
        if (sequence !== detailSequence.current || cwdRef.current !== requestCwd) return;
        detailCache.current.set(selectedOid, next);
        setDetail(next);
      })
      .catch((error) => {
        if (!controller.signal.aborted && sequence === detailSequence.current && cwdRef.current === requestCwd) {
          setDetailError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (sequence === detailSequence.current && cwdRef.current === requestCwd) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [cwd, enabled, selectedOid, projection?.revision]);

  const create = useCallback(async (name: string, includeUntracked: boolean) => {
    if (!cwd || operationBusy) return false;
    const requestCwd = cwd;
    setOperationBusy(true);
    setOperationError(null);
    try {
      const response = await createGitStash({ cwd, name, includeUntracked });
      if (cwdRef.current !== requestCwd) return false;
      applyProjection(response.stashes, response.selectedOid);
      setDetail(null);
      return true;
    } catch (error) {
      if (cwdRef.current !== requestCwd) return false;
      const failure = clientError(error);
      setOperationError(failure);
      if (failure.outcome === "unknown") await refresh();
      return false;
    } finally {
      if (cwdRef.current === requestCwd) setOperationBusy(false);
    }
  }, [applyProjection, cwd, operationBusy, refresh]);

  const operate = useCallback(async (
    action: "apply" | "pop" | "drop",
    oid: string,
    reinstateIndex = false,
    expectedRevision = projection?.revision ?? "",
    expectedTargetRevision = projection?.target.revision ?? "",
  ) => {
    if (!cwd || !projection || operationBusy) return false;
    const requestCwd = cwd;
    setOperationBusy(true);
    setOperationError(null);
    try {
      const response = action === "drop"
        ? await runGitStashAction({ cwd, oid, action, expectedRevision })
        : await runGitStashAction({
          cwd,
          oid,
          action,
          reinstateIndex,
          expectedRevision,
          expectedTargetRevision,
        });
      if (cwdRef.current !== requestCwd) return false;
      applyProjection(response.stashes, response.selectedOid ?? (action === "apply" ? oid : null));
      if (action !== "apply") setDetail(null);
      return true;
    } catch (error) {
      if (cwdRef.current !== requestCwd) return false;
      const failure = clientError(error);
      setOperationError(failure);
      if (["STALE_REVISION", "STALE_TARGET", "STASH_NOT_FOUND", "STASH_CONFLICT", "STASH_OUTCOME_UNKNOWN"].includes(failure.code)) {
        await refresh(action === "apply" || failure.stashRetained ? oid : null);
      }
      return false;
    } finally {
      if (cwdRef.current === requestCwd) setOperationBusy(false);
    }
  }, [applyProjection, cwd, operationBusy, projection, refresh]);

  return {
    projection,
    selectedOid,
    detail,
    listLoading,
    detailLoading,
    listError,
    detailError,
    operationError,
    operationBusy,
    selectOid: setSelectedOid,
    refresh,
    create,
    operate,
    clearOperationError: () => setOperationError(null),
  };
}
