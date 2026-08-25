import type {
  GitCommitChangedFile,
  GitCommitDetail,
  GitWorkbenchErrorResponse,
  GitWorkbenchLogPage,
  GitWorkbenchOperationRequest,
  GitWorkbenchOperationResponse,
  GitWorkbenchOverview,
} from "@/lib/types";

export class GitWorkbenchClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: string,
    readonly recoveryRequired = false,
    readonly outcome?: "unknown",
  ) {
    super(message);
    this.name = "GitWorkbenchClientError";
  }
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & Partial<GitWorkbenchErrorResponse>;
  if (!response.ok) {
    throw new GitWorkbenchClientError(
      body.error ?? `HTTP ${response.status}`,
      body.code ?? "NETWORK_ERROR",
      response.status,
      body.details,
      Boolean(body.recoveryRequired),
      body.outcome,
    );
  }
  return body;
}

export async function fetchGitWorkbenchOverview(cwd: string, signal?: AbortSignal): Promise<GitWorkbenchOverview> {
  const params = new URLSearchParams({ cwd });
  const response = await fetch(`/api/git/workbench?${params.toString()}`, { signal, cache: "no-store" });
  const body = await responseJson<{ overview: GitWorkbenchOverview }>(response);
  return body.overview;
}

export async function fetchGitWorkbenchLog(options: {
  cwd: string;
  revision: string;
  scope: string;
  query: string;
  authorId: string | null;
  offset: number;
  limit?: number;
  signal?: AbortSignal;
}): Promise<GitWorkbenchLogPage> {
  const params = new URLSearchParams({
    cwd: options.cwd,
    revision: options.revision,
    scope: options.scope,
    query: options.query,
    offset: String(options.offset),
    limit: String(options.limit ?? 100),
  });
  if (options.authorId) params.set("author", options.authorId);
  const response = await fetch(`/api/git/log?${params.toString()}`, { signal: options.signal, cache: "no-store" });
  const body = await responseJson<{ page: GitWorkbenchLogPage }>(response);
  return body.page;
}

export async function fetchGitWorkbenchCommit(
  cwd: string,
  hash: string,
  signal?: AbortSignal,
): Promise<GitCommitDetail> {
  const params = new URLSearchParams({ cwd, hash });
  const response = await fetch(`/api/git/commit?${params.toString()}`, { signal, cache: "no-store" });
  const body = await responseJson<{ detail: GitCommitDetail }>(response);
  return body.detail;
}

export async function runGitWorkbenchOperation(
  request: GitWorkbenchOperationRequest,
): Promise<GitWorkbenchOperationResponse> {
  const response = await fetch("/api/git/operations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return responseJson<GitWorkbenchOperationResponse>(response);
}

export interface GitFileTreeNode {
  id: string;
  name: string;
  path: string;
  kind: "folder" | "file";
  children?: GitFileTreeNode[];
  change?: GitCommitChangedFile;
}

interface MutableFolder {
  id: string;
  name: string;
  path: string;
  folders: Map<string, MutableFolder>;
  files: GitFileTreeNode[];
}

function mutableFolder(name: string, folderPath: string): MutableFolder {
  return { id: `folder:${folderPath}`, name, path: folderPath, folders: new Map(), files: [] };
}

function finalizeFolder(folder: MutableFolder, isRoot = false): GitFileTreeNode[] {
  const childFolders = [...folder.folders.values()].map((child) => {
    let current = child;
    let displayName = current.name;
    while (current.files.length === 0 && current.folders.size === 1) {
      const only = [...current.folders.values()][0];
      displayName += `/${only.name}`;
      current = only;
    }
    return {
      id: `folder:${current.path}`,
      name: displayName,
      path: current.path,
      kind: "folder" as const,
      children: finalizeFolder(current),
    };
  });
  childFolders.sort((left, right) => left.name.localeCompare(right.name));
  folder.files.sort((left, right) => left.name.localeCompare(right.name));
  const children = [...childFolders, ...folder.files];
  return isRoot ? children : children;
}

/** Client-safe Git `/` path projection. File names are retained as text only. */
export function buildGitChangedFileTree(files: readonly GitCommitChangedFile[]): GitFileTreeNode[] {
  const root = mutableFolder("", "");
  for (const change of files) {
    const segments = change.file.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      const nextPath = folder.path ? `${folder.path}/${segment}` : segment;
      let next = folder.folders.get(segment);
      if (!next) {
        next = mutableFolder(segment, nextPath);
        folder.folders.set(segment, next);
      }
      folder = next;
    }
    const name = segments[segments.length - 1];
    folder.files.push({
      id: `file:${change.oldFile ?? ""}:${change.file}`,
      name,
      path: change.file,
      kind: "file",
      change,
    });
  }
  return finalizeFolder(root, true);
}
