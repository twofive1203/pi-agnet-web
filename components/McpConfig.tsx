"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppDialog } from "@/components/AppDialogProvider";
import { useI18n } from "@/components/I18nProvider";

// ---------------------------------------------------------------------------
// Wire types (kept in sync with lib/mcp-config.ts + /api/mcp/config)
// ---------------------------------------------------------------------------

type McpScope = "user" | "project";
type McpWritableTargetId = "user-shared" | "user-pi" | "project-shared" | "project-pi";
type McpTransportKind = "stdio" | "http" | "socket";
type McpLifecycle = "lazy" | "eager" | "keep-alive" | "lazy-keep-alive";
type McpAuthMode = "oauth" | "bearer" | false;
type SecretMode = "preserve" | "replace" | "clear";

interface McpSecretProjection {
  key: string;
  configured: boolean;
  executableSecret?: boolean;
}

interface McpOAuthProjection {
  grantType?: "authorization_code" | "client_credentials";
  clientId?: string;
  scope?: string;
  redirectUri?: string;
  clientName?: string;
  clientUri?: string;
  clientSecret?: McpSecretProjection;
  disabled?: boolean;
}

interface McpServerProjection {
  name: string;
  transport: McpTransportKind | "unknown";
  command?: string;
  args?: string[];
  socket?: string;
  cwd?: string;
  url?: string;
  auth?: McpAuthMode;
  bearerTokenEnv?: string;
  oauth?: McpOAuthProjection;
  lifecycle?: McpLifecycle;
  idleTimeout?: number;
  requestTimeoutMs?: number;
  exposeResources?: boolean;
  directTools?: boolean | string[];
  includeTools?: string[];
  excludeTools?: string[];
  debug?: boolean;
  trace?: boolean;
  disabled?: boolean;
  env?: McpSecretProjection[];
  headers?: McpSecretProjection[];
  bearerToken?: McpSecretProjection;
  risks: { hasExecutableSecret: boolean; eagerOrKeepAlive: boolean };
  unknownFieldKeys: string[];
}

interface McpSettingsProjection {
  toolPrefix?: "server" | "none" | "short" | "mcp";
  showStatusIcon?: boolean;
  hostConfigDiscovery?: "off" | "prompt" | "on";
  idleTimeout?: number;
  requestTimeoutMs?: number;
  directTools?: boolean;
  disableProxyTool?: boolean;
  autoAuth?: boolean;
  sampling?: boolean;
  samplingAutoApprove?: boolean;
  elicitation?: boolean;
  outputGuard?: boolean | { maxBytes?: number; maxLines?: number; detailsMaxBytes?: number };
  trace?: { enabled?: boolean; file?: string; maxBytes?: number; maxEvents?: number };
  authRequiredMessage?: string;
  oauthDir?: string;
  unknownFieldKeys: string[];
}

interface McpConfigProjection {
  servers: McpServerProjection[];
  imports?: string[];
  settings?: McpSettingsProjection;
  unknownRootKeys: string[];
}

interface McpSourceSummary {
  id: string;
  label: string;
  path: string;
  displayPath: string;
  scope: string;
  kind: string;
  precedence: number;
  exists: boolean;
  writable: boolean;
  parseState: "missing" | "valid" | "parse-error";
  serverCount: number;
  parseError?: string;
}

interface McpAdapterPackageStatus {
  configured: boolean;
  sources: Array<{ source: string; scope: "user" | "project"; filtered: boolean }>;
  version?: string;
  versionUnknown: boolean;
  diagnostic?: string;
  installCommand: string;
}

interface McpTargetFileState {
  targetId: McpWritableTargetId;
  path: string;
  displayPath: string;
  exists: boolean;
  revision: string;
  parseError?: string;
  projection: McpConfigProjection;
}

interface McpConfigResponse {
  scope: McpScope;
  targetId: McpWritableTargetId;
  cwd?: string;
  adapter: McpAdapterPackageStatus;
  sources: McpSourceSummary[];
  selected: McpTargetFileState;
  reloadRequiredHint?: string;
  runtimeConnection?: string;
  error?: string;
  code?: string;
}

interface SecretDraft {
  key: string;
  mode: SecretMode;
  value: string;
  configured: boolean;
  executableSecret?: boolean;
}

interface ServerDraft {
  name: string;
  originalName: string;
  isNew: boolean;
  transport: McpTransportKind;
  command: string;
  argsText: string;
  socket: string;
  cwd: string;
  url: string;
  auth: "" | "oauth" | "bearer" | "false";
  bearerTokenEnv: string;
  lifecycle: "" | McpLifecycle;
  idleTimeout: string;
  requestTimeoutMs: string;
  exposeResources: "" | "true" | "false";
  directToolsText: string;
  includeToolsText: string;
  excludeToolsText: string;
  debug: boolean;
  trace: boolean;
  disabled: boolean;
  env: SecretDraft[];
  headers: SecretDraft[];
  bearerToken: SecretDraft;
  oauthEnabled: boolean;
  oauthGrantType: "" | "authorization_code" | "client_credentials";
  oauthClientId: string;
  oauthScope: string;
  oauthRedirectUri: string;
  oauthClientName: string;
  oauthClientUri: string;
  oauthClientSecret: SecretDraft;
  confirmUrlAuthClear: boolean;
  expanded: boolean;
  risks: { hasExecutableSecret: boolean; eagerOrKeepAlive: boolean };
  unknownFieldKeys: string[];
}

