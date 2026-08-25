// Types mirrored from pi-mono coding-agent session-manager

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
}

/** A file attached to a chat message (stored server-side, referenced by path). */
export interface AttachedFile {
  name: string;
  size: number;
  path: string;
}

export interface FileReference {
  relativePath: string;
  startLine?: number;
  endLine?: number;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolCallContent {
  type: "toolCall";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export type AssistantContentBlock = TextContent | ImageContent | ThinkingContent | ToolCallContent;

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp?: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface SessionBillingStats {
  tokens: Pick<TokenUsage, "input" | "output" | "cacheRead" | "cacheWrite">;
  cost: number;
}

/** Per provider/model breakdown of durable session performance samples. */
export interface SessionPerformanceModelBreakdown {
  provider: string;
  model: string;
  sampleCount: number;
  totalOutputTokens: number;
  totalStreamDurationMs: number;
  totalTtftMs: number;
  /** Weighted TPS for this provider/model row; null when no positive duration. */
  avgTps: number | null;
  /** Arithmetic mean TTFT in milliseconds. */
  avgTtftMs: number | null;
}

/**
 * Bounded, client-safe session performance summary.
 * Derived from aggregate sidecar counters only — no per-call history.
 */
export interface SessionPerformanceSummary {
  sampleCount: number;
  totalOutputTokens: number;
  totalStreamDurationMs: number;
  totalTtftMs: number;
  /** Weighted session TPS: totalOutputTokens / (totalStreamDurationMs/1000). */
  avgTps: number | null;
  /** Arithmetic mean TTFT across valid samples, in milliseconds. */
  avgTtftMs: number | null;
  /** True when more than one provider/model pair contributed samples. */
  mixedModels: boolean;
  byModel: SessionPerformanceModelBreakdown[];
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
  model: string;
  provider: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  usage?: TokenUsage;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: (TextContent | ImageContent)[];
  isError?: boolean;
  timestamp?: number;
  usage?: TokenUsage;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  timestamp?: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage;

export type ExtensionUiRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
      timeout?: number;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText?: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setTitle";
      title: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "set_editor_text";
      text: string;
    };

export type ExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export interface ExtensionStatusItem {
  key: string;
  text: string;
}

export interface ExtensionWidgetItem {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export interface ExtensionToastItem {
  id: string;
  message: string;
  notifyType: "info" | "warning" | "error";
  createdAt: number;
}

/** Blocking extension dialog methods that require a browser response. */
export type ExtensionDialogRequest = Extract<
  ExtensionUiRequest,
  { method: "select" | "confirm" | "input" | "editor" }
>;

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  fromHook?: boolean;
  usage?: TokenUsage;
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: unknown;
  fromHook?: boolean;
  usage?: TokenUsage;
}

export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: unknown;
  display: boolean;
}

export interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
  compressedEntryIds?: string[];
}

export interface GitInfo {
  branch?: string;
  repoRoot?: string;
  mainWorktreePath?: string;
  mainWorktreeBranch?: string;
  isWorktree?: boolean;
}

export interface WorktreeInfo {
  isWorktree: true;
  branch?: string;
  repoRoot?: string;
  mainWorktreePath?: string;
  mainWorktreeBranch?: string;
}

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionId?: string; // set if this session was forked from another
  archived?: boolean;       // true for archived sessions
  worktree?: WorktreeInfo;
  git?: GitInfo;
}

/** Lightweight project row for sidebar discovery (no full session scan). */
export interface ProjectSummary {
  cwd: string;
  sessionCount: number;
  /** Best-effort recent activity time used for project ordering (file mtime of newest candidate). */
  latestModified: string;
  latestSession?: Pick<SessionInfo, "id" | "name" | "firstMessage" | "modified" | "created" | "messageCount">;
  worktree?: WorktreeInfo;
  git?: GitInfo;
}

