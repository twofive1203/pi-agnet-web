/**
 * Allowlisted relative WebUI deep links for the desktop pet observer (U5).
 *
 * Server adapters emit these paths; Electron main re-validates before
 * shell.openExternal. AppShell consumes one-time query intents once.
 *
 * Privacy: links carry stable ids only — never cwd, Prompt, paths, or secrets.
 */

/** Allowed top-level query keys on observer deep links. */
export const DESKTOP_DEEP_LINK_QUERY_KEYS = [
  "session",
  "inspector",
  "task",
  "panel",
  "run",
] as const;

export type DesktopDeepLinkQueryKey = (typeof DESKTOP_DEEP_LINK_QUERY_KEYS)[number];

/** Forbidden query keys that would leak path/content or open arbitrary surfaces. */
export const DESKTOP_DEEP_LINK_FORBIDDEN_QUERY_KEYS = [
  "cwd",
  "path",
  "file",
  "filePath",
  "sessionPath",
  "url",
  "href",
  "redirect",
  "next",
  "token",
  "prompt",
  "command",
  "output",
] as const;

export type DesktopDeepLinkKind = "agent" | "snflow" | "automation" | "quick_command";

export type DesktopDeepLinkTarget =
  | { kind: "agent"; sessionId: string }
  | { kind: "snflow"; sessionId: string | null; taskId: string }
  | { kind: "automation"; taskId: string; runId: string }
  | { kind: "quick_command"; runId: string };

/** One-time AppShell query intents (panel/inspector focus). Session restore stays separate. */
export type DesktopDeepLinkIntent =
  | { kind: "snflow"; sessionId: string | null; taskId: string }
  | { kind: "automation"; taskId: string; runId: string }
  | { kind: "quick_command"; runId: string };

export type DesktopDeepLinkParseResult =
  | { ok: true; href: string; target: DesktopDeepLinkTarget }
  | { ok: false; reason: string };

export type DesktopDeepLinkIntentParseResult =
  | { ok: true; intent: DesktopDeepLinkIntent | null }
  | { ok: false; reason: string };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ALLOWED_QUERY = new Set<string>(DESKTOP_DEEP_LINK_QUERY_KEYS);
const FORBIDDEN_QUERY = new Set<string>(DESKTOP_DEEP_LINK_FORBIDDEN_QUERY_KEYS);

function requireId(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  if (!ID_PATTERN.test(trimmed)) throw new Error(`${label} is not a stable id`);
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new Error(`${label} must not contain path segments`);
  }
  return trimmed;
}

function encodeId(value: string): string {
  return encodeURIComponent(value);
}

/** Ordinary Agent session deep link. */
export function buildAgentDeepLink(sessionId: string): string {
  const id = requireId("sessionId", sessionId);
  return `/?session=${encodeId(id)}`;
}

/** SnFlow task deep link; optional host session keeps chat context. */
export function buildSnflowDeepLink(input: {
  taskId: string;
  sessionId?: string | null;
}): string {
  const taskId = requireId("taskId", input.taskId);
  const sessionId = input.sessionId?.trim() ? requireId("sessionId", input.sessionId) : null;
  if (sessionId) {
    return `/?session=${encodeId(sessionId)}&inspector=snflow&task=${encodeId(taskId)}`;
  }
  return `/?inspector=snflow&task=${encodeId(taskId)}`;
}

/** Automation run deep link. */
export function buildAutomationDeepLink(input: {
  taskId: string;
  runId: string;
}): string {
  const taskId = requireId("taskId", input.taskId);
  const runId = requireId("runId", input.runId);
  return `/?panel=automation&task=${encodeId(taskId)}&run=${encodeId(runId)}`;
}

/** Quick Command run deep link (process-local; may be unavailable after restart). */
export function buildQuickCommandDeepLink(input: { runId: string }): string {
  const runId = requireId("runId", input.runId);
  return `/?panel=quick-commands&run=${encodeId(runId)}`;
}