interface SettingsDraft {
  toolPrefix: "" | "server" | "none" | "short" | "mcp";
  showStatusIcon: "" | "true" | "false";
  hostConfigDiscovery: "" | "off" | "prompt" | "on";
  idleTimeout: string;
  requestTimeoutMs: string;
  directTools: "" | "true" | "false";
  disableProxyTool: "" | "true" | "false";
  autoAuth: "" | "true" | "false";
  sampling: "" | "true" | "false";
  samplingAutoApprove: "" | "true" | "false";
  elicitation: "" | "true" | "false";
  outputGuard: "" | "true" | "false";
  outputGuardMaxBytes: string;
  outputGuardMaxLines: string;
  outputGuardDetailsMaxBytes: string;
  traceEnabled: "" | "true" | "false";
  traceFile: string;
  traceMaxBytes: string;
  traceMaxEvents: string;
  authRequiredMessage: string;
  oauthDir: string;
  importsText: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
  padding: "7px 9px",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const TARGETS: Array<{ id: McpWritableTargetId; scope: McpScope; labelKey: string }> = [
  { id: "user-shared", scope: "user", labelKey: "settings.mcp.targetUserShared" },
  { id: "user-pi", scope: "user", labelKey: "settings.mcp.targetUserPi" },
  { id: "project-shared", scope: "project", labelKey: "settings.mcp.targetProjectShared" },
  { id: "project-pi", scope: "project", labelKey: "settings.mcp.targetProjectPi" },
];

function emptySecret(key = "", configured = false): SecretDraft {
  return { key, mode: "preserve", value: "", configured };
}

function secretsFromProjection(list?: McpSecretProjection[]): SecretDraft[] {
  return (list ?? []).map((item) => ({
    key: item.key,
    mode: "preserve" as const,
    value: "",
    configured: item.configured,
    executableSecret: item.executableSecret,
  }));
}

function serverToDraft(server: McpServerProjection): ServerDraft {
  const transport: McpTransportKind =
    server.transport === "http" || server.transport === "socket" || server.transport === "stdio"
      ? server.transport
      : server.url
        ? "http"
        : server.socket
          ? "socket"
          : "stdio";
  return {
    name: server.name,
    originalName: server.name,
    isNew: false,
    transport,
    command: server.command ?? "",
    argsText: (server.args ?? []).join("\n"),
    socket: server.socket ?? "",
    cwd: server.cwd ?? "",
    url: server.url ?? "",
    auth: server.auth === false ? "false" : server.auth === "oauth" || server.auth === "bearer" ? server.auth : "",
    bearerTokenEnv: server.bearerTokenEnv ?? "",
    lifecycle: server.lifecycle ?? "",
    idleTimeout: server.idleTimeout === undefined ? "" : String(server.idleTimeout),
    requestTimeoutMs: server.requestTimeoutMs === undefined ? "" : String(server.requestTimeoutMs),
    exposeResources:
      server.exposeResources === undefined ? "" : server.exposeResources ? "true" : "false",
    directToolsText: Array.isArray(server.directTools)
      ? server.directTools.join("\n")
      : server.directTools === true
        ? "*"
        : server.directTools === false
          ? "false"
          : "",
    includeToolsText: (server.includeTools ?? []).join("\n"),
    excludeToolsText: (server.excludeTools ?? []).join("\n"),
    debug: server.debug === true,
    trace: server.trace === true,
    disabled: server.disabled === true,
    env: secretsFromProjection(server.env),
    headers: secretsFromProjection(server.headers),
    bearerToken: {
      key: "bearerToken",
      mode: "preserve",
      value: "",
      configured: server.bearerToken?.configured === true,
      executableSecret: server.bearerToken?.executableSecret,
    },
    oauthEnabled: server.oauth ? server.oauth.disabled !== true : false,
    oauthGrantType: server.oauth?.grantType ?? "",
    oauthClientId: server.oauth?.clientId ?? "",
    oauthScope: server.oauth?.scope ?? "",
    oauthRedirectUri: server.oauth?.redirectUri ?? "",
    oauthClientName: server.oauth?.clientName ?? "",
    oauthClientUri: server.oauth?.clientUri ?? "",
    oauthClientSecret: {
      key: "clientSecret",
      mode: "preserve",
      value: "",
      configured: server.oauth?.clientSecret?.configured === true,
      executableSecret: server.oauth?.clientSecret?.executableSecret,
    },
    confirmUrlAuthClear: false,
    expanded: false,
    risks: server.risks,
    unknownFieldKeys: server.unknownFieldKeys,
  };
}

function numField(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function projectionToSettingsDraft(projection: McpConfigProjection): SettingsDraft {
  const settings = projection.settings;
  const bool = (value: boolean | undefined): "" | "true" | "false" =>
    value === undefined ? "" : value ? "true" : "false";
  const outputGuardObject =
    settings?.outputGuard && typeof settings.outputGuard === "object"
      ? settings.outputGuard
      : null;
  const trace = settings?.trace && typeof settings.trace === "object" ? settings.trace : null;
  return {
    toolPrefix: settings?.toolPrefix ?? "",
    showStatusIcon: bool(settings?.showStatusIcon),
    hostConfigDiscovery: settings?.hostConfigDiscovery ?? "",
    idleTimeout: settings?.idleTimeout === undefined ? "" : String(settings.idleTimeout),
    requestTimeoutMs: settings?.requestTimeoutMs === undefined ? "" : String(settings.requestTimeoutMs),
    directTools: bool(settings?.directTools),
    disableProxyTool: bool(settings?.disableProxyTool),
    autoAuth: bool(settings?.autoAuth),
    sampling: bool(settings?.sampling),
    samplingAutoApprove: bool(settings?.samplingAutoApprove),
    elicitation: bool(settings?.elicitation),
    outputGuard:
      settings?.outputGuard === undefined
        ? ""
        : settings.outputGuard === false
          ? "false"
          : "true",
    outputGuardMaxBytes: numField(outputGuardObject?.maxBytes),
    outputGuardMaxLines: numField(outputGuardObject?.maxLines),
    outputGuardDetailsMaxBytes: numField(outputGuardObject?.detailsMaxBytes),
    traceEnabled: bool(trace?.enabled),
    traceFile: trace?.file ?? "",
    traceMaxBytes: numField(trace?.maxBytes),
    traceMaxEvents: numField(trace?.maxEvents),
    authRequiredMessage: settings?.authRequiredMessage ?? "",
    oauthDir: settings?.oauthDir ?? "",
    importsText: (projection.imports ?? []).join("\n"),
  };
}

/** Pure helper: prefer a freshly loaded revision over stale React state. */
export function resolveMcpClientSaveRevision(
  stateRevision: string,
  loadedRevision?: string | null,
): string {
  if (typeof loadedRevision === "string" && loadedRevision.trim()) return loadedRevision;
  return stateRevision;
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseOptionalNumber(text: string): number | null | undefined {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function parseOptionalBool(value: "" | "true" | "false"): boolean | null | undefined {
  if (value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function secretOps(list: SecretDraft[]): Record<string, { op: SecretMode; value?: string }> | undefined {
  const ops: Record<string, { op: SecretMode; value?: string }> = {};
  let any = false;
  for (const item of list) {
    const key = item.key.trim();
    if (!key) continue;
    if (item.mode === "preserve" && item.configured) continue;
    if (item.mode === "preserve" && !item.configured && !item.value) continue;
    if (item.mode === "replace") {
      ops[key] = { op: "replace", value: item.value };
      any = true;
    } else if (item.mode === "clear") {
      ops[key] = { op: "clear" };
      any = true;
    } else if (!item.configured && item.value) {
      ops[key] = { op: "replace", value: item.value };
      any = true;
    }
  }
  return any ? ops : undefined;
}

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, color: "var(--text)", fontWeight: 600 }}>{label}</span>
      {children}
      {description && (
        <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>{description}</span>
      )}
    </label>
  );
}

function SecretRow({
  item,
  onChange,
  onRemove,
  label,
}: {
  item: SecretDraft;
  label?: string;
  onChange: (next: SecretDraft) => void;
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 120px 1fr auto", gap: 6, alignItems: "center" }}>
      <input
        style={inputStyle}
        value={item.key}
        placeholder={label ?? t("settings.mcp.secretKey")}
        onChange={(e) => onChange({ ...item, key: e.target.value })}
      />
      <select
        style={inputStyle}
        value={item.mode}
        onChange={(e) => onChange({ ...item, mode: e.target.value as SecretMode })}
      >
        <option value="preserve">{t("settings.mcp.secretPreserve")}{item.configured ? " ●" : ""}</option>
        <option value="replace">{t("settings.mcp.secretReplace")}</option>
        <option value="clear">{t("settings.mcp.secretClear")}</option>
      </select>
      <input
        style={inputStyle}
        type="password"
        autoComplete="new-password"
        disabled={item.mode !== "replace"}
        value={item.mode === "replace" ? item.value : ""}
        placeholder={item.configured ? "••••••••" : t("settings.mcp.secretValue")}
        onChange={(e) => onChange({ ...item, value: e.target.value })}
      />
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}
        >
          ×
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function McpConfig({ cwd }: { cwd: string | null }) {
  const { t } = useI18n();
  const appDialog = useAppDialog();

  const [targetId, setTargetId] = useState<McpWritableTargetId>("user-shared");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const [adapter, setAdapter] = useState<McpAdapterPackageStatus | null>(null);
  const [sources, setSources] = useState<McpSourceSummary[]>([]);
  const [selected, setSelected] = useState<McpTargetFileState | null>(null);
  const [revision, setRevision] = useState<string>("");
  const [parseError, setParseError] = useState<string | undefined>();
  const [reloadHint, setReloadHint] = useState<string>("");

  const [servers, setServers] = useState<ServerDraft[]>([]);
  const [savedServers, setSavedServers] = useState<ServerDraft[]>([]);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft>(projectionToSettingsDraft({ servers: [], unknownRootKeys: [] }));
  const [savedSettings, setSavedSettings] = useState<SettingsDraft>(projectionToSettingsDraft({ servers: [], unknownRootKeys: [] }));
  const [deletedNames, setDeletedNames] = useState<string[]>([]);
  const [savedDeletedNames, setSavedDeletedNames] = useState<string[]>([]);

  const loadedRef = useRef({ targetId: "", cwd: "" });
  const pendingOpsRef = useRef<unknown[] | null>(null);

  const scope: McpScope = targetId.startsWith("project-") ? "project" : "user";
  const readOnly = Boolean(parseError);

  const dirty = useMemo(() => {
    const stripUi = (list: ServerDraft[]) =>
      list.map((server) => {
        const { expanded, ...rest } = server;
        void expanded;
        return rest;
      });
    return (
      JSON.stringify(stripUi(servers)) !== JSON.stringify(stripUi(savedServers))
      || JSON.stringify(settingsDraft) !== JSON.stringify(savedSettings)
      || JSON.stringify(deletedNames) !== JSON.stringify(savedDeletedNames)
    );
  }, [servers, savedServers, settingsDraft, savedSettings, deletedNames, savedDeletedNames]);

  const applySnapshot = useCallback((data: McpConfigResponse) => {
    setAdapter(data.adapter);
    setSources(data.sources ?? []);
    setSelected(data.selected);
    setRevision(data.selected.revision);
    setParseError(data.selected.parseError);
    setReloadHint(data.reloadRequiredHint ?? "");
    const nextServers = (data.selected.projection.servers ?? []).map(serverToDraft);
    const nextSettings = projectionToSettingsDraft(data.selected.projection);
    setServers(nextServers);
    setSavedServers(JSON.parse(JSON.stringify(nextServers)) as ServerDraft[]);
    setSettingsDraft(nextSettings);
    setSavedSettings(JSON.parse(JSON.stringify(nextSettings)) as SettingsDraft);
    setDeletedNames([]);
    setSavedDeletedNames([]);
    setConflict(false);
    pendingOpsRef.current = null;
  }, []);

  const loadConfig = useCallback(async (nextTarget = targetId) => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      if (nextTarget.startsWith("project-") && !cwd) {
        throw new Error(t("settings.mcp.needWorkspace"));
      }
      const params = new URLSearchParams({
        target: nextTarget,
        scope: nextTarget.startsWith("project-") ? "project" : "user",
      });
      if (cwd) params.set("cwd", cwd);
      const res = await fetch(`/api/mcp/config?${params}`);
      const data = await res.json() as McpConfigResponse;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      applySnapshot(data);
      setTargetId(data.targetId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [applySnapshot, cwd, t, targetId]);

  useEffect(() => {
    if (loadedRef.current.targetId === targetId && loadedRef.current.cwd === (cwd ?? "")) return;
    if (targetId.startsWith("project-") && !cwd) {
      setTargetId("user-shared");
      return;
    }
    loadedRef.current = { targetId, cwd: cwd ?? "" };
    void loadConfig(targetId);
  }, [targetId, cwd, loadConfig]);

  const requestTargetChange = useCallback(async (next: McpWritableTargetId) => {
    if (next === targetId) return;
    if (dirty) {
      const ok = await appDialog.confirm({
        message: t("settings.mcp.discardDirtyConfirm"),
        tone: "danger",
      });
      if (!ok) return;
    }
    loadedRef.current = { targetId: "", cwd: "" };
    setTargetId(next);
  }, [appDialog, dirty, t, targetId]);

  const buildOperations = useCallback(() => {
    const operations: unknown[] = [];

    for (const name of deletedNames) {
      operations.push({ op: "deleteServer", name });
    }

    for (const server of servers) {
      const rename = !server.isNew && server.originalName && server.originalName !== server.name.trim();
      if (rename) {
        operations.push({ op: "renameServer", from: server.originalName, to: server.name.trim() });
      }

      const env = secretOps(server.env);
      const headers = secretOps(server.headers);
      const bearerToken =
        server.bearerToken.mode === "replace"
          ? { op: "replace" as const, value: server.bearerToken.value }
          : server.bearerToken.mode === "clear"
            ? { op: "clear" as const }
            : undefined;
      const oauthClientSecret =
        server.oauthClientSecret.mode === "replace"
          ? { op: "replace" as const, value: server.oauthClientSecret.value }
          : server.oauthClientSecret.mode === "clear"
            ? { op: "clear" as const }
            : undefined;

      const mutation: Record<string, unknown> = {
        transport: server.transport,
        command: server.transport === "stdio" ? (server.command || null) : null,
        args: server.transport === "stdio" ? (lines(server.argsText).length ? lines(server.argsText) : null) : null,
        socket: server.transport === "socket" ? (server.socket || null) : null,
        url: server.transport === "http" ? (server.url || null) : null,
        cwd: server.transport === "stdio" ? (server.cwd || null) : null,
        lifecycle: server.lifecycle || null,
        idleTimeout: parseOptionalNumber(server.idleTimeout) === null ? undefined : parseOptionalNumber(server.idleTimeout) ?? null,
        requestTimeoutMs: parseOptionalNumber(server.requestTimeoutMs) === null ? undefined : parseOptionalNumber(server.requestTimeoutMs) ?? null,
        exposeResources: parseOptionalBool(server.exposeResources) === undefined ? null : parseOptionalBool(server.exposeResources),
        debug: server.debug,
        trace: server.trace,
        disabled: server.disabled,
        confirmUrlAuthClear: server.confirmUrlAuthClear || undefined,
      };

      if (server.transport === "http") {
        mutation.auth = server.auth === "" ? null : server.auth === "false" ? false : server.auth;
        mutation.bearerTokenEnv = server.bearerTokenEnv || null;
        if (headers) mutation.headers = headers;
        if (bearerToken) mutation.bearerToken = bearerToken;
        if (!server.oauthEnabled) {
          mutation.oauth = null;
        } else {
          mutation.oauth = {
            grantType: server.oauthGrantType || null,
            clientId: server.oauthClientId || null,
            scope: server.oauthScope || null,
            redirectUri: server.oauthRedirectUri || null,
            clientName: server.oauthClientName || null,
            clientUri: server.oauthClientUri || null,
            clientSecret: oauthClientSecret,
          };
        }
      }
      if (server.transport === "stdio" && env) mutation.env = env;

      if (server.directToolsText.trim() === "*") mutation.directTools = true;
      else if (server.directToolsText.trim() === "false") mutation.directTools = false;
      else if (server.directToolsText.trim()) mutation.directTools = lines(server.directToolsText);
      else mutation.directTools = null;

      mutation.includeTools = lines(server.includeToolsText).length ? lines(server.includeToolsText) : null;
      mutation.excludeTools = lines(server.excludeToolsText).length ? lines(server.excludeToolsText) : null;

      operations.push({
        op: "upsertServer",
        name: server.name.trim(),
        server: mutation,
      });
    }

    const settingsDirty = JSON.stringify(settingsDraft) !== JSON.stringify(savedSettings);
    if (settingsDirty) {
      let outputGuard: unknown = parseOptionalBool(settingsDraft.outputGuard) ?? null;
      if (settingsDraft.outputGuard === "true") {
        const og: Record<string, number> = {};
        const maxBytes = parseOptionalNumber(settingsDraft.outputGuardMaxBytes);
        const maxLines = parseOptionalNumber(settingsDraft.outputGuardMaxLines);
        const detailsMaxBytes = parseOptionalNumber(settingsDraft.outputGuardDetailsMaxBytes);
        if (typeof maxBytes === "number") og.maxBytes = maxBytes;
        if (typeof maxLines === "number") og.maxLines = maxLines;
        if (typeof detailsMaxBytes === "number") og.detailsMaxBytes = detailsMaxBytes;
        outputGuard = Object.keys(og).length > 0 ? og : true;
      }

      let trace: unknown = null;
      const traceEnabled = parseOptionalBool(settingsDraft.traceEnabled);
      const traceFile = settingsDraft.traceFile.trim();
      const traceMaxBytes = parseOptionalNumber(settingsDraft.traceMaxBytes);
      const traceMaxEvents = parseOptionalNumber(settingsDraft.traceMaxEvents);
      if (
        traceEnabled !== undefined
        || traceFile
        || typeof traceMaxBytes === "number"
        || typeof traceMaxEvents === "number"
      ) {
        const tr: Record<string, unknown> = {};
        if (traceEnabled !== undefined) tr.enabled = traceEnabled;
        if (traceFile) tr.file = traceFile;
        if (typeof traceMaxBytes === "number") tr.maxBytes = traceMaxBytes;
        if (typeof traceMaxEvents === "number") tr.maxEvents = traceMaxEvents;
        trace = tr;
      }

      const settings: Record<string, unknown> = {
        toolPrefix: settingsDraft.toolPrefix || null,
        showStatusIcon: parseOptionalBool(settingsDraft.showStatusIcon) ?? null,
        hostConfigDiscovery: settingsDraft.hostConfigDiscovery || null,
        idleTimeout: parseOptionalNumber(settingsDraft.idleTimeout) ?? null,
        requestTimeoutMs: parseOptionalNumber(settingsDraft.requestTimeoutMs) ?? null,
        directTools: parseOptionalBool(settingsDraft.directTools) ?? null,
        disableProxyTool: parseOptionalBool(settingsDraft.disableProxyTool) ?? null,
        autoAuth: parseOptionalBool(settingsDraft.autoAuth) ?? null,
        sampling: parseOptionalBool(settingsDraft.sampling) ?? null,
        samplingAutoApprove: parseOptionalBool(settingsDraft.samplingAutoApprove) ?? null,
        elicitation: parseOptionalBool(settingsDraft.elicitation) ?? null,
        outputGuard,
        trace,
        authRequiredMessage: settingsDraft.authRequiredMessage.trim() || null,
        oauthDir: settingsDraft.oauthDir.trim() || null,
      };
      operations.push({ op: "setSettings", settings });

      const imports = lines(settingsDraft.importsText);
      const savedImports = lines(savedSettings.importsText);
      if (JSON.stringify(imports) !== JSON.stringify(savedImports)) {
        operations.push({ op: "setImports", imports: imports.length ? imports : null });
      }
    }

    return operations;
  }, [deletedNames, savedSettings, servers, settingsDraft]);

  const handleSave = useCallback(async (
    operations?: unknown[],
    loadedRevision?: string | null,
  ) => {
    const expectedRevision = resolveMcpClientSaveRevision(revision, loadedRevision);
    if (!expectedRevision || readOnly) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    setConflict(false);
    try {
      const ok = await appDialog.confirm({
        message: t("settings.mcp.saveConfirm"),
      });
      if (!ok) {
        setSaving(false);
        return;
      }

      const ops = operations ?? buildOperations();
      pendingOpsRef.current = ops;
      const res = await fetch("/api/mcp/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetId,
          cwd,
          expectedRevision,
          operations: ops,
        }),
      });
      const data = await res.json() as McpConfigResponse & {
        success?: boolean;
        reloadRequired?: boolean;
        selected?: McpTargetFileState;
      };
      if (res.status === 409 && data.code === "REVISION_CONFLICT") {
        setConflict(true);
        setError(data.error ?? t("settings.mcp.conflict"));
        return;
      }
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (data.selected) {
        applySnapshot({
          scope,
          targetId,
          adapter: data.adapter ?? adapter!,
          sources: data.sources ?? sources,
          selected: data.selected,
          reloadRequiredHint: data.reloadRequiredHint,
        });
      }
      setNotice(
        data.reloadRequired
          ? t("settings.mcp.savedReload")
          : t("settings.mcp.saved"),
      );
      pendingOpsRef.current = null;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [adapter, appDialog, applySnapshot, buildOperations, cwd, readOnly, revision, scope, sources, t, targetId]);

  const handleReload = useCallback(() => {
    loadedRef.current = { targetId: "", cwd: "" };
    void loadConfig(targetId);
  }, [loadConfig, targetId]);

  const handleReapply = useCallback(async () => {
    // Reload revision then re-submit pending ops with the fresh revision value
    // (do not rely on setRevision + stale handleSave closure).
    try {
      const params = new URLSearchParams({ target: targetId, scope });
      if (cwd) params.set("cwd", cwd);
      const res = await fetch(`/api/mcp/config?${params}`);
      const data = await res.json() as McpConfigResponse;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRevision(data.selected.revision);
      setSelected(data.selected);
      setParseError(data.selected.parseError);
      setConflict(false);
      if (pendingOpsRef.current) {
        await handleSave(pendingOpsRef.current, data.selected.revision);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [cwd, handleSave, scope, targetId]);

  const addServer = useCallback(() => {
    const name = `server-${servers.length + 1}`;
    setServers((prev) => [
      ...prev,
      {
        name,
        originalName: name,
        isNew: true,
        transport: "stdio",
        command: "",
        argsText: "",
        socket: "",
        cwd: "",
        url: "",
        auth: "",
        bearerTokenEnv: "",
        lifecycle: "lazy",
        idleTimeout: "",
        requestTimeoutMs: "",
        exposeResources: "",
        directToolsText: "",
        includeToolsText: "",
        excludeToolsText: "",
        debug: false,
        trace: false,
        disabled: false,
        env: [],
        headers: [],
        bearerToken: emptySecret("bearerToken"),
        oauthEnabled: false,
        oauthGrantType: "",
        oauthClientId: "",
        oauthScope: "",
        oauthRedirectUri: "",
        oauthClientName: "",
        oauthClientUri: "",
        oauthClientSecret: emptySecret("clientSecret"),
        confirmUrlAuthClear: false,
        expanded: true,
        risks: { hasExecutableSecret: false, eagerOrKeepAlive: false },
        unknownFieldKeys: [],
      },
    ]);
    setNotice(null);
  }, [servers.length]);

  const removeServer = useCallback((index: number) => {
    setServers((prev) => {
      const target = prev[index];
      if (!target) return prev;
      if (!target.isNew) {
        setDeletedNames((names) => [...new Set([...names, target.originalName])]);
      }
      return prev.filter((_, i) => i !== index);
    });
    setNotice(null);
  }, []);

  const updateServer = useCallback((index: number, patch: Partial<ServerDraft>) => {
    setServers((prev) => prev.map((server, i) => (i === index ? { ...server, ...patch } : server)));
    setNotice(null);
  }, []);

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(t("settings.mcp.copied"));
    } catch {
      setNotice(text);
    }
  }, [t]);

  if (loading && !selected) {
    return <div style={{ color: "var(--text-muted)", fontSize: 13 }}>{t("settings.mcp.loading")}</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h3 style={{ margin: 0, color: "var(--text)", fontSize: 15 }}>{t("settings.mcp.title")}</h3>
        <p style={{ margin: "5px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
          {t("settings.mcp.description")}
        </p>
      </div>

      {error && (
        <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(239,68,68,0.12)", color: "#f87171", fontSize: 12, overflowWrap: "anywhere" }}>
          {error}
          {conflict && (
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={handleReload} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>
                {t("settings.mcp.reloadDisk")}
              </button>
              <button type="button" onClick={() => void handleReapply()} style={{ padding: "6px 10px", borderRadius: 6, border: "none", background: "var(--accent)", color: "white", cursor: "pointer", fontSize: 12 }}>
                {t("settings.mcp.reapply")}
              </button>
            </div>
          )}
        </div>
      )}
      {notice && (
        <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(37,99,235,0.12)", color: "var(--accent)", fontSize: 12, overflowWrap: "anywhere" }}>
          {notice}
        </div>
      )}

      {/* Package status */}
      <div style={{ padding: 12, borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg-subtle)", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{t("settings.mcp.adapterStatus")}</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {adapter?.configured
            ? t("settings.mcp.adapterConfigured", {
              version: adapter.version ?? t("settings.mcp.versionUnknown"),
            })
            : t("settings.mcp.adapterMissing")}
        </div>
        {adapter?.diagnostic && (
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{adapter.diagnostic}</div>
        )}
        {!adapter?.configured && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <code style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)" }}>{adapter?.installCommand}</code>
            <button type="button" onClick={() => void copyText(adapter?.installCommand ?? "pi install npm:pi-mcp-adapter")} style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>
              {t("settings.mcp.copy")}
            </button>
          </div>
        )}
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>
          {t("settings.mcp.runtimeUnknown")}
        </div>
      </div>

      {/* Target switcher */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{t("settings.mcp.target")}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {TARGETS.map((target) => {
            const disabled = target.scope === "project" && !cwd;
            const active = target.id === targetId;
            return (
              <button
                key={target.id}
                type="button"
                disabled={disabled}
                onClick={() => void requestTargetChange(target.id)}
                style={{
                  padding: "6px 10px",
                  borderRadius: 7,
                  border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
                  background: active ? "rgba(37,99,235,0.12)" : "var(--bg)",
                  color: disabled ? "var(--text-dim)" : "var(--text)",
                  cursor: disabled ? "not-allowed" : "pointer",
                  fontSize: 12,
                  fontWeight: active ? 700 : 500,
                }}
              >
                {t(target.labelKey)}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", overflowWrap: "anywhere" }}>
          {t("settings.mcp.editingPath")}: <code style={{ fontFamily: "var(--font-mono)" }}>{selected?.displayPath ?? selected?.path}</code>
          {selected?.exists ? "" : ` (${t("settings.mcp.willCreate")})`}
        </div>
      </div>

      {/* Precedence sources */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{t("settings.mcp.sources")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {sources.map((source) => (
            <div
              key={source.id}
              style={{
                padding: "8px 10px",
                borderRadius: 8,
                border: source.id === targetId ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: "var(--bg)",
                display: "flex",
                flexDirection: "column",
                gap: 3,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: "var(--text)", fontWeight: 600 }}>
                  #{source.precedence} {source.label}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  {source.exists ? t("settings.mcp.exists") : t("settings.mcp.missing")}
                  {" · "}
                  {source.serverCount} {t("settings.mcp.serversCount")}
                  {" · "}
                  {source.writable ? t("settings.mcp.writable") : t("settings.mcp.readOnly")}
                </span>
              </div>
              <code style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
                {source.displayPath || source.path}
              </code>
              {source.parseError && (
                <span style={{ fontSize: 11, color: "#f87171" }}>{source.parseError}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {parseError && (
        <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(239,68,68,0.12)", color: "#f87171", fontSize: 12 }}>
          {t("settings.mcp.parseErrorLock")}: {parseError}
        </div>
      )}

      {/* Global settings */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, opacity: readOnly ? 0.6 : 1 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{t("settings.mcp.globalSettings")}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
          <Field label={t("settings.mcp.toolPrefix")}>
            <select style={inputStyle} disabled={readOnly} value={settingsDraft.toolPrefix} onChange={(e) => setSettingsDraft((s) => ({ ...s, toolPrefix: e.target.value as SettingsDraft["toolPrefix"] }))}>
              <option value="">{t("settings.mcp.unset")}</option>
              <option value="server">server</option>
              <option value="short">short</option>
              <option value="none">none</option>
              <option value="mcp">mcp</option>
            </select>
          </Field>
          <Field label={t("settings.mcp.hostDiscovery")} description={t("settings.mcp.hostDiscoveryHint")}>
            <select style={inputStyle} disabled={readOnly} value={settingsDraft.hostConfigDiscovery} onChange={(e) => setSettingsDraft((s) => ({ ...s, hostConfigDiscovery: e.target.value as SettingsDraft["hostConfigDiscovery"] }))}>
              <option value="">{t("settings.mcp.unset")}</option>
              <option value="off">off</option>
              <option value="prompt">prompt</option>
              <option value="on">on</option>
            </select>
          </Field>
          <Field label={t("settings.mcp.idleTimeout")}>
            <input style={inputStyle} disabled={readOnly} value={settingsDraft.idleTimeout} onChange={(e) => setSettingsDraft((s) => ({ ...s, idleTimeout: e.target.value }))} />
          </Field>
          <Field label={t("settings.mcp.requestTimeoutMs")}>
            <input style={inputStyle} disabled={readOnly} value={settingsDraft.requestTimeoutMs} onChange={(e) => setSettingsDraft((s) => ({ ...s, requestTimeoutMs: e.target.value }))} />
          </Field>
          {([
            ["samplingAutoApprove", "settings.mcp.samplingAutoApprove", "settings.mcp.samplingAutoApproveHint"],
            ["outputGuard", "settings.mcp.outputGuard", "settings.mcp.outputGuardHint"],
            ["directTools", "settings.mcp.directToolsGlobal", ""],
            ["disableProxyTool", "settings.mcp.disableProxyTool", ""],
            ["autoAuth", "settings.mcp.autoAuth", ""],
            ["sampling", "settings.mcp.sampling", ""],
            ["elicitation", "settings.mcp.elicitation", ""],
            ["showStatusIcon", "settings.mcp.showStatusIcon", ""],
          ] as const).map(([key, labelKey, hintKey]) => (
            <Field key={key} label={t(labelKey)} description={hintKey ? t(hintKey) : undefined}>
              <select
                style={inputStyle}
                disabled={readOnly}
                value={settingsDraft[key]}
                onChange={(e) => setSettingsDraft((s) => ({ ...s, [key]: e.target.value as "" | "true" | "false" }))}
              >
                <option value="">{t("settings.mcp.unset")}</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </Field>
          ))}
        </div>

        {settingsDraft.outputGuard === "true" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
            <Field label={t("settings.mcp.outputGuardMaxBytes")} description={t("settings.mcp.outputGuardLimitsHint")}>
              <input
                style={inputStyle}
                disabled={readOnly}
                value={settingsDraft.outputGuardMaxBytes}
                onChange={(e) => setSettingsDraft((s) => ({ ...s, outputGuardMaxBytes: e.target.value }))}
              />
            </Field>
            <Field label={t("settings.mcp.outputGuardMaxLines")}>
              <input
                style={inputStyle}
                disabled={readOnly}
                value={settingsDraft.outputGuardMaxLines}
                onChange={(e) => setSettingsDraft((s) => ({ ...s, outputGuardMaxLines: e.target.value }))}
              />
            </Field>
            <Field label={t("settings.mcp.outputGuardDetailsMaxBytes")}>
              <input
                style={inputStyle}
                disabled={readOnly}
                value={settingsDraft.outputGuardDetailsMaxBytes}
                onChange={(e) => setSettingsDraft((s) => ({ ...s, outputGuardDetailsMaxBytes: e.target.value }))}
              />
            </Field>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
          <Field label={t("settings.mcp.traceEnabled")} description={t("settings.mcp.traceHint")}>
            <select
              style={inputStyle}
              disabled={readOnly}
              value={settingsDraft.traceEnabled}
              onChange={(e) => setSettingsDraft((s) => ({ ...s, traceEnabled: e.target.value as "" | "true" | "false" }))}
            >
              <option value="">{t("settings.mcp.unset")}</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </Field>
          <Field label={t("settings.mcp.traceFile")}>
            <input
              style={inputStyle}
              disabled={readOnly}
              value={settingsDraft.traceFile}
              onChange={(e) => setSettingsDraft((s) => ({ ...s, traceFile: e.target.value }))}
            />
          </Field>
          <Field label={t("settings.mcp.traceMaxBytes")}>
            <input
              style={inputStyle}
              disabled={readOnly}
              value={settingsDraft.traceMaxBytes}
              onChange={(e) => setSettingsDraft((s) => ({ ...s, traceMaxBytes: e.target.value }))}
            />
          </Field>
          <Field label={t("settings.mcp.traceMaxEvents")}>
            <input
              style={inputStyle}
              disabled={readOnly}
              value={settingsDraft.traceMaxEvents}
              onChange={(e) => setSettingsDraft((s) => ({ ...s, traceMaxEvents: e.target.value }))}
            />
          </Field>
          <Field label={t("settings.mcp.authRequiredMessage")}>
            <input
              style={inputStyle}
              disabled={readOnly}
              value={settingsDraft.authRequiredMessage}
              onChange={(e) => setSettingsDraft((s) => ({ ...s, authRequiredMessage: e.target.value }))}
            />
          </Field>
          <Field label={t("settings.mcp.oauthDir")} description={t("settings.mcp.oauthDirHint")}>
            <input
              style={inputStyle}
              disabled={readOnly}
              value={settingsDraft.oauthDir}
              onChange={(e) => setSettingsDraft((s) => ({ ...s, oauthDir: e.target.value }))}
            />
          </Field>
        </div>

        <Field label={t("settings.mcp.imports")} description={t("settings.mcp.importsHint")}>
          <textarea
            style={{ ...inputStyle, minHeight: 64, resize: "vertical", fontFamily: "var(--font-mono)" }}
            disabled={readOnly}
            value={settingsDraft.importsText}
            onChange={(e) => setSettingsDraft((s) => ({ ...s, importsText: e.target.value }))}
            placeholder={"cursor\nclaude-code"}
          />
        </Field>
      </div>

      {/* Servers */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{t("settings.mcp.servers")}</div>
          <button
            type="button"
            disabled={readOnly}
            onClick={addServer}
            style={{ padding: "6px 10px", borderRadius: 7, border: "none", background: readOnly ? "var(--border)" : "var(--accent)", color: "white", cursor: readOnly ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 700 }}
          >
            {t("settings.mcp.addServer")}
          </button>
        </div>

        {servers.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("settings.mcp.noServers")}</div>
        )}

        {servers.map((server, index) => (
          <div key={`${server.originalName}-${index}`} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, background: "var(--bg)", display: "flex", flexDirection: "column", gap: 10, opacity: readOnly ? 0.6 : 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", flex: 1 }}>
                <input
                  style={{ ...inputStyle, maxWidth: 220, fontWeight: 700 }}
                  disabled={readOnly}
                  value={server.name}
                  onChange={(e) => updateServer(index, { name: e.target.value })}
                />
                <select
                  style={{ ...inputStyle, maxWidth: 140 }}
                  disabled={readOnly}
                  value={server.transport}
                  onChange={(e) => updateServer(index, { transport: e.target.value as McpTransportKind })}
                >
                  <option value="stdio">stdio</option>
                  <option value="http">http</option>
                  <option value="socket">socket</option>
                </select>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--text-muted)" }}>
                  <input type="checkbox" disabled={readOnly} checked={server.disabled} onChange={(e) => updateServer(index, { disabled: e.target.checked })} />
                  {t("settings.mcp.disabled")}
                </label>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" onClick={() => updateServer(index, { expanded: !server.expanded })} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>
                  {server.expanded ? t("settings.mcp.collapse") : t("settings.mcp.expand")}
                </button>
                <button type="button" disabled={readOnly} onClick={() => removeServer(index)} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "#f87171", cursor: readOnly ? "not-allowed" : "pointer", fontSize: 11 }}>
                  {t("settings.mcp.delete")}
                </button>
              </div>
            </div>

            {(server.risks.hasExecutableSecret || server.env.some((e) => e.executableSecret) || server.headers.some((h) => h.executableSecret)) && (
              <div style={{ fontSize: 11, color: "#fbbf24" }}>{t("settings.mcp.executableSecretWarn")}</div>
            )}
            {(server.lifecycle === "eager" || server.lifecycle === "keep-alive" || server.lifecycle === "lazy-keep-alive") && (
              <div style={{ fontSize: 11, color: "#fbbf24" }}>{t("settings.mcp.eagerWarn")}</div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
              {server.transport === "stdio" && (
                <>
                  <Field label="command">
                    <input style={inputStyle} disabled={readOnly} value={server.command} onChange={(e) => updateServer(index, { command: e.target.value })} />
                  </Field>
                  <Field label="args" description={t("settings.mcp.onePerLine")}>
                    <textarea style={{ ...inputStyle, minHeight: 54, fontFamily: "var(--font-mono)" }} disabled={readOnly} value={server.argsText} onChange={(e) => updateServer(index, { argsText: e.target.value })} />
                  </Field>
                  <Field label="cwd">
                    <input style={inputStyle} disabled={readOnly} value={server.cwd} onChange={(e) => updateServer(index, { cwd: e.target.value })} />
                  </Field>
                </>
              )}
              {server.transport === "http" && (
                <>
                  <Field label="url">
                    <input style={inputStyle} disabled={readOnly} value={server.url} onChange={(e) => updateServer(index, { url: e.target.value, confirmUrlAuthClear: true })} />
                  </Field>
                  <Field label="auth">
                    <select style={inputStyle} disabled={readOnly} value={server.auth} onChange={(e) => updateServer(index, { auth: e.target.value as ServerDraft["auth"] })}>
                      <option value="">{t("settings.mcp.unset")}</option>
                      <option value="bearer">bearer</option>
                      <option value="oauth">oauth</option>
                      <option value="false">false</option>
                    </select>
                  </Field>
                  <Field label="bearerTokenEnv">
                    <input style={inputStyle} disabled={readOnly} value={server.bearerTokenEnv} onChange={(e) => updateServer(index, { bearerTokenEnv: e.target.value })} />
                  </Field>
                </>
              )}
              {server.transport === "socket" && (
                <Field label="socket" description={t("settings.mcp.socketHint")}>
                  <input style={inputStyle} disabled={readOnly} value={server.socket} onChange={(e) => updateServer(index, { socket: e.target.value })} />
                </Field>
              )}
              <Field label="lifecycle">
                <select style={inputStyle} disabled={readOnly} value={server.lifecycle} onChange={(e) => updateServer(index, { lifecycle: e.target.value as ServerDraft["lifecycle"] })}>
                  <option value="">{t("settings.mcp.unset")}</option>
                  <option value="lazy">lazy</option>
                  <option value="eager">eager</option>
                  <option value="keep-alive">keep-alive</option>
                  <option value="lazy-keep-alive">lazy-keep-alive</option>
                </select>
              </Field>
            </div>

            {server.expanded && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 4, borderTop: "1px dashed var(--border)" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }}>
                  <Field label="idleTimeout">
                    <input style={inputStyle} disabled={readOnly} value={server.idleTimeout} onChange={(e) => updateServer(index, { idleTimeout: e.target.value })} />
                  </Field>
                  <Field label="requestTimeoutMs">
                    <input style={inputStyle} disabled={readOnly} value={server.requestTimeoutMs} onChange={(e) => updateServer(index, { requestTimeoutMs: e.target.value })} />
                  </Field>
                  <Field label="exposeResources">
                    <select style={inputStyle} disabled={readOnly} value={server.exposeResources} onChange={(e) => updateServer(index, { exposeResources: e.target.value as ServerDraft["exposeResources"] })}>
                      <option value="">{t("settings.mcp.unset")}</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  </Field>
                  <Field label="directTools" description={t("settings.mcp.directToolsHint")}>
                    <textarea style={{ ...inputStyle, minHeight: 48, fontFamily: "var(--font-mono)" }} disabled={readOnly} value={server.directToolsText} onChange={(e) => updateServer(index, { directToolsText: e.target.value })} />
                  </Field>
                  <Field label="includeTools">
                    <textarea style={{ ...inputStyle, minHeight: 48, fontFamily: "var(--font-mono)" }} disabled={readOnly} value={server.includeToolsText} onChange={(e) => updateServer(index, { includeToolsText: e.target.value })} />
                  </Field>
                  <Field label="excludeTools">
                    <textarea style={{ ...inputStyle, minHeight: 48, fontFamily: "var(--font-mono)" }} disabled={readOnly} value={server.excludeToolsText} onChange={(e) => updateServer(index, { excludeToolsText: e.target.value })} />
                  </Field>
                </div>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--text-muted)" }}>
                    <input type="checkbox" disabled={readOnly} checked={server.debug} onChange={(e) => updateServer(index, { debug: e.target.checked })} />
                    debug
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--text-muted)" }}>
                    <input type="checkbox" disabled={readOnly} checked={server.trace} onChange={(e) => updateServer(index, { trace: e.target.checked })} />
                    trace
                  </label>
                </div>

                {server.transport === "stdio" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>env</div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("settings.mcp.secretMapHint")}</div>
                    {server.env.map((item, envIndex) => (
                      <SecretRow
                        key={`env-${envIndex}`}
                        item={item}
                        onChange={(next) => {
                          const env = [...server.env];
                          env[envIndex] = next;
                          updateServer(index, { env });
                        }}
                        onRemove={() => updateServer(index, { env: server.env.filter((_, i) => i !== envIndex) })}
                      />
                    ))}
                    <button type="button" disabled={readOnly} onClick={() => updateServer(index, { env: [...server.env, emptySecret()] })} style={{ alignSelf: "flex-start", padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: readOnly ? "not-allowed" : "pointer", fontSize: 11 }}>
                      {t("settings.mcp.addSecret")}
                    </button>
                  </div>
                )}

                {server.transport === "http" && (
                  <>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>headers</div>
                      {server.headers.map((item, headerIndex) => (
                        <SecretRow
                          key={`header-${headerIndex}`}
                          item={item}
                          onChange={(next) => {
                            const headers = [...server.headers];
                            headers[headerIndex] = next;
                            updateServer(index, { headers });
                          }}
                          onRemove={() => updateServer(index, { headers: server.headers.filter((_, i) => i !== headerIndex) })}
                        />
                      ))}
                      <button type="button" disabled={readOnly} onClick={() => updateServer(index, { headers: [...server.headers, emptySecret()] })} style={{ alignSelf: "flex-start", padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: readOnly ? "not-allowed" : "pointer", fontSize: 11 }}>
                        {t("settings.mcp.addSecret")}
                      </button>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>bearerToken</div>
                      <SecretRow item={server.bearerToken} onChange={(next) => updateServer(index, { bearerToken: next })} />
                    </div>
                    <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--text-muted)" }}>
                      <input type="checkbox" disabled={readOnly} checked={server.oauthEnabled} onChange={(e) => updateServer(index, { oauthEnabled: e.target.checked })} />
                      OAuth
                    </label>
                    {server.oauthEnabled && (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }}>
                        <Field label="grantType">
                          <select style={inputStyle} disabled={readOnly} value={server.oauthGrantType} onChange={(e) => updateServer(index, { oauthGrantType: e.target.value as ServerDraft["oauthGrantType"] })}>
                            <option value="">{t("settings.mcp.unset")}</option>
                            <option value="authorization_code">authorization_code</option>
                            <option value="client_credentials">client_credentials</option>
                          </select>
                        </Field>
                        <Field label="clientId">
                          <input style={inputStyle} disabled={readOnly} value={server.oauthClientId} onChange={(e) => updateServer(index, { oauthClientId: e.target.value })} />
                        </Field>
                        <Field label="scope">
                          <input style={inputStyle} disabled={readOnly} value={server.oauthScope} onChange={(e) => updateServer(index, { oauthScope: e.target.value })} />
                        </Field>
                        <Field label="redirectUri">
                          <input style={inputStyle} disabled={readOnly} value={server.oauthRedirectUri} onChange={(e) => updateServer(index, { oauthRedirectUri: e.target.value })} />
                        </Field>
                        <Field label="clientName">
                          <input style={inputStyle} disabled={readOnly} value={server.oauthClientName} onChange={(e) => updateServer(index, { oauthClientName: e.target.value })} />
                        </Field>
                        <Field label="clientUri">
                          <input style={inputStyle} disabled={readOnly} value={server.oauthClientUri} onChange={(e) => updateServer(index, { oauthClientUri: e.target.value })} />
                        </Field>
                        <div style={{ gridColumn: "1 / -1" }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>clientSecret</div>
                          <SecretRow item={server.oauthClientSecret} onChange={(next) => updateServer(index, { oauthClientSecret: next })} />
                        </div>
                      </div>
                    )}
                  </>
                )}

                {server.unknownFieldKeys.length > 0 && (
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                    {t("settings.mcp.unknownFields")}: {server.unknownFieldKeys.join(", ")}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Guidance */}
      <div style={{ padding: 12, borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg-subtle)", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{t("settings.mcp.activation")}</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {reloadHint || t("settings.mcp.reloadHint")}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {[
            "/reload",
            "mcp({})",
            'mcp({ connect: "server" })',
          ].map((cmd) => (
            <button
              key={cmd}
              type="button"
              onClick={() => void copyText(cmd)}
              style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, fontFamily: "var(--font-mono)" }}
            >
              {cmd}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>
          {t("settings.mcp.secretLimitation")}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>
          {t("settings.mcp.automationBoundary")}
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          onClick={handleReload}
          disabled={loading || saving}
          style={{ padding: "7px 12px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: loading || saving ? "not-allowed" : "pointer", fontSize: 12 }}
        >
          {t("settings.mcp.reload")}
        </button>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {dirty && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("settings.unsavedChanges")}</span>}
          <button
            type="button"
            disabled={!dirty || saving || loading || readOnly || !revision}
            onClick={() => void handleSave()}
            style={{
              padding: "7px 14px",
              borderRadius: 7,
              border: "none",
              background: !dirty || saving || loading || readOnly || !revision ? "var(--border)" : "var(--accent)",
              color: "white",
              cursor: !dirty || saving || loading || readOnly || !revision ? "not-allowed" : "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {saving ? t("settings.saving") : t("settings.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
