/**
 * Pure renderer state for the in-tray quick-session composer.
 * Holds only safe project labels, the in-memory draft, and request identity.
 */

import {
  DESKTOP_QUICK_SESSION_MAX_MESSAGE_CHARS,
  DESKTOP_QUICK_SESSION_PROJECT_REF_PATTERN,
  DESKTOP_QUICK_SESSION_REQUEST_ID_PATTERN,
} from "../../lib/desktop-quick-session-limits";

export const QUICK_SESSION_MAX_MESSAGE_CHARS = DESKTOP_QUICK_SESSION_MAX_MESSAGE_CHARS;

export type QuickSessionPhase =
  | "closed"
  | "loading"
  | "editing"
  | "submitting"
  | "success"
  | "error";

export type QuickSessionErrorCode =
  | "disconnected"
  | "feature_unavailable"
  | "auth_required"
  | "auth_invalid"
  | "unauthorized"
  | "project_unknown"
  | "project_unavailable"
  | "project_collision"
  | "project_out_of_catalog"
  | "model_unavailable"
  | "message_empty"
  | "message_too_long"
  | "bad_request"
  | "request_conflict"
  | "start_failed"
  | "result_unknown";

export type QuickSessionProject = {
  projectRef: string;
  displayName: string;
  disambiguator?: string;
  latestModified: string;
  archived: boolean;
  worktree: boolean;
};

export type QuickSessionCatalog = {
  projects: QuickSessionProject[];
  truncated: boolean;
  omitted: number;
};

export type QuickSessionSuccess = {
  sessionId: string;
  deepLink: string;
};

export type QuickSessionState = {
  phase: QuickSessionPhase;
  projects: QuickSessionProject[];
  truncated: boolean;
  omitted: number;
  query: string;
  selectedProjectRef: string | null;
  draft: string;
  requestId: string | null;
  errorCode: QuickSessionErrorCode | null;
  success: QuickSessionSuccess | null;
};

export type QuickSessionEvent =
  | { type: "open" }
  | { type: "catalog_loaded"; catalog: QuickSessionCatalog }
  | { type: "catalog_failed"; code: QuickSessionErrorCode }
  | { type: "set_query"; query: string }
  | { type: "select_project"; projectRef: string }
  | { type: "set_draft"; draft: string }
  | { type: "submit" }
  | { type: "submit_success"; sessionId: string; deepLink: string }
  | { type: "submit_error"; code: QuickSessionErrorCode }
  | { type: "retry" }
  | { type: "close" }
  | { type: "cancel" }
  | { type: "start_another" };

export function createInitialQuickSessionState(): QuickSessionState {
  return {
    phase: "closed",
    projects: [],
    truncated: false,
    omitted: 0,
    query: "",
    selectedProjectRef: null,
    draft: "",
    requestId: null,
    errorCode: null,
    success: null,
  };
}

export function newQuickSessionRequestId(random = Math.random): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function countQuickSessionChars(text: string): number {
  return [...text].length;
}

export function canSubmitQuickSession(state: QuickSessionState): boolean {
  if (state.phase !== "editing" && state.phase !== "error") return false;
  if (!state.selectedProjectRef) return false;
  const trimmed = state.draft.trim();
  if (!trimmed) return false;
  return countQuickSessionChars(state.draft) <= QUICK_SESSION_MAX_MESSAGE_CHARS;
}

export function filterQuickSessionProjects(
  projects: readonly QuickSessionProject[],
  query: string,
): QuickSessionProject[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...projects];
  return projects.filter((project) => {
    const hay = `${project.displayName} ${project.disambiguator ?? ""}`.toLowerCase();
    return hay.includes(needle);
  });
}

export function selectedQuickSessionProject(
  state: QuickSessionState,
): QuickSessionProject | null {
  if (!state.selectedProjectRef) return null;
  return state.projects.find((item) => item.projectRef === state.selectedProjectRef) ?? null;
}

export function formatQuickSessionProjectLabel(project: QuickSessionProject | null): string {
  if (!project) return "未选择项目";
  return project.disambiguator
    ? `${project.displayName} · ${project.disambiguator}`
    : project.displayName;
}

