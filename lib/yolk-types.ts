export type YolkWorkflowStatusKind = "missing" | "ready" | "disabled" | "outdated" | "conflict" | "blocked";
export type YolkWorkflowRecommendedAction = "enable" | "disable" | "update" | "resolve-conflicts" | "select-workspace" | "none";

export interface YolkManagedFileRecord {
  templateVersion: string;
  sha256: string;
}

export interface YolkWorkflowManifest {
  schemaVersion: 1;
  workflowVersion: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  managedFiles: Record<string, YolkManagedFileRecord>;
}

export interface YolkWorkflowDefinition {
  schemaVersion: 1;
  name: string;
  statuses: string[];
  artifacts: YolkTaskDocumentName[];
  defaultStatus: string;
}

export interface YolkWorkflowConflict {
  path: string;
  reason: "unmanaged-existing" | "modified-managed" | "missing-managed" | "path-escape" | "invalid-type";
  detail: string;
}

export interface YolkManagedFileStatus {
  path: string;
  templateVersion: string;
  exists: boolean;
  managed: boolean;
  currentSha256?: string;
  expectedSha256: string;
  changed: boolean;
}

export interface YolkWorkflowStatus {
  cwd: string;
  status: YolkWorkflowStatusKind;
  enabled: boolean;
  pathLabel: string;
  workflowVersion: string;
  recommendedAction: YolkWorkflowRecommendedAction;
  manifest?: YolkWorkflowManifest;
  conflicts: YolkWorkflowConflict[];
  managedFiles: YolkManagedFileStatus[];
  message: string;
}

export interface YolkWorkflowActionResponse {
  success: boolean;
  status: YolkWorkflowStatus;
  output?: string;
  error?: string;
}

export type YolkTaskDocumentName = "prd.md" | "design.md" | "implement.md" | "check.md";

export interface YolkTaskRecord {
  schemaVersion: 1;
  id: string;
  title: string;
  status: string;
  priority?: string;
  assignee?: string;
  parent: string | null;
  children: string[];
  createdAt: string;
  updatedAt: string;
  notes?: string;
}

export interface YolkTaskDocument {
  fileName: YolkTaskDocumentName;
  content: string;
  truncated: boolean;
}

export interface YolkTaskSummary {
  key: string;
  id: string;
  title: string;
  status: string;
  priority?: string;
  assignee?: string;
  parent: string | null;
  children: string[];
  createdAt?: string;
  updatedAt?: string;
  notes?: string;
  pathLabel: string;
  hasArtifacts: Record<YolkTaskDocumentName, boolean>;
  readError?: string;
}

export interface YolkTaskDetail extends YolkTaskSummary {
  documents: Partial<Record<YolkTaskDocumentName, YolkTaskDocument>>;
}

export interface YolkTaskReadError {
  key: string;
  pathLabel: string;
  message: string;
}

export interface YolkTasksResponse {
  cwd: string;
  exists: boolean;
  enabled: boolean;
  pathLabel: string;
  tasks: YolkTaskSummary[];
  statusCounts: Record<string, number>;
  errors: YolkTaskReadError[];
}

export interface YolkCreateTaskRequest {
  cwd: string;
  title: string;
  priority?: string;
  assignee?: string;
  prd?: string;
}

export interface YolkCreateTaskResponse {
  task: YolkTaskDetail;
}
