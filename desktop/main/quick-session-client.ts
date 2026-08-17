/**
 * Main-only desktop-control client for quick sessions.
 *
 * Holds the scoped control token and access key in process memory. Renderer
 * never sees tokens, cwd, message echo, or raw server errors.
 */

import {
  DESKTOP_CONTROL_API_PREFIX,
  DESKTOP_CONTROL_TOKEN_HEADER,
} from "../../lib/desktop-control-constants";
import {
  DESKTOP_QUICK_SESSION_MAX_MESSAGE_CHARS,
  DESKTOP_QUICK_SESSION_PROJECT_REF_PATTERN,
  DESKTOP_QUICK_SESSION_REQUEST_ID_PATTERN,
} from "../../lib/desktop-quick-session-limits";
import {
  buildDesktopOrigin,
  DESKTOP_DEFAULT_PORT,
} from "./connection-state";
import {
  classifyFetchFailure,
  type DesktopFetch,
  type DesktopFetchResponse,
} from "./observer-client";

export type DesktopQuickSessionClientCode =
  | "feature_unavailable"
  | "disconnected"
  | "auth_required"
  | "auth_invalid"
  | "bad_request"
  | "message_empty"
  | "message_too_long"
  | "project_unknown"
  | "project_unavailable"
  | "project_collision"
  | "project_out_of_catalog"
  | "model_unavailable"
  | "request_conflict"
  | "start_failed"
  | "result_unknown"
  | "unauthorized";

export type DesktopQuickSessionProject = {
  projectRef: string;
  displayName: string;
  disambiguator?: string;
  latestModified: string;
  archived: boolean;
  worktree: boolean;
};

export type DesktopQuickSessionCatalog = {
  projects: DesktopQuickSessionProject[];
  truncated: boolean;
  omitted: number;
};

export type DesktopQuickSessionStartResult = {
  sessionId: string;
  deepLink: string;
  duplicate: boolean;
};

export type DesktopQuickSessionClientSuccess<T> = { ok: true; value: T };
export type DesktopQuickSessionClientFailure = {
  ok: false;
  code: DesktopQuickSessionClientCode;
};
export type DesktopQuickSessionClientResult<T> =
  | DesktopQuickSessionClientSuccess<T>
  | DesktopQuickSessionClientFailure;

export type DesktopQuickSessionClientOptions = {
  port?: number;
  fetch?: DesktopFetch;
  accessKey?: string | null;
  now?: () => number;
  origin?: string;
};

const FORBIDDEN_PAYLOAD_KEYS = [
  "token",
  "accessKey",
  "cwd",
  "path",
  "firstMessage",
  "prompt",
  "latestSession",
];

function fail(code: DesktopQuickSessionClientCode): DesktopQuickSessionClientFailure {
  return { ok: false, code };
}

function normalizeAccessKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  return key && key.length <= 512 ? key : null;
}

function classifyHttpCode(status: number, payload: unknown): DesktopQuickSessionClientCode {
  const code =
    payload && typeof payload === "object" && typeof (payload as { code?: unknown }).code === "string"
      ? String((payload as { code: string }).code)
      : "";
  if (status === 401 || status === 403) {
    if (code === "auth_invalid") return "auth_invalid";
    if (code === "auth_required") return "auth_required";
    return "unauthorized";
  }
  if (
    code === "message_empty"
    || code === "message_too_long"
    || code === "project_unknown"
    || code === "project_unavailable"
    || code === "project_collision"
    || code === "project_out_of_catalog"
    || code === "model_unavailable"
    || code === "request_conflict"
    || code === "start_failed"
    || code === "bad_request"
  ) {
    return code;
  }
  if (status === 0) return "result_unknown";
  return "result_unknown";
}

function assertSafePayload(value: unknown): void {
  const json = JSON.stringify(value);
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    if (new RegExp(`"${key}"\\s*:`).test(json)) {
      throw new Error(`quick-session payload leaked ${key}`);
    }
  }
}

function parseCatalog(payload: unknown): DesktopQuickSessionCatalog | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.projects)) return null;
  const projects: DesktopQuickSessionProject[] = [];
  for (const item of record.projects) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    if (typeof row.projectRef !== "string" || !DESKTOP_QUICK_SESSION_PROJECT_REF_PATTERN.test(row.projectRef)) {
      return null;
    }
    if (typeof row.displayName !== "string" || !row.displayName.trim()) return null;
    projects.push({
      projectRef: row.projectRef,
      displayName: row.displayName.trim(),
      ...(typeof row.disambiguator === "string" && row.disambiguator.trim()
        ? { disambiguator: row.disambiguator.trim() }
        : {}),
      latestModified: typeof row.latestModified === "string" ? row.latestModified : "",
      archived: row.archived === true,
      worktree: row.worktree === true,
    });
  }
  const catalog: DesktopQuickSessionCatalog = {
    projects,
    truncated: record.truncated === true,
    omitted: typeof record.omitted === "number" && Number.isFinite(record.omitted)
      ? Math.max(0, Math.floor(record.omitted))
      : 0,
  };
  assertSafePayload(catalog);
  return catalog;
}

