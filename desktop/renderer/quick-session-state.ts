/**
 * Pure renderer state for the in-tray quick-session composer.
 * Holds only safe project/model labels, the in-memory draft, and request identity.
 */

import {
  DESKTOP_QUICK_SESSION_MAX_MESSAGE_CHARS,
  DESKTOP_QUICK_SESSION_PROJECT_REF_PATTERN,
  DESKTOP_QUICK_SESSION_REQUEST_ID_PATTERN,
  isDesktopQuickSessionModelId,
  isDesktopQuickSessionProvider,
} from "../../lib/desktop-quick-session-limits";

export const QUICK_SESSION_MAX_MESSAGE_CHARS = DESKTOP_QUICK_SESSION_MAX_MESSAGE_CHARS;

export type QuickSessionPhase =
  | "closed"
  | "loading"
  | "editing"
  | "submitting"
  | "success"
  | "error";

export type QuickSessionPicker = "none" | "project" | "model";

export type QuickSessionModelsPhase = "idle" | "loading" | "ready" | "error";

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
  | "result_unknown"
  | "stale_target";

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

export type QuickSessionModel = {
  provider: string;
  modelId: string;
  name: string;
  primaryCandidate: boolean;
};

export type QuickSessionModelCatalog = {
  projectRef: string;
  defaultModel: { provider: string; modelId: string } | null;
  models: QuickSessionModel[];
  truncated: boolean;
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
  openPicker: QuickSessionPicker;
  modelQuery: string;
  models: QuickSessionModel[];
  modelsTruncated: boolean;
  modelsProjectRef: string | null;
  modelsPhase: QuickSessionModelsPhase;
  selectedProvider: string | null;
  selectedModelId: string | null;
};

export type QuickSessionEvent =
  | { type: "open" }
  | { type: "catalog_loaded"; catalog: QuickSessionCatalog }
  | { type: "catalog_failed"; code: QuickSessionErrorCode }
  | { type: "set_query"; query: string }
  | { type: "select_project"; projectRef: string }
  | { type: "toggle_picker"; picker: Exclude<QuickSessionPicker, "none"> }
  | { type: "close_picker" }
  | { type: "set_model_query"; query: string }
  | { type: "models_loading"; projectRef: string }
  | { type: "models_loaded"; catalog: QuickSessionModelCatalog }
  | { type: "models_failed"; projectRef: string; code: QuickSessionErrorCode }
  | { type: "select_model"; provider: string; modelId: string }
  | { type: "set_draft"; draft: string }
  | { type: "submit" }
  | { type: "submit_success"; sessionId: string; deepLink: string }
  | { type: "submit_error"; code: QuickSessionErrorCode }
  | { type: "retry" }
  | { type: "close" }
  | { type: "cancel" }
  | { type: "start_another" }
  | { type: "server_switched" };

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
    openPicker: "none",
    modelQuery: "",
    models: [],
    modelsTruncated: false,
    modelsProjectRef: null,
    modelsPhase: "idle",
    selectedProvider: null,
    selectedModelId: null,
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
  if (state.modelsPhase === "ready" && state.models.length === 0) return false;
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

export function filterQuickSessionModels(
  models: readonly QuickSessionModel[],
  query: string,
): QuickSessionModel[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...models];
  return models.filter((model) => {
    const hay = `${model.name} ${model.provider} ${model.modelId}`.toLowerCase();
    return hay.includes(needle);
  });
}

export function selectedQuickSessionProject(
  state: QuickSessionState,
): QuickSessionProject | null {
  if (!state.selectedProjectRef) return null;
  return state.projects.find((item) => item.projectRef === state.selectedProjectRef) ?? null;
}

export function selectedQuickSessionModel(
  state: QuickSessionState,
): QuickSessionModel | null {
  if (!state.selectedProvider || !state.selectedModelId) return null;
  return state.models.find(
    (item) => item.provider === state.selectedProvider && item.modelId === state.selectedModelId,
  ) ?? null;
}

export function formatQuickSessionProjectLabel(project: QuickSessionProject | null): string {
  if (!project) return "选择项目";
  return project.disambiguator
    ? `${project.displayName} · ${project.disambiguator}`
    : project.displayName;
}