export function quickSessionErrorText(code: QuickSessionErrorCode | null): string {
  switch (code) {
    case "disconnected":
      return "服务未连接，草稿已保留。";
    case "feature_unavailable":
      return "当前服务不支持快速会话，请升级蜗牛派服务。";
    case "auth_required":
    case "auth_invalid":
    case "unauthorized":
      return "访问密钥无效，请在设置中重新连接。";
    case "project_unavailable":
    case "project_unknown":
    case "project_out_of_catalog":
      return "项目已不可用，请重新选择。";
    case "project_collision":
      return "项目引用冲突，无法启动。";
    case "model_unavailable":
      return "没有可用的默认模型，请先在 WebUI 配置模型。";
    case "message_empty":
      return "请输入首条消息。";
    case "message_too_long":
      return "消息超出上限。";
    case "request_conflict":
      return "这次提交已失效，请修改后重试。";
    case "start_failed":
      return "会话未能启动，草稿已保留。";
    case "result_unknown":
      return "结果不确定，重试不会创建第二个会话。";
    case "bad_request":
      return "请求无效，请检查输入后重试。";
    default:
      return "启动失败，草稿已保留。";
  }
}

function defaultSelectedRef(projects: readonly QuickSessionProject[]): string | null {
  return projects[0]?.projectRef ?? null;
}

function clearComposer(state: QuickSessionState): QuickSessionState {
  return {
    ...state,
    phase: "closed",
    query: "",
    draft: "",
    requestId: null,
    errorCode: null,
    success: null,
  };
}

export function reduceQuickSessionState(
  state: QuickSessionState,
  event: QuickSessionEvent,
): QuickSessionState {
  switch (event.type) {
    case "open":
      if (state.phase === "submitting") return state;
      return {
        ...state,
        phase: "loading",
        errorCode: null,
        success: null,
        requestId: null,
      };
    case "catalog_loaded": {
      const selected =
        event.catalog.projects.some((item) => item.projectRef === state.selectedProjectRef)
          ? state.selectedProjectRef
          : defaultSelectedRef(event.catalog.projects);
      return {
        ...state,
        phase: "editing",
        projects: event.catalog.projects,
        truncated: event.catalog.truncated,
        omitted: event.catalog.omitted,
        selectedProjectRef: selected,
        errorCode: event.catalog.projects.length === 0 ? "project_unknown" : null,
      };
    }
    case "catalog_failed":
      return {
        ...state,
        phase: "error",
        errorCode: event.code,
      };
    case "set_query":
      if (state.phase === "submitting") return state;
      return { ...state, query: event.query };
    case "select_project": {
      if (state.phase === "submitting") return state;
      if (!state.projects.some((item) => item.projectRef === event.projectRef)) return state;
      const changed = state.selectedProjectRef !== event.projectRef;
      return {
        ...state,
        selectedProjectRef: event.projectRef,
        requestId: changed ? null : state.requestId,
        errorCode: state.phase === "error" && changed ? null : state.errorCode,
        phase: state.phase === "success" ? "editing" : state.phase,
        success: changed ? null : state.success,
      };
    }
    case "set_draft":
      if (state.phase === "submitting") return state;
      return {
        ...state,
        draft: event.draft,
        requestId: event.draft !== state.draft ? null : state.requestId,
        errorCode: state.phase === "error" && event.draft !== state.draft ? null : state.errorCode,
        phase: state.phase === "success" ? "editing" : state.phase,
        success: event.draft !== state.draft ? null : state.success,
      };
    case "submit": {
      if (!canSubmitQuickSession(state)) return state;
      return {
        ...state,
        phase: "submitting",
        requestId: state.requestId ?? newQuickSessionRequestId(),
        errorCode: null,
        success: null,
      };
    }
    case "submit_success":
      return {
        ...state,
        phase: "success",
        draft: "",
        requestId: null,
        errorCode: null,
        success: { sessionId: event.sessionId, deepLink: event.deepLink },
      };
    case "submit_error":
      return {
        ...state,
        phase: "error",
        errorCode: event.code,
      };
    case "retry":
      if (state.phase !== "error") return state;
      if (state.errorCode === "result_unknown") {
        return {
          ...state,
          phase: "submitting",
          requestId: state.requestId ?? newQuickSessionRequestId(),
        };
      }
      if (!canSubmitQuickSession({ ...state, phase: "error" })) return state;
      return {
        ...state,
        phase: "submitting",
        requestId: newQuickSessionRequestId(),
        errorCode: null,
      };
    case "close":
      if (state.phase === "closed") return state;
      return {
        ...state,
        phase: "closed",
        success: null,
      };
    case "cancel":
      return clearComposer(state);
    case "start_another":
      return {
        ...state,
        phase: "editing",
        draft: "",
        requestId: null,
        errorCode: null,
        success: null,
      };
    default:
      return state;
  }
}

export function isQuickSessionRequestId(value: string): boolean {
  return DESKTOP_QUICK_SESSION_REQUEST_ID_PATTERN.test(value);
}

export function isQuickSessionProjectRef(value: string): boolean {
  return DESKTOP_QUICK_SESSION_PROJECT_REF_PATTERN.test(value);
}
