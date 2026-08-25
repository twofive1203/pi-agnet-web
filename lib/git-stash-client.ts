import type {
  GitStashDetailResponse,
  GitStashFile,
  GitStashFileDiffResponse,
  GitStashListResponse,
  GitStashMutationResponse,
  GitWorkbenchErrorResponse,
} from "@/lib/types";

export class GitStashClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: string,
    readonly stashRetained?: boolean,
    readonly outcome?: "unknown",
  ) {
    super(message);
    this.name = "GitStashClientError";
  }
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & Partial<GitWorkbenchErrorResponse>;
  if (!response.ok) {
    throw new GitStashClientError(
      body.error ?? `HTTP ${response.status}`,
      body.code ?? "NETWORK_ERROR",
      response.status,
      body.details,
      body.stashRetained,
      body.outcome,
    );
  }
  return body;
}

export async function fetchGitStashes(cwd: string, signal?: AbortSignal): Promise<GitStashListResponse> {
  const params = new URLSearchParams({ cwd });
  return responseJson<GitStashListResponse>(await fetch(`/api/git/stashes?${params.toString()}`, {
    signal,
    cache: "no-store",
  }));
}

export async function fetchGitStashDetail(
  cwd: string,
  oid: string,
  signal?: AbortSignal,
): Promise<GitStashDetailResponse> {
  const params = new URLSearchParams({ cwd });
  return responseJson<GitStashDetailResponse>(await fetch(`/api/git/stashes/${encodeURIComponent(oid)}?${params.toString()}`, {
    signal,
    cache: "no-store",
  }));
}

export async function fetchGitStashDiff(
  cwd: string,
  oid: string,
  file: GitStashFile,
  signal?: AbortSignal,
): Promise<GitStashFileDiffResponse> {
  const params = new URLSearchParams({ cwd, source: file.source, path: file.file });
  if (file.oldFile) params.set("oldPath", file.oldFile);
  return responseJson<GitStashFileDiffResponse>(await fetch(
    `/api/git/stashes/${encodeURIComponent(oid)}/diff?${params.toString()}`,
    { signal, cache: "no-store" },
  ));
}

export async function createGitStash(request: {
  cwd: string;
  name: string;
  includeUntracked: boolean;
}): Promise<GitStashMutationResponse> {
  return responseJson<GitStashMutationResponse>(await fetch("/api/git/stashes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  }));
}

export async function runGitStashAction(request: {
  cwd: string;
  oid: string;
  action: "apply" | "pop";
  reinstateIndex: boolean;
  expectedRevision: string;
  expectedTargetRevision: string;
} | {
  cwd: string;
  oid: string;
  action: "drop";
  expectedRevision: string;
}): Promise<GitStashMutationResponse> {
  const { oid, ...body } = request;
  return responseJson<GitStashMutationResponse>(await fetch(
    `/api/git/stashes/${encodeURIComponent(oid)}/actions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ));
}