function parseStartResult(payload: unknown): DesktopQuickSessionStartResult | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.sessionId !== "string" || !record.sessionId.trim()) return null;
  if (typeof record.deepLink !== "string" || !record.deepLink.startsWith("/?session=")) return null;
  const result: DesktopQuickSessionStartResult = {
    sessionId: record.sessionId.trim(),
    deepLink: record.deepLink,
    duplicate: record.duplicate === true,
  };
  assertSafePayload(result);
  return result;
}

export function sanitizeQuickSessionCreateInput(input: {
  projectRef?: unknown;
  message?: unknown;
  requestId?: unknown;
}): DesktopQuickSessionClientFailure | { projectRef: string; message: string; requestId: string } {
  if (typeof input.projectRef !== "string" || !DESKTOP_QUICK_SESSION_PROJECT_REF_PATTERN.test(input.projectRef.trim())) {
    return fail("bad_request");
  }
  if (typeof input.requestId !== "string" || !DESKTOP_QUICK_SESSION_REQUEST_ID_PATTERN.test(input.requestId.trim())) {
    return fail("bad_request");
  }
  if (typeof input.message !== "string") return fail("bad_request");
  if (!input.message.trim()) return fail("message_empty");
  if ([...input.message].length > DESKTOP_QUICK_SESSION_MAX_MESSAGE_CHARS) {
    return fail("message_too_long");
  }
  return {
    projectRef: input.projectRef.trim(),
    message: input.message,
    requestId: input.requestId.trim(),
  };
}

export class DesktopQuickSessionClient {
  private readonly fetchImpl: DesktopFetch;
  private readonly now: () => number;
  private port: number;
  private accessKey: string | null;
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private tokenInstanceId: string | null = null;
  private stopped = false;
  private available = false;
  private connected = false;
  private instanceId: string | null = null;

  constructor(options: DesktopQuickSessionClientOptions = {}) {
    this.port = options.port ?? DESKTOP_DEFAULT_PORT;
    this.fetchImpl = options.fetch ?? defaultControlFetch;
    this.now = options.now ?? Date.now;
    this.accessKey = normalizeAccessKey(options.accessKey);
  }

  setConnection(input: {
    connected: boolean;
    quickSessionAvailable: boolean;
    instanceId?: string | null;
    port?: number;
  }): void {
    this.connected = input.connected;
    this.available = input.quickSessionAvailable === true;
    if (typeof input.port === "number" && input.port > 0) this.port = Math.floor(input.port);
    const nextInstance = input.instanceId?.trim() || null;
    if (nextInstance && this.instanceId && nextInstance !== this.instanceId) {
      this.discardToken();
    }
    this.instanceId = nextInstance;
    if (!this.connected || !this.available) this.discardToken();
  }

  setAccessKey(value: string | null | undefined): void {
    this.accessKey = normalizeAccessKey(value);
    this.discardToken();
  }

  quit(): void {
    this.stopped = true;
    this.discardToken();
  }

  getTokenForTests(): string | null {
    return this.token;
  }

  async listProjects(): Promise<DesktopQuickSessionClientResult<DesktopQuickSessionCatalog>> {
    if (this.stopped) return fail("disconnected");
    if (!this.connected) return fail("disconnected");
    if (!this.available) return fail("feature_unavailable");

    const authed = await this.ensureToken({ remint: true });
    if (!authed.ok) return authed;
    const listed = await this.requestJson("GET", `${DESKTOP_CONTROL_API_PREFIX}/projects`, {
      headers: { [DESKTOP_CONTROL_TOKEN_HEADER]: authed.token },
    });
    if (!listed.ok) {
      if (listed.code === "unauthorized") {
        this.discardToken();
        const retried = await this.ensureToken({ remint: true });
        if (!retried.ok) return retried;
        const again = await this.requestJson("GET", `${DESKTOP_CONTROL_API_PREFIX}/projects`, {
          headers: { [DESKTOP_CONTROL_TOKEN_HEADER]: retried.token },
        });
        if (!again.ok) return again;
        const catalog = parseCatalog(again.payload);
        return catalog ? { ok: true, value: catalog } : fail("result_unknown");
      }
      return listed;
    }
    const catalog = parseCatalog(listed.payload);
    return catalog ? { ok: true, value: catalog } : fail("result_unknown");
  }