export function buildDesktopDeepLink(target: DesktopDeepLinkTarget): string {
  switch (target.kind) {
    case "agent":
      return buildAgentDeepLink(target.sessionId);
    case "snflow":
      return buildSnflowDeepLink({ taskId: target.taskId, sessionId: target.sessionId });
    case "automation":
      return buildAutomationDeepLink({ taskId: target.taskId, runId: target.runId });
    case "quick_command":
      return buildQuickCommandDeepLink({ runId: target.runId });
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

function isForbiddenAbsoluteOrProtocolRelative(raw: string): boolean {
  const value = raw.trim();
  if (!value) return true;
  // Absolute / scheme / protocol-relative
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return true;
  if (value.startsWith("//")) return true;
  if (value.includes("\\")) return true;
  return false;
}

/**
 * Normalize and validate a relative observer deep link.
 * Accepts only `/?…` or `/` root forms with allowlisted query keys.
 */
export function parseDesktopDeepLink(raw: string): DesktopDeepLinkParseResult {
  if (typeof raw !== "string") {
    return { ok: false, reason: "not_a_string" };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (isForbiddenAbsoluteOrProtocolRelative(trimmed)) {
    return { ok: false, reason: "absolute_or_protocol_relative" };
  }
  if (!trimmed.startsWith("/")) {
    return { ok: false, reason: "must_be_root_relative" };
  }
  if (trimmed.startsWith("//")) {
    return { ok: false, reason: "protocol_relative" };
  }

  let url: URL;
  try {
    url = new URL(trimmed, "http://desktop-deep-link.local");
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (url.pathname !== "/" && url.pathname !== "") {
    return { ok: false, reason: "path_not_allowlisted" };
  }
  if (url.hash) {
    return { ok: false, reason: "hash_not_allowed" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "userinfo_not_allowed" };
  }

  const params = url.searchParams;
  for (const key of params.keys()) {
    if (FORBIDDEN_QUERY.has(key) || key.toLowerCase() === "cwd") {
      return { ok: false, reason: `forbidden_query:${key}` };
    }
    if (!ALLOWED_QUERY.has(key)) {
      return { ok: false, reason: `unknown_query:${key}` };
    }
  }

  try {
    const target = targetFromSearchParams(params);
    if (!target) {
      // Bare `/?session=` handled by agent; bare `/` is not a target activity link.
      const sessionId = params.get("session")?.trim() ?? "";
      if (sessionId && params.size === 1) {
        const id = requireId("sessionId", sessionId);
        const href = buildAgentDeepLink(id);
        return { ok: true, href, target: { kind: "agent", sessionId: id } };
      }
      return { ok: false, reason: "missing_target" };
    }
    const href = buildDesktopDeepLink(target);
    return { ok: true, href, target };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "invalid_id",
    };
  }
}

function targetFromSearchParams(params: URLSearchParams): DesktopDeepLinkTarget | null {
  const panel = params.get("panel")?.trim() ?? "";
  const inspector = params.get("inspector")?.trim() ?? "";
  const sessionRaw = params.get("session");
  const sessionId = sessionRaw?.trim() ? requireId("sessionId", sessionRaw) : null;
  const taskRaw = params.get("task");
  const runRaw = params.get("run");

  if (panel === "automation") {
    if (inspector) throw new Error("automation_panel_with_inspector");
    if (!taskRaw || !runRaw) throw new Error("automation_requires_task_and_run");
    return {
      kind: "automation",
      taskId: requireId("taskId", taskRaw),
      runId: requireId("runId", runRaw),
    };
  }

  if (panel === "quick-commands") {
    if (inspector) throw new Error("quick_command_with_inspector");
    if (!runRaw) throw new Error("quick_command_requires_run");
    if (taskRaw) throw new Error("quick_command_rejects_task");
    return {
      kind: "quick_command",
      runId: requireId("runId", runRaw),
    };
  }

  if (panel) {
    throw new Error(`unknown_panel:${panel}`);
  }

  if (inspector === "snflow") {
    if (!taskRaw) throw new Error("snflow_requires_task");
    if (runRaw) throw new Error("snflow_rejects_run");
    return {
      kind: "snflow",
      sessionId,
      taskId: requireId("taskId", taskRaw),
    };
  }

  if (inspector) {
    throw new Error(`unknown_inspector:${inspector}`);
  }

  if (sessionId && !taskRaw && !runRaw) {
    return { kind: "agent", sessionId };
  }

  return null;
}

/**
 * Parse one-time panel/inspector intents from the current page query.
 * Ordinary `?session=` alone is not an intent (AppShell already restores it).
 */
export function parseDesktopDeepLinkIntent(
  input: URLSearchParams | Record<string, string | string[] | undefined | null> | string,
): DesktopDeepLinkIntentParseResult {
  const params = toSearchParams(input);
  for (const key of params.keys()) {
    if (FORBIDDEN_QUERY.has(key) || key.toLowerCase() === "cwd") {
      return { ok: false, reason: `forbidden_query:${key}` };
    }
  }

  // Unknown keys are ignored for page URL (Next may add others later); only
  // reject when an allowlisted key has an invalid combination.
  try {
    const panel = params.get("panel")?.trim() ?? "";
    const inspector = params.get("inspector")?.trim() ?? "";
    const sessionRaw = params.get("session");
    const sessionId = sessionRaw?.trim() ? requireId("sessionId", sessionRaw) : null;
    const taskRaw = params.get("task");
    const runRaw = params.get("run");

    if (!panel && !inspector && !taskRaw && !runRaw) {
      return { ok: true, intent: null };
    }

    if (panel === "automation") {
      if (!taskRaw || !runRaw) return { ok: false, reason: "automation_requires_task_and_run" };
      return {
        ok: true,
        intent: {
          kind: "automation",
          taskId: requireId("taskId", taskRaw),
          runId: requireId("runId", runRaw),
        },
      };
    }

    if (panel === "quick-commands") {
      if (!runRaw) return { ok: false, reason: "quick_command_requires_run" };
      return {
        ok: true,
        intent: {
          kind: "quick_command",
          runId: requireId("runId", runRaw),
        },
      };
    }

    if (panel) {
      return { ok: false, reason: `unknown_panel:${panel}` };
    }

    if (inspector === "snflow") {
      if (!taskRaw) return { ok: false, reason: "snflow_requires_task" };
      return {
        ok: true,
        intent: {
          kind: "snflow",
          sessionId,
          taskId: requireId("taskId", taskRaw),
        },
      };
    }

    if (inspector) {
      return { ok: false, reason: `unknown_inspector:${inspector}` };
    }

    // task/run without panel/inspector is invalid for one-time intent.
    if (taskRaw || runRaw) {
      return { ok: false, reason: "orphaned_task_or_run" };
    }

    return { ok: true, intent: null };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "invalid_id",
    };
  }
}

function toSearchParams(
  input: URLSearchParams | Record<string, string | string[] | undefined | null> | string,
): URLSearchParams {
  if (typeof input === "string") {
    const q = input.startsWith("?") || input.startsWith("/") ? input : `?${input}`;
    try {
      return new URL(q.startsWith("/") ? q : `/${q}`, "http://desktop-deep-link.local").searchParams;
    } catch {
      return new URLSearchParams(input.replace(/^\?/, ""));
    }
  }
  if (input instanceof URLSearchParams) return new URLSearchParams(input.toString());
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.set(key, value);
    }
  }
  return params;
}

