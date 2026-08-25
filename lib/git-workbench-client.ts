import type {
  GitCommitChangedFile,
  GitCommitDetail,
  GitWorkbenchErrorResponse,
  GitWorkbenchLogPage,
  GitWorkbenchOperationRequest,
  GitWorkbenchOperationResponse,
  GitWorkbenchOverview,
  GitWorkbenchRef,
} from "@/lib/types";

export const GIT_WORKBENCH_LAYOUT_STORAGE_KEY = "pi-web-git-workbench-layout-v1";
export const GIT_WORKBENCH_RESIZE_HANDLE_SIZE = 6;
export const GIT_WORKBENCH_MIN_REFS_WIDTH = 190;
export const GIT_WORKBENCH_MIN_LOG_WIDTH = 420;
export const GIT_WORKBENCH_MIN_INSPECTOR_WIDTH = 300;
export const GIT_WORKBENCH_MIN_INSPECTOR_SECTION_HEIGHT = 180;
export const GIT_WORKBENCH_RESIZE_STEP = 16;
export const GIT_WORKBENCH_RESIZE_STEP_LARGE = 48;

export interface GitWorkbenchLayoutPreference {
  refsWidth: number;
  inspectorWidth: number;
  changesRatio: number;
}

export const DEFAULT_GIT_WORKBENCH_LAYOUT: GitWorkbenchLayoutPreference = {
  refsWidth: 240,
  inspectorWidth: 420,
  changesRatio: 0.5,
};

interface GitWorkbenchSizeBounds {
  min: number;
  max: number;
}

function clampWorkbenchSize(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finitePreferenceNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseGitWorkbenchLayoutPreference(raw: string | null): GitWorkbenchLayoutPreference {
  if (!raw) return { ...DEFAULT_GIT_WORKBENCH_LAYOUT };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_GIT_WORKBENCH_LAYOUT };
    }
    const stored = parsed as Record<string, unknown>;
    return {
      refsWidth: Math.max(0, Math.round(finitePreferenceNumber(stored.refsWidth, DEFAULT_GIT_WORKBENCH_LAYOUT.refsWidth))),
      inspectorWidth: Math.max(0, Math.round(finitePreferenceNumber(stored.inspectorWidth, DEFAULT_GIT_WORKBENCH_LAYOUT.inspectorWidth))),
      changesRatio: clampWorkbenchSize(
        finitePreferenceNumber(stored.changesRatio, DEFAULT_GIT_WORKBENCH_LAYOUT.changesRatio),
        0,
        1,
      ),
    };
  } catch {
    return { ...DEFAULT_GIT_WORKBENCH_LAYOUT };
  }
}

function usableWorkbenchWidth(containerWidth: number): number {
  return Math.max(0, Math.round(containerWidth) - GIT_WORKBENCH_RESIZE_HANDLE_SIZE * 2);
}

export function getGitWorkbenchRefsWidthBounds(
  containerWidth: number,
  inspectorWidth: number,
): GitWorkbenchSizeBounds {
  const max = usableWorkbenchWidth(containerWidth)
    - GIT_WORKBENCH_MIN_LOG_WIDTH
    - Math.max(GIT_WORKBENCH_MIN_INSPECTOR_WIDTH, inspectorWidth);
  return { min: GIT_WORKBENCH_MIN_REFS_WIDTH, max: Math.max(GIT_WORKBENCH_MIN_REFS_WIDTH, max) };
}

export function getGitWorkbenchInspectorWidthBounds(
  containerWidth: number,
  refsWidth: number,
): GitWorkbenchSizeBounds {
  const max = usableWorkbenchWidth(containerWidth)
    - GIT_WORKBENCH_MIN_LOG_WIDTH
    - Math.max(GIT_WORKBENCH_MIN_REFS_WIDTH, refsWidth);
  return { min: GIT_WORKBENCH_MIN_INSPECTOR_WIDTH, max: Math.max(GIT_WORKBENCH_MIN_INSPECTOR_WIDTH, max) };
}

export function clampGitWorkbenchColumns(
  containerWidth: number,
  preference: GitWorkbenchLayoutPreference,
): GitWorkbenchLayoutPreference {
  const refsBounds = getGitWorkbenchRefsWidthBounds(containerWidth, preference.inspectorWidth);
  const refsWidth = Math.round(clampWorkbenchSize(preference.refsWidth, refsBounds.min, refsBounds.max));
  const inspectorBounds = getGitWorkbenchInspectorWidthBounds(containerWidth, refsWidth);
  const inspectorWidth = Math.round(clampWorkbenchSize(
    preference.inspectorWidth,
    inspectorBounds.min,
    inspectorBounds.max,
  ));
  return { ...preference, refsWidth, inspectorWidth };
}

export function getGitWorkbenchChangesRatioBounds(containerHeight: number): GitWorkbenchSizeBounds {
  const usableHeight = Math.max(1, Math.round(containerHeight) - GIT_WORKBENCH_RESIZE_HANDLE_SIZE);
  const min = Math.min(0.5, GIT_WORKBENCH_MIN_INSPECTOR_SECTION_HEIGHT / usableHeight);
  return { min, max: 1 - min };
}

export function clampGitWorkbenchChangesRatio(ratio: number, containerHeight: number): number {
  const bounds = getGitWorkbenchChangesRatioBounds(containerHeight);
  return clampWorkbenchSize(ratio, bounds.min, bounds.max);
}

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

export interface GitRemoteRefGroup {
  remote: string;
  refs: GitWorkbenchRef[];
}

export function buildGitRemoteRefGroups(
  remotes: readonly string[],
  remoteBranches: readonly GitWorkbenchRef[],
): GitRemoteRefGroup[] {
  const groups = new Map<string, GitWorkbenchRef[]>(remotes.map((remote) => [remote, []]));
  for (const ref of remoteBranches) {
    const remote = ref.remote ?? ref.name.split("/", 1)[0];
    if (!remote) continue;
    const refs = groups.get(remote);
    if (refs) refs.push(ref);
    else groups.set(remote, [ref]);
  }
  return [...groups].map(([remote, refs]) => ({ remote, refs }));
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

export function collectGitFileTreeFolderIds(nodes: readonly GitFileTreeNode[]): Set<string> {
  const folderIds = new Set<string>();
  const visit = (node: GitFileTreeNode) => {
    if (node.kind !== "folder") return;
    folderIds.add(node.id);
    node.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return folderIds;
}