  async createSession(input: {
    projectRef: unknown;
    message: unknown;
    requestId: unknown;
  }): Promise<DesktopQuickSessionClientResult<DesktopQuickSessionStartResult>> {
    if (this.stopped) return fail("disconnected");
    if (!this.connected) return fail("disconnected");
    if (!this.available) return fail("feature_unavailable");

    const sanitized = sanitizeQuickSessionCreateInput(input);
    if ("ok" in sanitized && sanitized.ok === false) return sanitized;

    const authed = await this.ensureToken({ remint: this.token == null });
    if (!authed.ok) return authed;

    const created = await this.requestJson("POST", `${DESKTOP_CONTROL_API_PREFIX}/quick-sessions`, {
      headers: {
        [DESKTOP_CONTROL_TOKEN_HEADER]: authed.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(sanitized),
    });
    if (!created.ok) {
      if (created.code === "unauthorized" && this.token) {
        this.discardToken();
        const reminted = await this.ensureToken({ remint: true });
        if (!reminted.ok) return reminted;
        const retried = await this.requestJson("POST", `${DESKTOP_CONTROL_API_PREFIX}/quick-sessions`, {
          headers: {
            [DESKTOP_CONTROL_TOKEN_HEADER]: reminted.token,
            "content-type": "application/json",
          },
          body: JSON.stringify(sanitized),
        });
        if (!retried.ok) return retried;
        const parsedRetry = parseStartResult(retried.payload);
        return parsedRetry ? { ok: true, value: parsedRetry } : fail("result_unknown");
      }
      return created;
    }
    const parsed = parseStartResult(created.payload);
    return parsed ? { ok: true, value: parsed } : fail("result_unknown");
  }

  private discardToken(): void {
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenInstanceId = null;
  }

  private origin(): string {
    return buildDesktopOrigin(this.port);
  }

  private async ensureToken(input: { remint: boolean }): Promise<
    DesktopQuickSessionClientFailure | { ok: true; token: string }
  > {
    const stillValid = Boolean(this.token) && this.tokenExpiresAt - 5_000 > this.now();
    if (stillValid && this.token && !input.remint) {
      return { ok: true, token: this.token };
    }
    const minted = await this.mintToken();
    if (!minted.ok) return minted;
    return { ok: true, token: minted.token };
  }

  private async mintToken(): Promise<
    { ok: true; token: string } | DesktopQuickSessionClientFailure
  > {
    const session = await this.requestJson("POST", `${DESKTOP_CONTROL_API_PREFIX}/session`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(this.accessKey ? { accessKey: this.accessKey } : {}),
    });
    if (!session.ok) return session;
    const payload = session.payload;
    if (!payload || typeof payload !== "object") return fail("result_unknown");
    const record = payload as Record<string, unknown>;
    if (typeof record.token !== "string" || !record.token.includes(".")) return fail("result_unknown");
    if (typeof record.instanceId === "string" && this.instanceId && record.instanceId !== this.instanceId) {
      return fail("result_unknown");
    }
    this.token = record.token;
    this.tokenExpiresAt =
      typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)
        ? record.expiresAt
        : this.now() + 5 * 60 * 1000;
    this.tokenInstanceId = typeof record.instanceId === "string" ? record.instanceId : this.instanceId;
    return { ok: true, token: this.token };
  }

  private async requestJson(
    method: "GET" | "POST",
    pathname: string,
    init: { headers?: Record<string, string>; body?: string } = {},
  ): Promise<
    | { ok: true; payload: unknown }
    | DesktopQuickSessionClientFailure
  > {
    try {
      const response = await this.fetchImpl(`${this.origin()}${pathname}`, {
        method,
        headers: init.headers,
        body: init.body,
      });
      let payload: unknown = {};
      try {
        payload = await response.json();
      } catch {
        payload = {};
      }
      if (!response.ok) {
        return fail(classifyHttpCode(response.status, payload));
      }
      return { ok: true, payload };
    } catch (error) {
      const event = classifyFetchFailure(error);
      if (event.type === "connection_refused") return fail("disconnected");
      return fail("result_unknown");
    }
  }
}

async function defaultControlFetch(
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    body?: string;
  },
): Promise<DesktopFetchResponse> {
  const response = await fetch(input, {
    method: init?.method,
    headers: init?.headers,
    signal: init?.signal,
    body: init?.body,
  });
  return {
    ok: response.ok,
    status: response.status,
    json: async () => response.json() as Promise<unknown>,
    text: async () => response.text(),
  };
}