export function formatQuickSessionModelLabel(model: QuickSessionModel | null): string {
  if (!model) return "默认模型";
  return model.name === model.modelId ? `${model.name} · ${model.provider}` : model.name;
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
      return "没有可用模型，请先在 WebUI 配置模型。";
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

function defaultSelectedModel(
  catalog: QuickSessionModelCatalog,
): { provider: string; modelId: string } | null {
  if (catalog.defaultModel) {
    const match = catalog.models.find(
      (item) =>
        item.provider === catalog.defaultModel?.provider
        && item.modelId === catalog.defaultModel.modelId,
    );
    if (match) return { provider: match.provider, modelId: match.modelId };
  }
  const first = catalog.models[0];
  return first ? { provider: first.provider, modelId: first.modelId } : null;
}

function resetModels(state: QuickSessionState): QuickSessionState {
  return {
    ...state,
    modelQuery: "",
    models: [],
    modelsTruncated: false,
    modelsProjectRef: null,
    modelsPhase: "idle",
    selectedProvider: null,
    selectedModelId: null,
    openPicker: state.openPicker === "model" ? "none" : state.openPicker,
  };
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
    openPicker: "none",
    modelQuery: "",
    models: [],
    modelsTruncated: false,
    modelsProjectRef: null,
    modelsPhase: "idle",
    selectedProvider: null,
    selectedModelId: null,
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
        openPicker: "none",
      };
    case "catalog_loaded": {
      const selected =
        event.catalog.projects.some((item) => item.projectRef === state.selectedProjectRef)
          ? state.selectedProjectRef
          : defaultSelectedRef(event.catalog.projects);
      const projectChanged = selected !== state.selectedProjectRef;
      const next: QuickSessionState = {
        ...state,
        phase: "editing",
        projects: event.catalog.projects,
        truncated: event.catalog.truncated,
        omitted: event.catalog.omitted,
        selectedProjectRef: selected,
        errorCode: event.catalog.projects.length === 0 ? "project_unknown" : null,
        openPicker: "none",
      };
      return projectChanged ? resetModels(next) : next;
    }
    case "catalog_failed":
      return {
        ...state,
        phase: "error",
        errorCode: event.code,
        openPicker: "none",
      };
    case "set_query":
      if (state.phase === "submitting") return state;
      return { ...state, query: event.query };
    case "select_project": {
      if (state.phase === "submitting") return state;
      if (!state.projects.some((item) => item.projectRef === event.projectRef)) return state;
      const changed = state.selectedProjectRef !== event.projectRef;
      const next: QuickSessionState = {
        ...state,
        selectedProjectRef: event.projectRef,
        requestId: changed ? null : state.requestId,
        errorCode: state.phase === "error" && changed ? null : state.errorCode,
        phase: state.phase === "success" ? "editing" : state.phase,
        success: changed ? null : state.success,
        openPicker: "none",
        query: "",
      };
      return changed ? resetModels(next) : next;
    }
    case "toggle_picker":
      if (state.phase === "submitting" || state.phase === "success") return state;
      return {
        ...state,
        openPicker: state.openPicker === event.picker ? "none" : event.picker,
      };
    case "close_picker":
      if (state.openPicker === "none") return state;
      return { ...state, openPicker: "none" };
    case "set_model_query":
      if (state.phase === "submitting") return state;
      return { ...state, modelQuery: event.query };
    case "models_loading":
      if (state.selectedProjectRef !== event.projectRef) return state;
      return {
        ...state,
        modelsPhase: "loading",
        modelsProjectRef: event.projectRef,
      };
    case "models_loaded": {
      if (state.selectedProjectRef !== event.catalog.projectRef) return state;
      const keepCurrent =
        state.selectedProvider
        && state.selectedModelId
        && event.catalog.models.some(
          (item) => item.provider === state.selectedProvider && item.modelId === state.selectedModelId,
        );
      const selected = keepCurrent
        ? { provider: state.selectedProvider!, modelId: state.selectedModelId! }
        : defaultSelectedModel(event.catalog);
      return {
        ...state,
        modelsPhase: "ready",
        modelsProjectRef: event.catalog.projectRef,
        models: event.catalog.models,
        modelsTruncated: event.catalog.truncated,
        selectedProvider: selected?.provider ?? null,
        selectedModelId: selected?.modelId ?? null,
        errorCode:
          event.catalog.models.length === 0
            ? "model_unavailable"
            : state.errorCode === "model_unavailable"
              ? null
              : state.errorCode,
      };
    }
    case "models_failed":
      if (state.selectedProjectRef !== event.projectRef) return state;
      return {
        ...state,
        modelsPhase: "error",
        modelsProjectRef: event.projectRef,
        models: [],
        modelsTruncated: false,
        selectedProvider: null,
        selectedModelId: null,
        errorCode: event.code === "model_unavailable" ? "model_unavailable" : state.errorCode,
      };
    case "select_model": {
      if (state.phase === "submitting") return state;
      if (
        !state.models.some((item) => item.provider === event.provider && item.modelId === event.modelId)
      ) {
        return state;
      }
      const changed =
        state.selectedProvider !== event.provider || state.selectedModelId !== event.modelId;
      return {
        ...state,
        selectedProvider: event.provider,
        selectedModelId: event.modelId,
        requestId: changed ? null : state.requestId,
        errorCode: state.phase === "error" && changed ? null : state.errorCode,
        phase: state.phase === "success" ? "editing" : state.phase,
        success: changed ? null : state.success,
        openPicker: "none",
        modelQuery: "",
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
        openPicker: "none",
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
        openPicker: "none",
      };
    case "submit_error":
      return {
        ...state,
        phase: "error",
        errorCode: event.code,
        openPicker: "none",
      };
    case "retry":
      if (state.phase !== "error") return state;
      if (state.errorCode === "result_unknown") {
        return {
          ...state,
          phase: "submitting",
          requestId: state.requestId ?? newQuickSessionRequestId(),
          openPicker: "none",
        };
      }
      if (!canSubmitQuickSession({ ...state, phase: "error" })) return state;
      return {
        ...state,
        phase: "submitting",
        requestId: newQuickSessionRequestId(),
        errorCode: null,
        openPicker: "none",
      };
    case "close":
      if (state.phase === "closed") return state;
      return {
        ...state,
        phase: "closed",
        success: null,
        openPicker: "none",
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
        openPicker: "none",
      };
    case "server_switched": {
      const keepOpen = state.phase !== "closed";
      return {
        ...createInitialQuickSessionState(),
        draft: state.draft,
        phase: keepOpen ? "loading" : "closed",
      };
    }
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

export function isQuickSessionModelRef(provider: string, modelId: string): boolean {
  return isDesktopQuickSessionProvider(provider) && isDesktopQuickSessionModelId(modelId);
}