/** True when the relative href is allowlisted for main-process openExternal. */
export function isAllowlistedDesktopDeepLink(raw: string): boolean {
  return parseDesktopDeepLink(raw).ok;
}

/**
 * Resolve a validated relative deep link against a verified loopback origin.
 * Rejects non-loopback origins and non-allowlisted hrefs.
 */
export function resolveDesktopDeepLink(
  origin: string,
  relativeHref: string,
): { ok: true; url: string } | { ok: false; reason: string } {
  const originTrimmed = origin.trim().replace(/\/$/, "");
  let originUrl: URL;
  try {
    originUrl = new URL(originTrimmed);
  } catch {
    return { ok: false, reason: "invalid_origin" };
  }
  if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
    return { ok: false, reason: "origin_protocol" };
  }
  const host = originUrl.hostname.toLowerCase();
  if (host !== "127.0.0.1" && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return { ok: false, reason: "origin_not_loopback" };
  }

  const parsed = parseDesktopDeepLink(relativeHref);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  return { ok: true, url: `${originTrimmed}${parsed.href}` };
}

/**
 * Build a URLSearchParams strip set: drop one-time intent keys, keep session.
 * Used after AppShell consumes the intent so rerenders/refresh do not reopen panels.
 */
export function stripDesktopDeepLinkIntentParams(
  input: URLSearchParams | string,
): { sessionId: string | null; search: string } {
  const params = toSearchParams(input);
  const sessionId = params.get("session")?.trim() || null;
  const next = new URLSearchParams();
  if (sessionId) next.set("session", sessionId);
  const search = next.toString();
  return { sessionId, search: search ? `?${search}` : "" };
}

/** Stable unavailable reason codes for missing deep-link targets. */
export const DESKTOP_DEEP_LINK_UNAVAILABLE = {
  snflow_task: "snflow_task_unavailable",
  automation_run: "automation_run_unavailable",
  quick_command_run: "quick_command_run_unavailable",
} as const;

export type DesktopDeepLinkUnavailableReason =
  (typeof DESKTOP_DEEP_LINK_UNAVAILABLE)[keyof typeof DESKTOP_DEEP_LINK_UNAVAILABLE];
