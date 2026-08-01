"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppDialog } from "@/components/AppDialogProvider";
import { useI18n } from "@/components/I18nProvider";
import {
  SettingsActionRow,
  SettingsBadge,
  SettingsButton,
  SettingsField,
  SettingsInput,
  SettingsNotice,
  SettingsSection,
  SettingsSectionHeader,
  SettingsSelect,
  SettingsState,
  SettingsTextarea,
} from "@/components/ui/SettingsPrimitives";

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
    <div className="mcp-secret-row">
      <SettingsInput
        value={item.key}
        placeholder={label ?? t("settings.mcp.secretKey")}
        aria-label={label ?? t("settings.mcp.secretKey")}
        onChange={(event) => onChange({ ...item, key: event.target.value })}
      />
      <SettingsSelect
        value={item.mode}
        aria-label={t("settings.mcp.secretMode")}
        onChange={(event) => onChange({ ...item, mode: event.target.value as SecretMode })}
      >
        <option value="preserve">{t("settings.mcp.secretPreserve")}{item.configured ? ` · ${t("settings.mcp.secretConfigured")}` : ""}</option>
        <option value="replace">{t("settings.mcp.secretReplace")}</option>
        <option value="clear">{t("settings.mcp.secretClear")}</option>
      </SettingsSelect>
      <SettingsInput
        type="password"
        autoComplete="new-password"
        disabled={item.mode !== "replace"}
        value={item.mode === "replace" ? item.value : ""}
        placeholder={item.configured ? "••••••••" : t("settings.mcp.secretValue")}
        aria-label={t("settings.mcp.secretValue")}
        onChange={(event) => onChange({ ...item, value: event.target.value })}
      />
      {onRemove ? (
        <SettingsButton type="button" size="icon" variant="ghost" onClick={onRemove} aria-label={t("settings.mcp.removeSecret")}>
          ×
        </SettingsButton>
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
    return <SettingsState kind="loading" title={t("settings.mcp.loading")} />;
  }

  return (
    <SettingsSection className="mcp-config">
      <SettingsSectionHeader
        title={t("settings.mcp.title")}
        description={t("settings.mcp.description")}
        meta={selected ? <><span>{t("settings.mcp.editingPath")}: </span><code className="settings-inline-code">{selected.displayPath || selected.path}</code>{selected.exists ? null : ` (${t("settings.mcp.willCreate")})`}</> : undefined}
      />

      {error && (
        <SettingsNotice tone="danger">
          <div>{error}</div>
          {conflict && (
            <div className="settings-action-group">
              <SettingsButton size="sm" onClick={handleReload}>{t("settings.mcp.reloadDisk")}</SettingsButton>
              <SettingsButton size="sm" variant="primary" onClick={() => void handleReapply()}>{t("settings.mcp.reapply")}</SettingsButton>
            </div>
          )}
        </SettingsNotice>
      )}
      {notice && <SettingsNotice tone="success">{notice}</SettingsNotice>}

      <div className="settings-surface">
        <div className="settings-surface-title">{t("settings.mcp.adapterStatus")}</div>
        <SettingsNotice tone={adapter?.configured ? "success" : "warning"}>
          {adapter?.configured
            ? t("settings.mcp.adapterConfigured", { version: adapter.version ?? t("settings.mcp.versionUnknown") })
            : t("settings.mcp.adapterMissing")}
        </SettingsNotice>
        {adapter?.diagnostic && <div className="mcp-guidance-detail">{adapter.diagnostic}</div>}
        {!adapter?.configured && (
          <div className="settings-action-group">
            <code className="settings-inline-code">{adapter?.installCommand}</code>
            <SettingsButton size="sm" onClick={() => void copyText(adapter?.installCommand ?? "pi install npm:pi-mcp-adapter")}>{t("settings.mcp.copy")}</SettingsButton>
          </div>
        )}
        <div className="mcp-guidance-detail">{t("settings.mcp.runtimeUnknown")}</div>
      </div>

      <div className="settings-surface">
        <div className="settings-surface-title">{t("settings.mcp.target")}</div>
        <div className="mcp-target-tabs" role="group" aria-label={t("settings.mcp.target")}>
          {TARGETS.map((target) => {
            const disabled = target.scope === "project" && !cwd;
            const active = target.id === targetId;
            return (
              <SettingsButton
                key={target.id}
                size="sm"
                disabled={disabled}
                aria-pressed={active}
                className={active ? "mcp-target-tab-active" : undefined}
                onClick={() => void requestTargetChange(target.id)}
              >
                {t(target.labelKey)}
              </SettingsButton>
            );
          })}
        </div>
      </div>

      <div className="settings-surface">
        <div className="settings-surface-title">{t("settings.mcp.sources")}</div>
        <div className="mcp-source-list">
          {sources.map((source) => (
            <div key={source.id} className={`mcp-source-row${source.id === targetId ? " mcp-source-row-active" : ""}`}>
              <div className="mcp-source-header">
                <span className="mcp-source-title">#{source.precedence} {source.label}</span>
                <div className="settings-action-group">
                  <SettingsBadge tone={source.exists ? "success" : "neutral"}>{source.exists ? t("settings.mcp.exists") : t("settings.mcp.missing")}</SettingsBadge>
                  <SettingsBadge>{source.serverCount} {t("settings.mcp.serversCount")}</SettingsBadge>
                  <SettingsBadge tone={source.writable ? "accent" : "warning"}>{source.writable ? t("settings.mcp.writable") : t("settings.mcp.readOnly")}</SettingsBadge>
                </div>
              </div>
              <code className="mcp-source-path">{source.displayPath || source.path}</code>
              {source.parseError && <SettingsNotice tone="danger">{source.parseError}</SettingsNotice>}
            </div>
          ))}
        </div>
      </div>

      {parseError && <SettingsNotice tone="danger">{t("settings.mcp.parseErrorLock")}: {parseError}</SettingsNotice>}

      <div className="settings-surface" aria-disabled={readOnly}>
        <div className="settings-surface-title">{t("settings.mcp.globalSettings")}</div>
        <div className="mcp-form-grid mcp-form-grid-compact">
          <SettingsField label={t("settings.mcp.toolPrefix")}>
            <SettingsSelect disabled={readOnly} value={settingsDraft.toolPrefix} onChange={(event) => setSettingsDraft((current) => ({ ...current, toolPrefix: event.target.value as SettingsDraft["toolPrefix"] }))}>
              <option value="">{t("settings.mcp.unset")}</option><option value="server">server</option><option value="short">short</option><option value="none">none</option><option value="mcp">mcp</option>
            </SettingsSelect>
          </SettingsField>
          <SettingsField label={t("settings.mcp.hostDiscovery")} description={t("settings.mcp.hostDiscoveryHint")}>
            <SettingsSelect disabled={readOnly} value={settingsDraft.hostConfigDiscovery} onChange={(event) => setSettingsDraft((current) => ({ ...current, hostConfigDiscovery: event.target.value as SettingsDraft["hostConfigDiscovery"] }))}>
              <option value="">{t("settings.mcp.unset")}</option><option value="off">off</option><option value="prompt">prompt</option><option value="on">on</option>
            </SettingsSelect>
          </SettingsField>
          <SettingsField label={t("settings.mcp.idleTimeout")}><SettingsInput disabled={readOnly} value={settingsDraft.idleTimeout} onChange={(event) => setSettingsDraft((current) => ({ ...current, idleTimeout: event.target.value }))} /></SettingsField>
          <SettingsField label={t("settings.mcp.requestTimeoutMs")}><SettingsInput disabled={readOnly} value={settingsDraft.requestTimeoutMs} onChange={(event) => setSettingsDraft((current) => ({ ...current, requestTimeoutMs: event.target.value }))} /></SettingsField>
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
            <SettingsField key={key} label={t(labelKey)} description={hintKey ? t(hintKey) : undefined}>
              <SettingsSelect disabled={readOnly} value={settingsDraft[key]} onChange={(event) => setSettingsDraft((current) => ({ ...current, [key]: event.target.value as "" | "true" | "false" }))}>
                <option value="">{t("settings.mcp.unset")}</option><option value="true">true</option><option value="false">false</option>
              </SettingsSelect>
            </SettingsField>
          ))}
        </div>

        {settingsDraft.outputGuard === "true" && (
          <div className="mcp-form-grid mcp-form-grid-compact">
            <SettingsField label={t("settings.mcp.outputGuardMaxBytes")} description={t("settings.mcp.outputGuardLimitsHint")}><SettingsInput disabled={readOnly} value={settingsDraft.outputGuardMaxBytes} onChange={(event) => setSettingsDraft((current) => ({ ...current, outputGuardMaxBytes: event.target.value }))} /></SettingsField>
            <SettingsField label={t("settings.mcp.outputGuardMaxLines")}><SettingsInput disabled={readOnly} value={settingsDraft.outputGuardMaxLines} onChange={(event) => setSettingsDraft((current) => ({ ...current, outputGuardMaxLines: event.target.value }))} /></SettingsField>
            <SettingsField label={t("settings.mcp.outputGuardDetailsMaxBytes")}><SettingsInput disabled={readOnly} value={settingsDraft.outputGuardDetailsMaxBytes} onChange={(event) => setSettingsDraft((current) => ({ ...current, outputGuardDetailsMaxBytes: event.target.value }))} /></SettingsField>
          </div>
        )}

        <div className="mcp-form-grid mcp-form-grid-compact">
          <SettingsField label={t("settings.mcp.traceEnabled")} description={t("settings.mcp.traceHint")}>
            <SettingsSelect disabled={readOnly} value={settingsDraft.traceEnabled} onChange={(event) => setSettingsDraft((current) => ({ ...current, traceEnabled: event.target.value as "" | "true" | "false" }))}>
              <option value="">{t("settings.mcp.unset")}</option><option value="true">true</option><option value="false">false</option>
            </SettingsSelect>
          </SettingsField>
          <SettingsField label={t("settings.mcp.traceFile")}><SettingsInput disabled={readOnly} value={settingsDraft.traceFile} onChange={(event) => setSettingsDraft((current) => ({ ...current, traceFile: event.target.value }))} /></SettingsField>
          <SettingsField label={t("settings.mcp.traceMaxBytes")}><SettingsInput disabled={readOnly} value={settingsDraft.traceMaxBytes} onChange={(event) => setSettingsDraft((current) => ({ ...current, traceMaxBytes: event.target.value }))} /></SettingsField>
          <SettingsField label={t("settings.mcp.traceMaxEvents")}><SettingsInput disabled={readOnly} value={settingsDraft.traceMaxEvents} onChange={(event) => setSettingsDraft((current) => ({ ...current, traceMaxEvents: event.target.value }))} /></SettingsField>
          <SettingsField label={t("settings.mcp.authRequiredMessage")}><SettingsInput disabled={readOnly} value={settingsDraft.authRequiredMessage} onChange={(event) => setSettingsDraft((current) => ({ ...current, authRequiredMessage: event.target.value }))} /></SettingsField>
          <SettingsField label={t("settings.mcp.oauthDir")} description={t("settings.mcp.oauthDirHint")}><SettingsInput disabled={readOnly} value={settingsDraft.oauthDir} onChange={(event) => setSettingsDraft((current) => ({ ...current, oauthDir: event.target.value }))} /></SettingsField>
        </div>
        <SettingsField label={t("settings.mcp.imports")} description={t("settings.mcp.importsHint")}>
          <SettingsTextarea className="settings-control-mono" disabled={readOnly} value={settingsDraft.importsText} onChange={(event) => setSettingsDraft((current) => ({ ...current, importsText: event.target.value }))} placeholder={"cursor\nclaude-code"} rows={3} />
        </SettingsField>
      </div>

      <div className="settings-surface">
        <SettingsActionRow>
          <div className="settings-surface-title">{t("settings.mcp.servers")}</div>
          <SettingsButton variant="primary" size="sm" disabled={readOnly} onClick={addServer}>{t("settings.mcp.addServer")}</SettingsButton>
        </SettingsActionRow>
        {servers.length === 0 ? (
          <SettingsState title={t("settings.mcp.noServers")} />
        ) : (
          <div className="mcp-server-list">
            {servers.map((server, index) => (
              <div key={`${server.originalName}-${index}`} className={`mcp-server-card${readOnly ? " mcp-server-card-readonly" : ""}`}>
                <div className="mcp-server-header">
                  <div className="mcp-server-identity">
                    <SettingsInput className="mcp-server-name settings-control-mono" disabled={readOnly} value={server.name} aria-label={t("settings.mcp.serverName")} onChange={(event) => updateServer(index, { name: event.target.value })} />
                    <SettingsSelect className="mcp-transport-select" disabled={readOnly} value={server.transport} aria-label={t("settings.mcp.transport")} onChange={(event) => updateServer(index, { transport: event.target.value as McpTransportKind })}>
                      <option value="stdio">stdio</option><option value="http">http</option><option value="socket">socket</option>
                    </SettingsSelect>
                    <label className="mcp-checkbox"><input type="checkbox" disabled={readOnly} checked={server.disabled} onChange={(event) => updateServer(index, { disabled: event.target.checked })} />{t("settings.mcp.disabled")}</label>
                  </div>
                  <div className="mcp-server-actions">
                    <SettingsButton size="sm" onClick={() => updateServer(index, { expanded: !server.expanded })}>{server.expanded ? t("settings.mcp.collapse") : t("settings.mcp.expand")}</SettingsButton>
                    <SettingsButton size="sm" variant="danger" disabled={readOnly} onClick={() => removeServer(index)}>{t("settings.mcp.delete")}</SettingsButton>
                  </div>
                </div>

                {(server.risks.hasExecutableSecret || server.env.some((entry) => entry.executableSecret) || server.headers.some((entry) => entry.executableSecret)) && <SettingsNotice tone="warning">{t("settings.mcp.executableSecretWarn")}</SettingsNotice>}
                {(server.lifecycle === "eager" || server.lifecycle === "keep-alive" || server.lifecycle === "lazy-keep-alive") && <SettingsNotice tone="warning">{t("settings.mcp.eagerWarn")}</SettingsNotice>}

                <div className="mcp-form-grid">
                  {server.transport === "stdio" && <>
                    <SettingsField label="command"><SettingsInput className="settings-control-mono" disabled={readOnly} value={server.command} onChange={(event) => updateServer(index, { command: event.target.value })} /></SettingsField>
                    <SettingsField label="args" description={t("settings.mcp.onePerLine")}><SettingsTextarea className="settings-control-mono" disabled={readOnly} value={server.argsText} onChange={(event) => updateServer(index, { argsText: event.target.value })} rows={2} /></SettingsField>
                    <SettingsField label="cwd"><SettingsInput className="settings-control-mono" disabled={readOnly} value={server.cwd} onChange={(event) => updateServer(index, { cwd: event.target.value })} /></SettingsField>
                  </>}
                  {server.transport === "http" && <>
                    <SettingsField label="url"><SettingsInput className="settings-control-mono" disabled={readOnly} value={server.url} onChange={(event) => updateServer(index, { url: event.target.value, confirmUrlAuthClear: true })} /></SettingsField>
                    <SettingsField label="auth"><SettingsSelect disabled={readOnly} value={server.auth} onChange={(event) => updateServer(index, { auth: event.target.value as ServerDraft["auth"] })}><option value="">{t("settings.mcp.unset")}</option><option value="bearer">bearer</option><option value="oauth">oauth</option><option value="false">false</option></SettingsSelect></SettingsField>
                    <SettingsField label="bearerTokenEnv"><SettingsInput className="settings-control-mono" disabled={readOnly} value={server.bearerTokenEnv} onChange={(event) => updateServer(index, { bearerTokenEnv: event.target.value })} /></SettingsField>
                  </>}
                  {server.transport === "socket" && <SettingsField label="socket" description={t("settings.mcp.socketHint")}><SettingsInput className="settings-control-mono" disabled={readOnly} value={server.socket} onChange={(event) => updateServer(index, { socket: event.target.value })} /></SettingsField>}
                  <SettingsField label="lifecycle"><SettingsSelect disabled={readOnly} value={server.lifecycle} onChange={(event) => updateServer(index, { lifecycle: event.target.value as ServerDraft["lifecycle"] })}><option value="">{t("settings.mcp.unset")}</option><option value="lazy">lazy</option><option value="eager">eager</option><option value="keep-alive">keep-alive</option><option value="lazy-keep-alive">lazy-keep-alive</option></SettingsSelect></SettingsField>
                </div>

                {server.expanded && (
                  <div className="mcp-advanced">
                    <div className="mcp-form-grid mcp-form-grid-compact">
                      <SettingsField label="idleTimeout"><SettingsInput disabled={readOnly} value={server.idleTimeout} onChange={(event) => updateServer(index, { idleTimeout: event.target.value })} /></SettingsField>
                      <SettingsField label="requestTimeoutMs"><SettingsInput disabled={readOnly} value={server.requestTimeoutMs} onChange={(event) => updateServer(index, { requestTimeoutMs: event.target.value })} /></SettingsField>
                      <SettingsField label="exposeResources"><SettingsSelect disabled={readOnly} value={server.exposeResources} onChange={(event) => updateServer(index, { exposeResources: event.target.value as ServerDraft["exposeResources"] })}><option value="">{t("settings.mcp.unset")}</option><option value="true">true</option><option value="false">false</option></SettingsSelect></SettingsField>
                      <SettingsField label="directTools" description={t("settings.mcp.directToolsHint")}><SettingsTextarea className="settings-control-mono" disabled={readOnly} value={server.directToolsText} onChange={(event) => updateServer(index, { directToolsText: event.target.value })} rows={2} /></SettingsField>
                      <SettingsField label="includeTools"><SettingsTextarea className="settings-control-mono" disabled={readOnly} value={server.includeToolsText} onChange={(event) => updateServer(index, { includeToolsText: event.target.value })} rows={2} /></SettingsField>
                      <SettingsField label="excludeTools"><SettingsTextarea className="settings-control-mono" disabled={readOnly} value={server.excludeToolsText} onChange={(event) => updateServer(index, { excludeToolsText: event.target.value })} rows={2} /></SettingsField>
                    </div>
                    <div className="mcp-checkbox-group">
                      <label className="mcp-checkbox"><input type="checkbox" disabled={readOnly} checked={server.debug} onChange={(event) => updateServer(index, { debug: event.target.checked })} />debug</label>
                      <label className="mcp-checkbox"><input type="checkbox" disabled={readOnly} checked={server.trace} onChange={(event) => updateServer(index, { trace: event.target.checked })} />trace</label>
                    </div>

                    {server.transport === "stdio" && (
                      <div className="mcp-secret-section">
                        <div className="mcp-secret-title">env</div>
                        <div className="mcp-guidance-detail">{t("settings.mcp.secretMapHint")}</div>
                        {server.env.map((item, envIndex) => <SecretRow key={`env-${envIndex}`} item={item} onChange={(next) => { const env = [...server.env]; env[envIndex] = next; updateServer(index, { env }); }} onRemove={() => updateServer(index, { env: server.env.filter((_, itemIndex) => itemIndex !== envIndex) })} />)}
                        <SettingsButton className="settings-align-start" size="sm" disabled={readOnly} onClick={() => updateServer(index, { env: [...server.env, emptySecret()] })}>{t("settings.mcp.addSecret")}</SettingsButton>
                      </div>
                    )}

                    {server.transport === "http" && <>
                      <div className="mcp-secret-section">
                        <div className="mcp-secret-title">headers</div>
                        <div className="mcp-guidance-detail">{t("settings.mcp.secretMapHint")}</div>
                        {server.headers.map((item, headerIndex) => <SecretRow key={`header-${headerIndex}`} item={item} onChange={(next) => { const headers = [...server.headers]; headers[headerIndex] = next; updateServer(index, { headers }); }} onRemove={() => updateServer(index, { headers: server.headers.filter((_, itemIndex) => itemIndex !== headerIndex) })} />)}
                        <SettingsButton className="settings-align-start" size="sm" disabled={readOnly} onClick={() => updateServer(index, { headers: [...server.headers, emptySecret()] })}>{t("settings.mcp.addSecret")}</SettingsButton>
                      </div>
                      <div className="mcp-secret-section"><div className="mcp-secret-title">bearerToken</div><SecretRow item={server.bearerToken} onChange={(next) => updateServer(index, { bearerToken: next })} /></div>
                      <label className="mcp-checkbox"><input type="checkbox" disabled={readOnly} checked={server.oauthEnabled} onChange={(event) => updateServer(index, { oauthEnabled: event.target.checked })} />OAuth</label>
                      {server.oauthEnabled && (
                        <div className="mcp-form-grid mcp-form-grid-compact">
                          <SettingsField label="grantType"><SettingsSelect disabled={readOnly} value={server.oauthGrantType} onChange={(event) => updateServer(index, { oauthGrantType: event.target.value as ServerDraft["oauthGrantType"] })}><option value="">{t("settings.mcp.unset")}</option><option value="authorization_code">authorization_code</option><option value="client_credentials">client_credentials</option></SettingsSelect></SettingsField>
                          <SettingsField label="clientId"><SettingsInput disabled={readOnly} value={server.oauthClientId} onChange={(event) => updateServer(index, { oauthClientId: event.target.value })} /></SettingsField>
                          <SettingsField label="scope"><SettingsInput disabled={readOnly} value={server.oauthScope} onChange={(event) => updateServer(index, { oauthScope: event.target.value })} /></SettingsField>
                          <SettingsField label="redirectUri"><SettingsInput disabled={readOnly} value={server.oauthRedirectUri} onChange={(event) => updateServer(index, { oauthRedirectUri: event.target.value })} /></SettingsField>
                          <SettingsField label="clientName"><SettingsInput disabled={readOnly} value={server.oauthClientName} onChange={(event) => updateServer(index, { oauthClientName: event.target.value })} /></SettingsField>
                          <SettingsField label="clientUri"><SettingsInput disabled={readOnly} value={server.oauthClientUri} onChange={(event) => updateServer(index, { oauthClientUri: event.target.value })} /></SettingsField>
                          <div className="mcp-secret-section"><div className="mcp-secret-title">clientSecret</div><SecretRow item={server.oauthClientSecret} onChange={(next) => updateServer(index, { oauthClientSecret: next })} /></div>
                        </div>
                      )}
                    </>}
                    {server.unknownFieldKeys.length > 0 && <SettingsNotice tone="info">{t("settings.mcp.unknownFields")}: {server.unknownFieldKeys.join(", ")}</SettingsNotice>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-surface">
        <div className="settings-surface-title">{t("settings.mcp.activation")}</div>
        <div className="mcp-guidance-copy">{reloadHint || t("settings.mcp.reloadHint")}</div>
        <div className="mcp-command-list">
          {["/reload", "mcp({})", 'mcp({ connect: "server" })'].map((command) => <SettingsButton key={command} size="sm" className="settings-control-mono" onClick={() => void copyText(command)}>{command}</SettingsButton>)}
        </div>
        <div className="mcp-guidance-detail">{t("settings.mcp.secretLimitation")}</div>
        <div className="mcp-guidance-detail">{t("settings.mcp.automationBoundary")}</div>
      </div>

      <SettingsActionRow>
        <SettingsButton onClick={handleReload} disabled={loading || saving}>{t("settings.mcp.reload")}</SettingsButton>
        <div className="settings-action-group">
          {dirty && <span className="settings-dirty-note">{t("settings.unsavedChanges")}</span>}
          <SettingsButton variant="primary" busy={saving} disabled={!dirty || loading || readOnly || !revision} onClick={() => void handleSave()}>{saving ? t("settings.saving") : t("settings.save")}</SettingsButton>
        </div>
      </SettingsActionRow>
    </SettingsSection>
  );
}