export interface SessionContext {
  messages: AgentMessage[];
  entryIds: string[]; // parallel to messages — the session entry id for each message
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

/** Model/runtime metadata only. Never a substitute for the display transcript. */
export interface SessionContextState {
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

/** Dedicated display marker for a persisted compaction entry. Not a user message. */
export const TRANSCRIPT_COMPACTION_CUSTOM_TYPE = "pi-web:compaction";

/** Dedicated display marker for a persisted branch_summary entry. Not a user message. */
export const TRANSCRIPT_BRANCH_SUMMARY_CUSTOM_TYPE = "pi-web:branch-summary";

/** One bounded page of the current-branch display transcript. */
export interface SessionTranscriptPage {
  messages: AgentMessage[];
  entryIds: string[];
  leafId: string | null;
  hasMoreBefore: boolean;
  nextBeforeEntryId: string | null;
  messageCount: number;
  firstMessage: string;
}

export type SessionFileChangeStatus = "added" | "modified" | "deleted" | "metadata-only";
export type SessionFileChangeSourceKind = "edit" | "write";
export type SessionFileChangeReason = "binary" | "too-large" | "outside-workspace" | "unreadable" | "unchanged";

export interface SessionChangedFileSummary {
  path: string;
  status: SessionFileChangeStatus;
  additions: number;
  deletions: number;
  toolNames: SessionFileChangeSourceKind[];
  sourceKinds: SessionFileChangeSourceKind[];
  diffAvailable: boolean;
  reason?: SessionFileChangeReason;
  firstChangedAt: string;
  lastChangedAt: string;
}

export interface SessionChangesSummaryResponse {
  sessionId: string;
  updatedAt?: string;
  files: SessionChangedFileSummary[];
}

export interface SessionFileDiffResponse extends SessionChangedFileSummary {
  diff?: string;
}

// RPC types
export interface RpcSessionState {
  model?: { provider: string; id: string; contextWindow?: number };
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  messageCount: number;
}

// Git status panel types
export type GitCommitFileStatus = "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?";

export interface GitFileChange {
  status: "M" | "A" | "D" | "R" | "C" | "U" | "?";
  file: string;
  oldFile?: string;
}

export interface GitCommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string;
  relativeDate: string;
}

export interface GitCommitRef {
  name: string;
  type: "branch" | "tag" | "head" | "remote";
}

export interface GitGraphCommit {
  hash: string;
  message: string;
  author: string;
  authorEmail?: string;
  date: string;
  relativeDate: string;
  timestamp?: number;
  parents: string[];
  refs: GitCommitRef[];
  /** Workbench log projection: whether this exact commit is reachable from the current HEAD. */
  containedInCurrent?: boolean;
}

export interface GitCommitChangedFile {
  status: GitCommitFileStatus;
  file: string;
  oldFile?: string;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export interface GitCommitDetail {
  hash: string;
  shortHash: string;
  parents: string[];
  author: {
    name: string;
    email: string;
    date: string;
    relativeDate: string;
  };
  committer: {
    name: string;
    email: string;
    date: string;
  };
  subject: string;
  body: string;
  refs: GitCommitRef[];
  files: GitCommitChangedFile[];
  filesTruncated?: boolean;
  capabilities?: GitCommitCapabilities;
}

export type GitCommitDiffReason = "binary" | "too-large" | "unavailable";

export interface GitCommitFileDiffResponse {
  hash: string;
  file: string;
  oldFile?: string;
  diffAvailable: boolean;
  diff?: string;
  reason?: GitCommitDiffReason;
}

export type GitWorkingTreeDiffScope = "staged" | "unstaged";

export interface GitWorkingTreeFileDiffResponse {
  scope: GitWorkingTreeDiffScope;
  file: string;
  oldFile?: string;
  diffAvailable: boolean;
  diff?: string;
  reason?: GitCommitDiffReason;
}

export type GitStashFileSource = "tracked" | "untracked";

export interface GitStashEntry {
  oid: string;
  shortOid: string;
  displayRef: string;
  subject: string;
  name: string;
  sourceBranch: string | null;
  createdAt: string;
  timestamp: number;
}

export interface GitStashFile extends GitCommitChangedFile {
  source: GitStashFileSource;
}

export interface GitStashTargetState {
  cwd: string;
  repoRoot: string;
  branch: string | null;
  head: string | null;
  isDetached: boolean;
  isDirty: boolean;
  hasUnmerged: boolean;
  isWorktree: boolean;
  operationState: GitOperationState | null;
  revision: string;
}

export interface GitStashListResponse {
  entries: GitStashEntry[];
  revision: string;
  truncated: boolean;
  totalCount: number;
  target: GitStashTargetState;
}

export interface GitStashDetailResponse {
  entry: GitStashEntry;
  files: GitStashFile[];
  fileCount: number;
  filesTruncated: boolean;
}

export interface GitStashFileDiffResponse {
  oid: string;
  source: GitStashFileSource;
  file: string;
  oldFile?: string;
  diffAvailable: boolean;
  diff?: string;
  reason?: GitCommitDiffReason;
}

export type GitStashAction = "create" | "apply" | "pop" | "drop";

export type GitStashMutationRequest =
  | { action: "create"; cwd: string; name: string; includeUntracked: boolean }
  | { action: "apply" | "pop"; cwd: string; oid: string; reinstateIndex: boolean; expectedRevision: string; expectedTargetRevision: string }
  | { action: "drop"; cwd: string; oid: string; expectedRevision: string };

export interface GitStashMutationResponse {
  success: true;
  action: GitStashAction;
  stashes: GitStashListResponse;
  selectedOid: string | null;
  stashRetained?: boolean;
}

export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  upstream?: string | null;
  ahead: number;
  behind: number;
  latestCommit: string;
}

export interface GitGraphData {
  commits: GitGraphCommit[];
  branches: GitBranchInfo[];
}

export interface GitStatusInfo {
  branch: string | null;
  upstream: string | null;
  isDetached: boolean;
  isDirty: boolean;
  isWorktree: boolean;
  ahead: number;
  behind: number;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: string[];
  recentCommits: GitCommitInfo[];
  stashCount: number;
}

export type GitOperationState = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";

export type GitWorkbenchRefKind = "local" | "remote" | "tag";

export interface GitWorkbenchRef {
  kind: GitWorkbenchRefKind;
  /** Full, validated ref name used by APIs. */
  ref: string;
  /** Browser-facing short name. */
  name: string;
  target: string;
  current?: boolean;
  remote?: string;
  upstreamRef?: string | null;
  upstreamName?: string | null;
  ahead?: number;
  behind?: number;
  checkedOutPath?: string | null;
}

export interface GitWorkbenchAuthor {
  id: string;
  name: string;
  email: string;
  label: string;
}

export interface GitWorkbenchTruncation {
  refs: boolean;
  authors: boolean;
}

export interface GitWorkbenchOverview {
  cwd: string;
  repoRoot: string;
  commonDir: string;
  repositoryName: string;
  revision: string;
  head: string | null;
  currentBranch: string | null;
  isDetached: boolean;
  isEmpty: boolean;
  isDirty: boolean;
  hasUnmerged: boolean;
  isWorktree: boolean;
  operationState: GitOperationState | null;
  localBranches: GitWorkbenchRef[];
  remoteBranches: GitWorkbenchRef[];
  tags: GitWorkbenchRef[];
  remotes: string[];
  authors: GitWorkbenchAuthor[];
  truncation: GitWorkbenchTruncation;
}

export type GitCommitCapabilityReason =
  | "detached-head"
  | "empty-repository"
  | "dirty-working-tree"
  | "unmerged-index"
  | "operation-in-progress"
  | "merge-commit"
  | "root-commit"
  | "already-contained"
  | "published-commit"
  | "not-current-first-parent"
  | "non-linear-range"
  | "current-commit"
  | "branch-in-use";

export interface GitCommitCapability {
  allowed: boolean;
  reason?: GitCommitCapabilityReason;
}

export interface GitCommitCapabilities {
  cherryPick: GitCommitCapability;
  reset: GitCommitCapability;
  revert: GitCommitCapability;
  reword: GitCommitCapability;
  drop: GitCommitCapability;
  newBranch: GitCommitCapability;
  newTag: GitCommitCapability;
  facts: {
    published: boolean;
    currentFirstParent: boolean;
    linearToHead: boolean;
    merge: boolean;
    root: boolean;
    head: boolean;
    containedInCurrent: boolean;
  };
}

export interface GitWorkbenchLogPage {
  revision: string;
  scope: "all" | string;
  query: string;
  authorId: string | null;
  offset: number;
  limit: number;
  commits: GitGraphCommit[];
  hasMore: boolean;
}

export type GitResetMode = "soft" | "mixed" | "hard" | "keep";

export type GitWorkbenchOperationRequest =
  | { action: "checkout-local"; cwd: string; ref: string; expectedRevision: string }
  | { action: "checkout-remote"; cwd: string; ref: string; localName?: string; expectedRevision: string }
  | { action: "push"; cwd: string; ref: string; remote?: string; target?: string; setUpstream?: boolean; expectedRevision: string; expectedRefTip: string }
  | { action: "cherry-pick"; cwd: string; hash: string; expectedRevision: string; expectedHead: string }
  | { action: "reset"; cwd: string; hash: string; mode: GitResetMode; confirmTarget?: string; expectedRevision: string; expectedHead: string }
  | { action: "revert"; cwd: string; hash: string; expectedRevision: string; expectedHead: string }
  | { action: "reword"; cwd: string; hash: string; message: string; expectedRevision: string; expectedHead: string }
  | { action: "drop"; cwd: string; hash: string; expectedRevision: string; expectedHead: string }
  | { action: "create-branch"; cwd: string; hash: string; name: string; checkout?: boolean; expectedRevision: string; expectedHead?: string }
  | { action: "create-tag"; cwd: string; hash: string; name: string; expectedRevision: string };

export interface GitWorkbenchOperationResponse {
  success: true;
  action: GitWorkbenchOperationRequest["action"];
  overview: GitWorkbenchOverview;
  selectedHash: string | null;
  outcome?: "updated" | "created" | "up-to-date";
}

export interface GitWorkbenchErrorResponse {
  error: string;
  code: string;
  details?: string;
  recoveryRequired?: boolean;
  outcome?: "unknown";
  stashRetained?: boolean;
}
