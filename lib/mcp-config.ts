/**
 * Safe MCP configuration domain for adapter-native files.
 * Reads/writes pi-mcp-adapter config without loading the adapter or executing secrets.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse as parseJsonc,
  parseTree,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import { getAllowedRoots, isPathAllowed, isRegisteredAllowedRoot } from "./allowed-roots";
import { canonicalizeCwd, existingCanonicalCwd } from "./cwd";

// ---------------------------------------------------------------------------
// Fixed targets / sources
// ---------------------------------------------------------------------------

export type McpWritableTargetId =
  | "user-shared"
  | "user-pi"
  | "project-shared"
  | "project-pi";

export type McpSourceId =
  | McpWritableTargetId
  | "agents-global"
  | "agents-nested-global";

export type McpScope = "user" | "project";
export type McpTargetKind = "shared" | "pi";

export type McpErrorCode =
  | "INVALID_TARGET"
  | "INVALID_SCOPE"
  | "UNAUTHORIZED_CWD"
  | "MISSING_CWD"
  | "PARSE_ERROR"
  | "VALIDATION_ERROR"
  | "REVISION_CONFLICT"
  | "UNKNOWN_OPERATION"
  | "IO_ERROR";

export class McpConfigError extends Error {
  readonly code: McpErrorCode;
  readonly status: number;
  readonly fieldPath?: string;

  constructor(code: McpErrorCode, message: string, status = 400, fieldPath?: string) {
    super(message);
    this.name = "McpConfigError";
    this.code = code;
    this.status = status;
    this.fieldPath = fieldPath;
  }
}

// ---------------------------------------------------------------------------
// Wire types (adapter 2.15.0 public docs; unknown fields preserved on disk)
// ---------------------------------------------------------------------------

export type McpLifecycle = "lazy" | "eager" | "keep-alive" | "lazy-keep-alive";
export type McpAuthMode = "oauth" | "bearer" | false;
export type McpToolPrefix = "server" | "none" | "short" | "mcp";
export type McpHostConfigDiscovery = "off" | "prompt" | "on";
export type McpImportKind =
  | "cursor"
  | "claude-code"
  | "claude-desktop"
  | "codex"
  | "opencode"
  | "windsurf"
  | "vscode";
export type McpOAuthGrantType = "authorization_code" | "client_credentials";
export type McpTransportKind = "stdio" | "http" | "socket";

export type McpSecretOp =
  | { op: "preserve" }
  | { op: "replace"; value: string }
  | { op: "clear" };

export interface McpSecretProjection {
  key: string;
  configured: boolean;
  /** True when the on-disk value starts with a single `!` (executable secret). */
  executableSecret?: boolean;
}

export interface McpOAuthProjection {
  grantType?: McpOAuthGrantType;
  clientId?: string;
  scope?: string;
  redirectUri?: string;
  clientName?: string;
  clientUri?: string;
  clientSecret?: McpSecretProjection;
  /** oauth object explicitly set to false */
  disabled?: boolean;
}

export interface McpServerProjection {
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
  /** Non-secret risk markers for UI warnings. */
  risks: {
    hasExecutableSecret: boolean;
    eagerOrKeepAlive: boolean;
  };
  /** Unknown server fields retained on disk (keys only). */
  unknownFieldKeys: string[];
}

export interface McpOutputGuardProjection {
  maxBytes?: number;
  maxLines?: number;
  detailsMaxBytes?: number;
}

export interface McpTraceProjection {
  enabled?: boolean;
  file?: string;
  maxBytes?: number;
  maxEvents?: number;
}

export interface McpSettingsProjection {
  toolPrefix?: McpToolPrefix;
  showStatusIcon?: boolean;
  hostConfigDiscovery?: McpHostConfigDiscovery;
  idleTimeout?: number;
  requestTimeoutMs?: number;
  directTools?: boolean;
  disableProxyTool?: boolean;
  autoAuth?: boolean;
  sampling?: boolean;
  samplingAutoApprove?: boolean;
  elicitation?: boolean;
  outputGuard?: boolean | McpOutputGuardProjection;
  trace?: McpTraceProjection;
  authRequiredMessage?: string;
  oauthDir?: string;
  unknownFieldKeys: string[];
}

export interface McpConfigProjection {
  servers: McpServerProjection[];
  imports?: McpImportKind[];
  settings?: McpSettingsProjection;
  unknownRootKeys: string[];
}

export interface McpSourceSummary {
  id: McpSourceId;
  label: string;
  path: string;
  displayPath: string;
  scope: McpScope | "agents";
  kind: "shared" | "pi" | "agents";
  precedence: number;
  exists: boolean;
  writable: boolean;
  parseState: "missing" | "valid" | "parse-error";
  serverCount: number;
  parseError?: string;
}

export interface McpAdapterPackageStatus {
  configured: boolean;
  sources: Array<{ source: string; scope: "user" | "project"; filtered: boolean }>;
  version?: string;
  versionUnknown: boolean;
  diagnostic?: string;
  installCommand: string;
}

export interface McpTargetFileState {
  targetId: McpWritableTargetId;
  path: string;
  displayPath: string;
  exists: boolean;
  revision: string;
  parseError?: string;
  projection: McpConfigProjection;
}

export interface McpConfigSnapshot {
  scope: McpScope;
  targetId: McpWritableTargetId;
  cwd?: string;
  adapter: McpAdapterPackageStatus;
  sources: McpSourceSummary[];
  selected: McpTargetFileState;
  reloadRequiredHint: string;
}

// ---------------------------------------------------------------------------
// Mutation types
// ---------------------------------------------------------------------------

export interface McpOAuthMutation {
  grantType?: McpOAuthGrantType | null;
  clientId?: string | null;
  scope?: string | null;
  redirectUri?: string | null;
  clientName?: string | null;
  clientUri?: string | null;
  clientSecret?: McpSecretOp;
  /** Set oauth to false, or null to remove the field. */
  disabled?: boolean | null;
}

export interface McpServerMutation {
  /** Required when creating; ignored for transport validation when only partial update. */
  transport?: McpTransportKind;
  command?: string | null;
  args?: string[] | null;
  socket?: string | null;
  cwd?: string | null;
  url?: string | null;
  auth?: McpAuthMode | null;
  bearerTokenEnv?: string | null;
  oauth?: McpOAuthMutation | null;
  lifecycle?: McpLifecycle | null;
  idleTimeout?: number | null;
  requestTimeoutMs?: number | null;
  exposeResources?: boolean | null;
  directTools?: boolean | string[] | null;
  includeTools?: string[] | null;
  excludeTools?: string[] | null;
  debug?: boolean | null;
  trace?: boolean | null;
  disabled?: boolean | null;
  env?: Record<string, McpSecretOp>;
  headers?: Record<string, McpSecretOp>;
  bearerToken?: McpSecretOp;
  /**
   * When true, accept URL change without re-supplying auth (auth will be cleared
   * for URL-bound fields matching adapter merge semantics).
   */
  confirmUrlAuthClear?: boolean;
}

export interface McpSettingsMutation {
  toolPrefix?: McpToolPrefix | null;
  showStatusIcon?: boolean | null;
  hostConfigDiscovery?: McpHostConfigDiscovery | null;
  idleTimeout?: number | null;
  requestTimeoutMs?: number | null;
  directTools?: boolean | null;
  disableProxyTool?: boolean | null;
  autoAuth?: boolean | null;
  sampling?: boolean | null;
  samplingAutoApprove?: boolean | null;
  elicitation?: boolean | null;
  outputGuard?: boolean | McpOutputGuardProjection | null;
  trace?: McpTraceProjection | null;
  authRequiredMessage?: string | null;
  oauthDir?: string | null;
}

export type McpConfigOperation =
  | { op: "upsertServer"; name: string; server: McpServerMutation }
  | { op: "deleteServer"; name: string }
  | { op: "renameServer"; from: string; to: string }
  | { op: "setSettings"; settings: McpSettingsMutation | null }
  | { op: "setImports"; imports: McpImportKind[] | null };

export interface McpConfigWriteInput {
  targetId: McpWritableTargetId;
  cwd?: string | null;
  expectedRevision: string;
  operations: McpConfigOperation[];
  /** Optional overrides for tests. */
  agentDir?: string;
  homeDir?: string;
}

export interface McpConfigWriteResult {
  selected: McpTargetFileState;
  reloadRequired: true;
  sources: McpSourceSummary[];
  adapter: McpAdapterPackageStatus;
}

export interface McpPathOptions {
  cwd?: string | null;
  agentDir?: string;
  homeDir?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KNOWN_SERVER_FIELDS = new Set([
  "command",
  "args",
  "socket",
  "env",
  "cwd",
  "url",
  "headers",
  "auth",
  "bearerToken",
  "bearerTokenEnv",
  "oauth",
  "lifecycle",
  "idleTimeout",
  "requestTimeoutMs",
  "exposeResources",
  "directTools",
  "includeTools",
  "excludeTools",
  "debug",
  "trace",
  "disabled",
]);

const KNOWN_SETTINGS_FIELDS = new Set([
  "toolPrefix",
  "showStatusIcon",
  "hostConfigDiscovery",
  "idleTimeout",
  "requestTimeoutMs",
  "directTools",
  "disableProxyTool",
  "autoAuth",
  "sampling",
  "samplingAutoApprove",
  "elicitation",
  "outputGuard",
  "trace",
  "authRequiredMessage",
  "oauthDir",
]);

const KNOWN_ROOT_FIELDS = new Set(["mcpServers", "mcp-servers", "imports", "settings"]);

/** Allowed keys on mutation payloads (strict allowlist; disk may still hold unknowns). */
const SERVER_MUTATION_FIELDS = new Set([
  "transport",
  "command",
  "args",
  "socket",
  "cwd",
  "url",
  "auth",
  "bearerTokenEnv",
  "oauth",
  "lifecycle",
  "idleTimeout",
  "requestTimeoutMs",
  "exposeResources",
  "directTools",
  "includeTools",
  "excludeTools",
  "debug",
  "trace",
  "disabled",
  "env",
  "headers",
  "bearerToken",
  "confirmUrlAuthClear",
]);

const SETTINGS_MUTATION_FIELDS = new Set([
  "toolPrefix",
  "showStatusIcon",
  "hostConfigDiscovery",
  "idleTimeout",
  "requestTimeoutMs",
  "directTools",
  "disableProxyTool",
  "autoAuth",
  "sampling",
  "samplingAutoApprove",
  "elicitation",
  "outputGuard",
  "trace",
  "authRequiredMessage",
  "oauthDir",
]);

const OAUTH_MUTATION_FIELDS = new Set([
  "grantType",
  "clientId",
  "scope",
  "redirectUri",
  "clientName",
  "clientUri",
  "clientSecret",
  "disabled",
]);

const OUTPUT_GUARD_MUTATION_FIELDS = new Set(["maxBytes", "maxLines", "detailsMaxBytes"]);
const TRACE_MUTATION_FIELDS = new Set(["enabled", "file", "maxBytes", "maxEvents"]);
const SECRET_OP_FIELDS = new Set(["op", "value"]);

// Map lookup is own-key-safe: prototype names like __proto__/constructor/toString
// must not resolve as known operations.
const OPERATION_FIELDS_BY_OP = new Map<string, ReadonlySet<string>>([
  ["upsertServer", new Set(["op", "name", "server"])],
  ["deleteServer", new Set(["op", "name"])],
  ["renameServer", new Set(["op", "from", "to"])],
  ["setSettings", new Set(["op", "settings"])],
  ["setImports", new Set(["op", "imports"])],
]);

const LIFECYCLES = new Set<McpLifecycle>(["lazy", "eager", "keep-alive", "lazy-keep-alive"]);
const TOOL_PREFIXES = new Set<McpToolPrefix>(["server", "none", "short", "mcp"]);
const HOST_DISCOVERY = new Set<McpHostConfigDiscovery>(["off", "prompt", "on"]);
const IMPORT_KINDS = new Set<McpImportKind>([
  "cursor",
  "claude-code",
  "claude-desktop",
  "codex",
  "opencode",
  "windsurf",
  "vscode",
]);
const OAUTH_GRANTS = new Set<McpOAuthGrantType>(["authorization_code", "client_credentials"]);

const SERVER_NAME_RE = /^[\w.@/-]+$/;
const MCP_ADAPTER_SOURCE_RE = /(^|[/\\@:])pi-mcp-adapter($|[/\\@:])/i;
const INSTALL_COMMAND = "pi install npm:pi-mcp-adapter";

const EMPTY_PROJECTION: McpConfigProjection = {
  servers: [],
  unknownRootKeys: [],
};

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolveHome(homeDir?: string): string {
  return homeDir ?? homedir();
}

/**
 * Mirror Pi getAgentDir() without importing the SDK package so config reads stay
 * free of package side effects and smoke runners do not need full SDK ESM load.
 */
function resolveAgentDir(agentDir?: string): string {
  if (agentDir) return agentDir;
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir && envDir.trim()) {
    const trimmed = envDir.trim();
    if (trimmed === "~") return resolveHome();
    if (trimmed.startsWith("~/")) return join(resolveHome(), trimmed.slice(2));
    return trimmed;
  }
  return join(resolveHome(), ".pi", "agent");
}

export function getMcpTargetPath(
  targetId: McpWritableTargetId,
  options: McpPathOptions = {},
): string {
  const home = resolveHome(options.homeDir);
  const agentDir = resolveAgentDir(options.agentDir);

  switch (targetId) {
    case "user-shared":
      return join(home, ".config", "mcp", "mcp.json");
    case "user-pi":
      return join(agentDir, "mcp.json");
    case "project-shared": {
      const cwd = options.cwd ? canonicalizeCwd(options.cwd) : null;
      if (!cwd) {
        throw new McpConfigError("MISSING_CWD", "Project targets require a workspace cwd", 400);
      }
      return join(cwd, ".mcp.json");
    }
    case "project-pi": {
      const cwd = options.cwd ? canonicalizeCwd(options.cwd) : null;
      if (!cwd) {
        throw new McpConfigError("MISSING_CWD", "Project targets require a workspace cwd", 400);
      }
      return join(cwd, ".pi", "mcp.json");
    }
    default: {
      const _exhaustive: never = targetId;
      throw new McpConfigError("INVALID_TARGET", `Unknown target: ${String(_exhaustive)}`, 400);
    }
  }
}

function getReadOnlySourcePath(id: "agents-global" | "agents-nested-global", homeDir?: string): string {
  const home = resolveHome(homeDir);
  if (id === "agents-global") return join(home, ".agents", "mcp.json");
  return join(home, ".agents", "mcp", "mcp.json");
}

/** Ordered by adapter precedence (lowest index = lower precedence display order uses numeric rank). */
const SOURCE_ORDER: Array<{
  id: McpSourceId;
  label: string;
  scope: McpScope | "agents";
  kind: "shared" | "pi" | "agents";
  writable: boolean;
  precedence: number;
}> = [
  { id: "user-shared", label: "User shared (~/.config/mcp/mcp.json)", scope: "user", kind: "shared", writable: true, precedence: 1 },
  { id: "agents-global", label: "Agents shared (~/.agents/mcp.json)", scope: "agents", kind: "agents", writable: false, precedence: 2 },
  { id: "agents-nested-global", label: "Agents nested (~/.agents/mcp/mcp.json)", scope: "agents", kind: "agents", writable: false, precedence: 3 },
  { id: "user-pi", label: "User Pi override (<agent>/mcp.json)", scope: "user", kind: "pi", writable: true, precedence: 4 },
  { id: "project-shared", label: "Project shared (.mcp.json)", scope: "project", kind: "shared", writable: true, precedence: 5 },
  { id: "project-pi", label: "Project Pi override (.pi/mcp.json)", scope: "project", kind: "pi", writable: true, precedence: 6 },
];

export function isWritableTargetId(value: unknown): value is McpWritableTargetId {
  return value === "user-shared" || value === "user-pi" || value === "project-shared" || value === "project-pi";
}

export function defaultTargetForScope(scope: McpScope): McpWritableTargetId {
  return scope === "user" ? "user-shared" : "project-shared";
}

export function scopeForTarget(targetId: McpWritableTargetId): McpScope {
  return targetId.startsWith("project-") ? "project" : "user";
}

function displayPathFor(path: string, options: McpPathOptions = {}): string {
  const home = resolveHome(options.homeDir);
  const agentDir = resolveAgentDir(options.agentDir);
  if (path.startsWith(home)) {
    return `~${path.slice(home.length).replace(/\\/g, "/")}`;
  }
  if (path.startsWith(agentDir)) {
    return `<agent>${path.slice(agentDir.length).replace(/\\/g, "/")}`;
  }
  return path.replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

export async function assertProjectCwdAuthorized(cwd: string | null | undefined): Promise<string> {
  if (!cwd || !cwd.trim()) {
    throw new McpConfigError("MISSING_CWD", "Project MCP targets require cwd", 400);
  }
  const canonical = existingCanonicalCwd(cwd);
  if (!canonical) {
    throw new McpConfigError("UNAUTHORIZED_CWD", `Directory does not exist: ${cwd}`, 400);
  }
  // Prefer explicitly registered roots (sidebar selection / smoke fixtures) before
  // the heavier session-index scan so config APIs stay usable in isolated tests.
  if (isRegisteredAllowedRoot(canonical)) return canonical;
  const roots = await getAllowedRoots();
  if (!isPathAllowed(canonical, roots)) {
    throw new McpConfigError(
      "UNAUTHORIZED_CWD",
      `Unauthorized workspace: ${cwd}. Select the workspace in the sidebar first.`,
      403,
    );
  }
  return canonical;
}

function assertResolvedPathIsTarget(
  targetId: McpWritableTargetId,
  resolvedPath: string,
  options: McpPathOptions,
): void {
  const expected = resolve(getMcpTargetPath(targetId, options));
  const actual = resolve(resolvedPath);
  if (process.platform === "win32") {
    if (expected.toLowerCase() !== actual.toLowerCase()) {
      throw new McpConfigError("INVALID_TARGET", "Resolved path is outside the fixed MCP targets", 400);
    }
  } else if (expected !== actual) {
    throw new McpConfigError("INVALID_TARGET", "Resolved path is outside the fixed MCP targets", 400);
  }
}

// ---------------------------------------------------------------------------
// Revision / parse helpers
// ---------------------------------------------------------------------------

export function computeRevisionFromBytes(path: string, bytes: string | null): string {
  return createHash("sha256")
    .update(`${path}::${bytes ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

function readRawFile(path: string): { exists: boolean; text: string | null } {
  if (!existsSync(path)) return { exists: false, text: null };
  try {
    return { exists: true, text: readFileSync(path, "utf8") };
  } catch (error) {
    throw new McpConfigError(
      "IO_ERROR",
      `Failed to read MCP config: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
}

function parseConfigText(text: string): { value: unknown; error?: string } {
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: true,
  });
  if (errors.length > 0) {
    const first = errors[0];
    return {
      value: undefined,
      error: `${printParseErrorCode(first.error)} at offset ${first.offset}`,
    };
  }
  if (text.trim() === "") {
    return { value: {} };
  }
  return { value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getServersRecord(root: Record<string, unknown>): Record<string, unknown> {
  const primary = root.mcpServers;
  if (isRecord(primary)) return primary;
  const alt = root["mcp-servers"];
  if (isRecord(alt)) return alt;
  return {};
}

function getServersKey(root: Record<string, unknown>): "mcpServers" | "mcp-servers" {
  if (root["mcp-servers"] !== undefined && root.mcpServers === undefined) return "mcp-servers";
  return "mcpServers";
}

function isExecutableSecretValue(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("!") && !value.startsWith("!!");
}

function secretProjection(key: string, value: unknown): McpSecretProjection {
  const configured = value !== undefined && value !== null && String(value).length > 0;
  return {
    key,
    configured,
    executableSecret: configured && isExecutableSecretValue(value) ? true : undefined,
  };
}

function mapSecretRecord(value: unknown): McpSecretProjection[] | undefined {
  if (!isRecord(value)) return undefined;
  return Object.keys(value)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => secretProjection(key, value[key]));
}

function projectOAuth(value: unknown): McpOAuthProjection | undefined {
  if (value === false) return { disabled: true };
  if (!isRecord(value)) return undefined;
  const oauth: McpOAuthProjection = {};
  if (typeof value.grantType === "string" && OAUTH_GRANTS.has(value.grantType as McpOAuthGrantType)) {
    oauth.grantType = value.grantType as McpOAuthGrantType;
  }
  if (typeof value.clientId === "string") oauth.clientId = value.clientId;
  if (typeof value.scope === "string") oauth.scope = value.scope;
  if (typeof value.redirectUri === "string") oauth.redirectUri = value.redirectUri;
  if (typeof value.clientName === "string") oauth.clientName = value.clientName;
  if (typeof value.clientUri === "string") oauth.clientUri = value.clientUri;
  if (value.clientSecret !== undefined) {
    oauth.clientSecret = secretProjection("clientSecret", value.clientSecret);
  }
  return oauth;
}

function detectTransport(entry: Record<string, unknown>): McpTransportKind | "unknown" {
  const hasCommand = typeof entry.command === "string" && entry.command.length > 0;
  const hasUrl = typeof entry.url === "string" && entry.url.length > 0;
  const hasSocket = typeof entry.socket === "string" && entry.socket.length > 0;
  const count = Number(hasCommand) + Number(hasUrl) + Number(hasSocket);
  if (count !== 1) return "unknown";
  if (hasCommand) return "stdio";
  if (hasUrl) return "http";
  return "socket";
}

function projectServer(name: string, raw: unknown): McpServerProjection {
  const entry = isRecord(raw) ? raw : {};
  const env = mapSecretRecord(entry.env);
  const headers = mapSecretRecord(entry.headers);
  const bearerToken =
    entry.bearerToken !== undefined ? secretProjection("bearerToken", entry.bearerToken) : undefined;
  const oauth = projectOAuth(entry.oauth);
  const lifecycle =
    typeof entry.lifecycle === "string" && LIFECYCLES.has(entry.lifecycle as McpLifecycle)
      ? (entry.lifecycle as McpLifecycle)
      : undefined;

  const hasExecutableSecret = Boolean(
    env?.some((item) => item.executableSecret)
      || headers?.some((item) => item.executableSecret)
      || bearerToken?.executableSecret
      || oauth?.clientSecret?.executableSecret,
  );

  const unknownFieldKeys = Object.keys(entry).filter((key) => !KNOWN_SERVER_FIELDS.has(key)).sort();

  const projection: McpServerProjection = {
    name,
    transport: detectTransport(entry),
    risks: {
      hasExecutableSecret,
      eagerOrKeepAlive: lifecycle === "eager" || lifecycle === "keep-alive" || lifecycle === "lazy-keep-alive",
    },
    unknownFieldKeys,
  };

  if (typeof entry.command === "string") projection.command = entry.command;
  if (Array.isArray(entry.args) && entry.args.every((item) => typeof item === "string")) {
    projection.args = entry.args as string[];
  }
  if (typeof entry.socket === "string") projection.socket = entry.socket;
  if (typeof entry.cwd === "string") projection.cwd = entry.cwd;
  if (typeof entry.url === "string") projection.url = entry.url;
  if (entry.auth === false || entry.auth === "oauth" || entry.auth === "bearer") {
    projection.auth = entry.auth;
  }
  if (typeof entry.bearerTokenEnv === "string") projection.bearerTokenEnv = entry.bearerTokenEnv;
  if (oauth) projection.oauth = oauth;
  if (lifecycle) projection.lifecycle = lifecycle;
  if (typeof entry.idleTimeout === "number") projection.idleTimeout = entry.idleTimeout;
  if (typeof entry.requestTimeoutMs === "number") projection.requestTimeoutMs = entry.requestTimeoutMs;
  if (typeof entry.exposeResources === "boolean") projection.exposeResources = entry.exposeResources;
  if (typeof entry.directTools === "boolean" || (Array.isArray(entry.directTools) && entry.directTools.every((x) => typeof x === "string"))) {
    projection.directTools = entry.directTools as boolean | string[];
  }
  if (Array.isArray(entry.includeTools) && entry.includeTools.every((x) => typeof x === "string")) {
    projection.includeTools = entry.includeTools as string[];
  }
  if (Array.isArray(entry.excludeTools) && entry.excludeTools.every((x) => typeof x === "string")) {
    projection.excludeTools = entry.excludeTools as string[];
  }
  if (typeof entry.debug === "boolean") projection.debug = entry.debug;
  if (typeof entry.trace === "boolean") projection.trace = entry.trace;
  if (typeof entry.disabled === "boolean") projection.disabled = entry.disabled;
  if (env) projection.env = env;
  if (headers) projection.headers = headers;
  if (bearerToken) projection.bearerToken = bearerToken;

  return projection;
}

function projectSettings(raw: unknown): McpSettingsProjection | undefined {
  if (!isRecord(raw)) return undefined;
  const unknownFieldKeys = Object.keys(raw).filter((key) => !KNOWN_SETTINGS_FIELDS.has(key)).sort();
  const settings: McpSettingsProjection = { unknownFieldKeys };

  if (typeof raw.toolPrefix === "string" && TOOL_PREFIXES.has(raw.toolPrefix as McpToolPrefix)) {
    settings.toolPrefix = raw.toolPrefix as McpToolPrefix;
  }
  if (typeof raw.showStatusIcon === "boolean") settings.showStatusIcon = raw.showStatusIcon;
  if (typeof raw.hostConfigDiscovery === "string" && HOST_DISCOVERY.has(raw.hostConfigDiscovery as McpHostConfigDiscovery)) {
    settings.hostConfigDiscovery = raw.hostConfigDiscovery as McpHostConfigDiscovery;
  }
  if (typeof raw.idleTimeout === "number") settings.idleTimeout = raw.idleTimeout;
  if (typeof raw.requestTimeoutMs === "number") settings.requestTimeoutMs = raw.requestTimeoutMs;
  if (typeof raw.directTools === "boolean") settings.directTools = raw.directTools;
  if (typeof raw.disableProxyTool === "boolean") settings.disableProxyTool = raw.disableProxyTool;
  if (typeof raw.autoAuth === "boolean") settings.autoAuth = raw.autoAuth;
  if (typeof raw.sampling === "boolean") settings.sampling = raw.sampling;
  if (typeof raw.samplingAutoApprove === "boolean") settings.samplingAutoApprove = raw.samplingAutoApprove;
  if (typeof raw.elicitation === "boolean") settings.elicitation = raw.elicitation;
  if (typeof raw.authRequiredMessage === "string") settings.authRequiredMessage = raw.authRequiredMessage;
  if (typeof raw.oauthDir === "string") settings.oauthDir = raw.oauthDir;

  if (raw.outputGuard === false || raw.outputGuard === true) {
    settings.outputGuard = raw.outputGuard;
  } else if (isRecord(raw.outputGuard)) {
    const og: McpOutputGuardProjection = {};
    if (typeof raw.outputGuard.maxBytes === "number") og.maxBytes = raw.outputGuard.maxBytes;
    if (typeof raw.outputGuard.maxLines === "number") og.maxLines = raw.outputGuard.maxLines;
    if (typeof raw.outputGuard.detailsMaxBytes === "number") og.detailsMaxBytes = raw.outputGuard.detailsMaxBytes;
    settings.outputGuard = og;
  }

  if (isRecord(raw.trace)) {
    const tr: McpTraceProjection = {};
    if (typeof raw.trace.enabled === "boolean") tr.enabled = raw.trace.enabled;
    if (typeof raw.trace.file === "string") tr.file = raw.trace.file;
    if (typeof raw.trace.maxBytes === "number") tr.maxBytes = raw.trace.maxBytes;
    if (typeof raw.trace.maxEvents === "number") tr.maxEvents = raw.trace.maxEvents;
    settings.trace = tr;
  }

  return settings;
}

function projectImports(raw: unknown): McpImportKind[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const imports = raw.filter((item): item is McpImportKind => typeof item === "string" && IMPORT_KINDS.has(item as McpImportKind));
  return imports.length > 0 ? imports : undefined;
}

export function projectMcpConfig(value: unknown): McpConfigProjection {
  if (value === undefined || value === null) return { ...EMPTY_PROJECTION };
  if (!isRecord(value)) {
    return { ...EMPTY_PROJECTION };
  }
  const serversRaw = getServersRecord(value);
  const servers = Object.keys(serversRaw)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => projectServer(name, serversRaw[name]));
  const unknownRootKeys = Object.keys(value).filter((key) => !KNOWN_ROOT_FIELDS.has(key)).sort();
  return {
    servers,
    imports: projectImports(value.imports),
    settings: projectSettings(value.settings),
    unknownRootKeys,
  };
}

function countServers(value: unknown): number {
  if (!isRecord(value)) return 0;
  return Object.keys(getServersRecord(value)).length;
}

// ---------------------------------------------------------------------------
// Package discovery (read-only metadata; never loads adapter)
// ---------------------------------------------------------------------------

function readPackageVersion(installedPath?: string): string | undefined {
  if (!installedPath) return undefined;
  const candidates = [
    join(installedPath, "package.json"),
    installedPath.endsWith("package.json") ? installedPath : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (parsed.name === "pi-mcp-adapter" && typeof parsed.version === "string") {
        return parsed.version;
      }
      if (typeof parsed.version === "string" && /pi-mcp-adapter/i.test(candidate)) {
        return parsed.version;
      }
    } catch {
      // ignore
    }
  }
  // Some installs point installedPath at the package root file entry
  try {
    const pkgJson = join(dirname(installedPath), "package.json");
    if (existsSync(pkgJson)) {
      const parsed = JSON.parse(readFileSync(pkgJson, "utf8")) as { name?: string; version?: string };
      if (parsed.name === "pi-mcp-adapter" && typeof parsed.version === "string") return parsed.version;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function readSettingsPackages(
  settingsPath: string,
  scope: "user" | "project",
): Array<{ source: string; scope: "user" | "project"; filtered: boolean }> {
  if (!existsSync(settingsPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.packages)) return [];
    const out: Array<{ source: string; scope: "user" | "project"; filtered: boolean }> = [];
    for (const pkg of parsed.packages) {
      if (typeof pkg === "string") {
        out.push({ source: pkg, scope, filtered: false });
        continue;
      }
      if (isRecord(pkg) && typeof pkg.source === "string") {
        out.push({ source: pkg.source, scope, filtered: true });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function guessMcpAdapterInstallPath(agentDir: string, cwd?: string | null): string | undefined {
  const candidates = [
    join(agentDir, "npm", "node_modules", "pi-mcp-adapter"),
    join(agentDir, "node_modules", "pi-mcp-adapter"),
    cwd ? join(cwd, "node_modules", "pi-mcp-adapter") : "",
    cwd ? join(cwd, ".pi", "npm", "node_modules", "pi-mcp-adapter") : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return undefined;
}

/**
 * Read-only package metadata discovery. Never imports/loads pi-mcp-adapter or
 * runs DefaultResourceLoader.reload().
 */
export function detectMcpAdapterPackage(options: {
  cwd?: string | null;
  agentDir?: string;
} = {}): McpAdapterPackageStatus {
  const agentDir = resolveAgentDir(options.agentDir);
  const cwd = options.cwd ? canonicalizeCwd(options.cwd) : null;
  try {
    const userPackages = readSettingsPackages(join(agentDir, "settings.json"), "user");
    const projectPackages = cwd
      ? readSettingsPackages(join(cwd, ".pi", "settings.json"), "project")
      : [];
    const configured = [...userPackages, ...projectPackages];
    const matches = configured.filter((item) => MCP_ADAPTER_SOURCE_RE.test(item.source));
    if (matches.length === 0) {
      return {
        configured: false,
        sources: [],
        versionUnknown: true,
        installCommand: INSTALL_COMMAND,
        diagnostic: "pi-mcp-adapter is not listed in Pi package configuration",
      };
    }
    const installedPath = guessMcpAdapterInstallPath(agentDir, cwd);
    const version = readPackageVersion(installedPath);
    return {
      configured: true,
      sources: matches.map((item) => ({
        source: item.source,
        scope: item.scope,
        filtered: item.filtered,
      })),
      version,
      versionUnknown: !version,
      installCommand: INSTALL_COMMAND,
      diagnostic: version
        ? undefined
        : "Adapter package is configured but version could not be resolved from package metadata",
    };
  } catch (error) {
    return {
      configured: false,
      sources: [],
      versionUnknown: true,
      installCommand: INSTALL_COMMAND,
      diagnostic: `Package discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Source summaries / read target
// ---------------------------------------------------------------------------

function summarizePath(
  id: McpSourceId,
  path: string,
  meta: (typeof SOURCE_ORDER)[number],
  options: McpPathOptions,
): McpSourceSummary {
  const raw = readRawFile(path);
  if (!raw.exists || raw.text === null) {
    return {
      id,
      label: meta.label,
      path,
      displayPath: displayPathFor(path, options),
      scope: meta.scope,
      kind: meta.kind,
      precedence: meta.precedence,
      exists: false,
      writable: meta.writable,
      parseState: "missing",
      serverCount: 0,
    };
  }
  const parsed = parseConfigText(raw.text);
  if (parsed.error) {
    return {
      id,
      label: meta.label,
      path,
      displayPath: displayPathFor(path, options),
      scope: meta.scope,
      kind: meta.kind,
      precedence: meta.precedence,
      exists: true,
      writable: meta.writable,
      parseState: "parse-error",
      serverCount: 0,
      parseError: parsed.error,
    };
  }
  return {
    id,
    label: meta.label,
    path,
    displayPath: displayPathFor(path, options),
    scope: meta.scope,
    kind: meta.kind,
    precedence: meta.precedence,
    exists: true,
    writable: meta.writable,
    parseState: "valid",
    serverCount: countServers(parsed.value),
  };
}

export function listMcpSourceSummaries(options: McpPathOptions = {}): McpSourceSummary[] {
  const cwd = options.cwd ? canonicalizeCwd(options.cwd) : null;
  const out: McpSourceSummary[] = [];
  for (const meta of SOURCE_ORDER) {
    if ((meta.id === "project-shared" || meta.id === "project-pi") && !cwd) {
      out.push({
        id: meta.id,
        label: meta.label,
        path: "",
        displayPath: meta.id === "project-shared" ? ".mcp.json" : ".pi/mcp.json",
        scope: meta.scope,
        kind: meta.kind,
        precedence: meta.precedence,
        exists: false,
        writable: meta.writable,
        parseState: "missing",
        serverCount: 0,
      });
      continue;
    }
    let path: string;
    if (meta.id === "agents-global" || meta.id === "agents-nested-global") {
      path = getReadOnlySourcePath(meta.id, options.homeDir);
    } else {
      path = getMcpTargetPath(meta.id, { ...options, cwd });
    }
    out.push(summarizePath(meta.id, path, meta, options));
  }
  return out;
}

export function readMcpTargetFile(
  targetId: McpWritableTargetId,
  options: McpPathOptions = {},
): McpTargetFileState {
  if (!isWritableTargetId(targetId)) {
    throw new McpConfigError("INVALID_TARGET", `Invalid target: ${String(targetId)}`, 400);
  }
  const path = getMcpTargetPath(targetId, options);
  assertResolvedPathIsTarget(targetId, path, options);
  const raw = readRawFile(path);
  const revision = computeRevisionFromBytes(path, raw.text);
  if (!raw.exists || raw.text === null) {
    return {
      targetId,
      path,
      displayPath: displayPathFor(path, options),
      exists: false,
      revision,
      projection: { ...EMPTY_PROJECTION },
    };
  }
  const parsed = parseConfigText(raw.text);
  if (parsed.error) {
    return {
      targetId,
      path,
      displayPath: displayPathFor(path, options),
      exists: true,
      revision,
      parseError: parsed.error,
      projection: { ...EMPTY_PROJECTION },
    };
  }
  if (parsed.value !== undefined && parsed.value !== null && !isRecord(parsed.value)) {
    return {
      targetId,
      path,
      displayPath: displayPathFor(path, options),
      exists: true,
      revision,
      parseError: "MCP config root must be a JSON object",
      projection: { ...EMPTY_PROJECTION },
    };
  }
  return {
    targetId,
    path,
    displayPath: displayPathFor(path, options),
    exists: true,
    revision,
    projection: projectMcpConfig(parsed.value ?? {}),
  };
}

export async function loadMcpConfigSnapshot(input: {
  targetId?: McpWritableTargetId | null;
  scope?: McpScope | null;
  cwd?: string | null;
  agentDir?: string;
  homeDir?: string;
}): Promise<McpConfigSnapshot> {
  const scope = input.scope === "project" || input.scope === "user"
    ? input.scope
    : input.targetId
      ? scopeForTarget(input.targetId)
      : "user";

  let cwd: string | undefined;
  if (scope === "project" || (input.targetId && scopeForTarget(input.targetId) === "project")) {
    cwd = await assertProjectCwdAuthorized(input.cwd);
  } else if (input.cwd) {
    const canonical = existingCanonicalCwd(input.cwd);
    if (canonical) {
      try {
        const roots = await getAllowedRoots();
        if (isPathAllowed(canonical, roots)) cwd = canonical;
      } catch {
        // optional for user scope
      }
    }
  }

  const targetId = input.targetId && isWritableTargetId(input.targetId)
    ? input.targetId
    : defaultTargetForScope(scope);

  if (scopeForTarget(targetId) === "project" && !cwd) {
    cwd = await assertProjectCwdAuthorized(input.cwd);
  }

  const pathOptions: McpPathOptions = {
    cwd,
    agentDir: input.agentDir,
    homeDir: input.homeDir,
  };

  const selected = readMcpTargetFile(targetId, pathOptions);
  const sources = listMcpSourceSummaries(pathOptions);
  const adapter = detectMcpAdapterPackage({ cwd: cwd ?? input.cwd, agentDir: input.agentDir });

  return {
    scope: scopeForTarget(targetId),
    targetId,
    cwd,
    adapter,
    sources,
    selected,
    reloadRequiredHint:
      "New sessions load saved MCP config automatically. The current session needs /reload.",
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Reject unsupported mutation keys with a stable field path.
 * Does not include values in the message (avoids secret echo).
 */
function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  fieldPath: string,
): void {
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    const path = fieldPath ? `${fieldPath}.${key}` : key;
    throw new McpConfigError("VALIDATION_ERROR", `Unknown field: ${path}`, 400, path);
  }
}

function assertPlainObject(value: unknown, fieldPath: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new McpConfigError("VALIDATION_ERROR", `${fieldPath} must be an object`, 400, fieldPath);
  }
}

function validateServerName(name: string, fieldPath = "name"): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed || !SERVER_NAME_RE.test(trimmed)) {
    throw new McpConfigError("VALIDATION_ERROR", "Invalid MCP server name", 400, fieldPath);
  }
  return trimmed;
}

function assertValidSecretOp(op: unknown, fieldPath: string): asserts op is McpSecretOp {
  assertPlainObject(op, fieldPath);
  assertNoUnknownKeys(op, SECRET_OP_FIELDS, fieldPath);
  if (op.op === "preserve" || op.op === "clear") {
    if (Object.prototype.hasOwnProperty.call(op, "value")) {
      throw new McpConfigError(
        "VALIDATION_ERROR",
        `Secret ${String(op.op)} must not include value`,
        400,
        `${fieldPath}.value`,
      );
    }
    return;
  }
  if (op.op === "replace") {
    if (typeof op.value !== "string") {
      throw new McpConfigError("VALIDATION_ERROR", "Secret replace requires a string value", 400, fieldPath);
    }
    return;
  }
  throw new McpConfigError("VALIDATION_ERROR", "Invalid secret operation", 400, fieldPath);
}

function assertValidSecretMap(ops: unknown, fieldPath: string): asserts ops is Record<string, McpSecretOp> {
  assertPlainObject(ops, fieldPath);
  for (const [key, value] of Object.entries(ops)) {
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      throw new McpConfigError("VALIDATION_ERROR", "Secret map key must be non-empty", 400, fieldPath);
    }
    assertValidSecretOp(value, `${fieldPath}.${trimmedKey}`);
  }
}

function assertValidOAuthMutation(oauth: unknown, fieldPath: string): asserts oauth is McpOAuthMutation {
  assertPlainObject(oauth, fieldPath);
  assertNoUnknownKeys(oauth, OAUTH_MUTATION_FIELDS, fieldPath);
  if (Object.prototype.hasOwnProperty.call(oauth, "clientSecret") && oauth.clientSecret !== undefined) {
    assertValidSecretOp(oauth.clientSecret, `${fieldPath}.clientSecret`);
  }
}

function assertValidOutputGuardMutation(value: unknown, fieldPath: string): void {
  if (value === true || value === false || value === null) return;
  assertPlainObject(value, fieldPath);
  assertNoUnknownKeys(value, OUTPUT_GUARD_MUTATION_FIELDS, fieldPath);
}

function assertValidTraceMutation(value: unknown, fieldPath: string): void {
  if (value === null) return;
  assertPlainObject(value, fieldPath);
  assertNoUnknownKeys(value, TRACE_MUTATION_FIELDS, fieldPath);
}

function assertValidServerMutation(server: unknown, fieldPath: string): asserts server is McpServerMutation {
  assertPlainObject(server, fieldPath);
  assertNoUnknownKeys(server, SERVER_MUTATION_FIELDS, fieldPath);
  if (Object.prototype.hasOwnProperty.call(server, "oauth") && server.oauth != null) {
    assertValidOAuthMutation(server.oauth, `${fieldPath}.oauth`);
  }
  if (Object.prototype.hasOwnProperty.call(server, "env") && server.env !== undefined) {
    assertValidSecretMap(server.env, `${fieldPath}.env`);
  }
  if (Object.prototype.hasOwnProperty.call(server, "headers") && server.headers !== undefined) {
    assertValidSecretMap(server.headers, `${fieldPath}.headers`);
  }
  if (Object.prototype.hasOwnProperty.call(server, "bearerToken") && server.bearerToken !== undefined) {
    assertValidSecretOp(server.bearerToken, `${fieldPath}.bearerToken`);
  }
}

function assertValidSettingsMutation(
  settings: unknown,
  fieldPath: string,
): asserts settings is McpSettingsMutation {
  assertPlainObject(settings, fieldPath);
  assertNoUnknownKeys(settings, SETTINGS_MUTATION_FIELDS, fieldPath);
  if (Object.prototype.hasOwnProperty.call(settings, "outputGuard")) {
    assertValidOutputGuardMutation(settings.outputGuard, `${fieldPath}.outputGuard`);
  }
  if (Object.prototype.hasOwnProperty.call(settings, "trace")) {
    assertValidTraceMutation(settings.trace, `${fieldPath}.trace`);
  }
}

function assertValidOperation(operation: unknown, index: number): asserts operation is McpConfigOperation {
  const fieldPath = `operations[${index}]`;
  if (!operation || typeof operation !== "object" || Array.isArray(operation) || !("op" in operation)) {
    throw new McpConfigError("UNKNOWN_OPERATION", `Invalid operation at index ${index}`, 400, fieldPath);
  }
  const record = operation as Record<string, unknown>;
  const opName = record.op;
  // Do not use `in` against a prototype-bearing object: prototype names must be UNKNOWN_OPERATION.
  // Never interpolate the supplied discriminator into the message (no request-value echo).
  const allowedFields = typeof opName === "string" ? OPERATION_FIELDS_BY_OP.get(opName) : undefined;
  if (!allowedFields) {
    throw new McpConfigError("UNKNOWN_OPERATION", "Unknown operation", 400, fieldPath);
  }
  assertNoUnknownKeys(record, allowedFields, fieldPath);

  switch (opName) {
    case "upsertServer": {
      if (typeof record.name !== "string") {
        throw new McpConfigError("VALIDATION_ERROR", "upsertServer.name is required", 400, `${fieldPath}.name`);
      }
      validateServerName(record.name, `${fieldPath}.name`);
      // Missing server is treated as empty partial update by the applier.
      if (record.server !== undefined) {
        assertValidServerMutation(record.server, `${fieldPath}.server`);
      }
      break;
    }
    case "deleteServer": {
      if (typeof record.name !== "string") {
        throw new McpConfigError("VALIDATION_ERROR", "deleteServer.name is required", 400, `${fieldPath}.name`);
      }
      validateServerName(record.name, `${fieldPath}.name`);
      break;
    }
    case "renameServer": {
      if (typeof record.from !== "string") {
        throw new McpConfigError("VALIDATION_ERROR", "renameServer.from is required", 400, `${fieldPath}.from`);
      }
      if (typeof record.to !== "string") {
        throw new McpConfigError("VALIDATION_ERROR", "renameServer.to is required", 400, `${fieldPath}.to`);
      }
      validateServerName(record.from, `${fieldPath}.from`);
      validateServerName(record.to, `${fieldPath}.to`);
      break;
    }
    case "setSettings": {
      if (record.settings !== null && record.settings !== undefined) {
        assertValidSettingsMutation(record.settings, `${fieldPath}.settings`);
      } else if (record.settings === undefined) {
        throw new McpConfigError(
          "VALIDATION_ERROR",
          "setSettings.settings is required (object or null)",
          400,
          `${fieldPath}.settings`,
        );
      }
      break;
    }
    case "setImports": {
      if (record.imports === undefined) {
        throw new McpConfigError(
          "VALIDATION_ERROR",
          "setImports.imports is required (array or null)",
          400,
          `${fieldPath}.imports`,
        );
      }
      break;
    }
    default:
      break;
  }
}

function countTransportFields(entry: Record<string, unknown>): {
  command: boolean;
  url: boolean;
  socket: boolean;
  count: number;
} {
  const command = typeof entry.command === "string" && entry.command.trim().length > 0;
  const url = typeof entry.url === "string" && entry.url.trim().length > 0;
  const socket = typeof entry.socket === "string" && entry.socket.trim().length > 0;
  return { command, url, socket, count: Number(command) + Number(url) + Number(socket) };
}

function assertExactlyOneTransport(entry: Record<string, unknown>, fieldPath: string): void {
  const { count } = countTransportFields(entry);
  if (count !== 1) {
    throw new McpConfigError(
      "VALIDATION_ERROR",
      "Server must define exactly one of command, url, or socket",
      400,
      fieldPath,
    );
  }
}

function applySecretOp(
  current: unknown,
  op: McpSecretOp | undefined,
  fieldPath: string,
): { changed: boolean; value: unknown; remove: boolean } {
  if (!op) {
    return { changed: false, value: current, remove: false };
  }
  assertValidSecretOp(op, fieldPath);
  if (op.op === "preserve") {
    return { changed: false, value: current, remove: false };
  }
  if (op.op === "clear") {
    return { changed: true, value: undefined, remove: true };
  }
  // replace — value type already checked by assertValidSecretOp
  return { changed: true, value: op.value, remove: false };
}

function applySecretMap(
  current: unknown,
  ops: Record<string, McpSecretOp> | undefined,
  fieldPath: string,
): { changed: boolean; value: Record<string, string> | undefined; remove: boolean } {
  if (!ops) {
    return {
      changed: false,
      value: isRecord(current)
        ? Object.fromEntries(
          Object.entries(current).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
        : undefined,
      remove: false,
    };
  }

  const next: Record<string, string> = {};
  if (isRecord(current)) {
    for (const [key, value] of Object.entries(current)) {
      if (typeof value === "string") next[key] = value;
    }
  }

  let changed = false;
  for (const [key, op] of Object.entries(ops)) {
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      throw new McpConfigError("VALIDATION_ERROR", "Secret map key must be non-empty", 400, fieldPath);
    }
    const result = applySecretOp(next[trimmedKey], op, `${fieldPath}.${trimmedKey}`);
    if (!result.changed) continue;
    changed = true;
    if (result.remove) delete next[trimmedKey];
    else next[trimmedKey] = String(result.value);
  }

  if (Object.keys(next).length === 0) {
    return { changed: changed || isRecord(current), value: undefined, remove: true };
  }
  return { changed: changed || !isRecord(current), value: next, remove: false };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function ensureRootObject(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || value === "") return {};
  if (!isRecord(value)) {
    throw new McpConfigError("PARSE_ERROR", "MCP config root must be a JSON object", 409);
  }
  return cloneJson(value);
}

function ensureServersObject(root: Record<string, unknown>): {
  key: "mcpServers" | "mcp-servers";
  servers: Record<string, unknown>;
} {
  const key = getServersKey(root);
  const existing = root[key];
  if (existing === undefined) {
    return { key: "mcpServers", servers: {} };
  }
  if (!isRecord(existing)) {
    throw new McpConfigError("VALIDATION_ERROR", `${key} must be a JSON object`, 400, key);
  }
  return { key, servers: { ...existing } };
}

function applyServerMutation(
  existingRaw: unknown,
  mutation: McpServerMutation,
  fieldPath: string,
): Record<string, unknown> {
  assertValidServerMutation(mutation, fieldPath);
  const existing = isRecord(existingRaw) ? cloneJson(existingRaw) : {};
  const next: Record<string, unknown> = { ...existing };

  // Transport fields
  if (Object.prototype.hasOwnProperty.call(mutation, "command")) {
    if (mutation.command === null) delete next.command;
    else if (typeof mutation.command === "string") next.command = mutation.command;
  }
  if (Object.prototype.hasOwnProperty.call(mutation, "url")) {
    if (mutation.url === null) delete next.url;
    else if (typeof mutation.url === "string") next.url = mutation.url;
  }
  if (Object.prototype.hasOwnProperty.call(mutation, "socket")) {
    if (mutation.socket === null) delete next.socket;
    else if (typeof mutation.socket === "string") next.socket = mutation.socket;
  }
  if (Object.prototype.hasOwnProperty.call(mutation, "args")) {
    if (mutation.args === null) delete next.args;
    else if (Array.isArray(mutation.args) && mutation.args.every((x) => typeof x === "string")) {
      next.args = mutation.args;
    } else if (mutation.args !== undefined) {
      throw new McpConfigError("VALIDATION_ERROR", "args must be a string array or null", 400, `${fieldPath}.args`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(mutation, "cwd")) {
    if (mutation.cwd === null) delete next.cwd;
    else if (typeof mutation.cwd === "string") next.cwd = mutation.cwd;
  }

  // URL-bound credential clearing (adapter merge semantics)
  const previousUrl = typeof existing.url === "string" ? existing.url : undefined;
  const nextUrl = typeof next.url === "string" ? next.url : undefined;
  const urlChanged =
    Object.prototype.hasOwnProperty.call(mutation, "url")
    && nextUrl !== undefined
    && previousUrl !== undefined
    && nextUrl !== previousUrl;

  if (urlChanged) {
    const reauthProvided =
      mutation.confirmUrlAuthClear === true
      || mutation.bearerToken !== undefined
      || mutation.headers !== undefined
      || mutation.auth !== undefined
      || mutation.oauth !== undefined
      || mutation.bearerTokenEnv !== undefined;
    if (!reauthProvided) {
      throw new McpConfigError(
        "VALIDATION_ERROR",
        "Changing url clears URL-bound credentials; confirm with confirmUrlAuthClear or re-supply auth fields",
        400,
        `${fieldPath}.url`,
      );
    }
    // Clear inherited URL-bound auth unless explicitly re-supplied below.
    if (mutation.headers === undefined) delete next.headers;
    if (mutation.bearerToken === undefined) delete next.bearerToken;
    if (mutation.bearerTokenEnv === undefined) delete next.bearerTokenEnv;
    if (mutation.oauth === undefined) delete next.oauth;
  }

  // Transport switching cleanup
  const transports = countTransportFields(next);
  if (mutation.transport === "stdio" || (transports.command && !transports.url && !transports.socket)) {
    if (Object.prototype.hasOwnProperty.call(mutation, "command") || mutation.transport === "stdio") {
      delete next.url;
      delete next.socket;
      if (mutation.transport === "stdio" && mutation.headers === undefined) {
        // keep headers? no for stdio
        delete next.headers;
      }
    }
  }
  if (mutation.transport === "http" || (transports.url && !transports.command && !transports.socket)) {
    if (Object.prototype.hasOwnProperty.call(mutation, "url") || mutation.transport === "http") {
      delete next.command;
      delete next.args;
      delete next.socket;
      if (mutation.transport === "http" && mutation.env === undefined) {
        // env is stdio-oriented; leave if user set explicitly
      }
    }
  }
  if (mutation.transport === "socket" || (transports.socket && !transports.command && !transports.url)) {
    if (Object.prototype.hasOwnProperty.call(mutation, "socket") || mutation.transport === "socket") {
      delete next.command;
      delete next.args;
      delete next.env;
      delete next.cwd;
      delete next.url;
      delete next.headers;
      delete next.auth;
      delete next.bearerToken;
      delete next.bearerTokenEnv;
      delete next.oauth;
    }
  }

  if (Object.prototype.hasOwnProperty.call(mutation, "auth")) {
    if (mutation.auth === null) delete next.auth;
    else if (mutation.auth === false || mutation.auth === "oauth" || mutation.auth === "bearer") {
      next.auth = mutation.auth;
    } else {
      throw new McpConfigError("VALIDATION_ERROR", "auth must be oauth, bearer, false, or null", 400, `${fieldPath}.auth`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(mutation, "bearerTokenEnv")) {
    if (mutation.bearerTokenEnv === null) delete next.bearerTokenEnv;
    else if (typeof mutation.bearerTokenEnv === "string") next.bearerTokenEnv = mutation.bearerTokenEnv;
  }

  if (Object.prototype.hasOwnProperty.call(mutation, "lifecycle")) {
    if (mutation.lifecycle === null) delete next.lifecycle;
    else if (typeof mutation.lifecycle === "string" && LIFECYCLES.has(mutation.lifecycle)) {
      next.lifecycle = mutation.lifecycle;
    } else {
      throw new McpConfigError("VALIDATION_ERROR", "Invalid lifecycle", 400, `${fieldPath}.lifecycle`);
    }
  }

  for (const numKey of ["idleTimeout", "requestTimeoutMs"] as const) {
    if (Object.prototype.hasOwnProperty.call(mutation, numKey)) {
      const value = mutation[numKey];
      if (value === null) delete next[numKey];
      else if (typeof value === "number" && Number.isFinite(value)) next[numKey] = value;
      else if (value !== undefined) {
        throw new McpConfigError("VALIDATION_ERROR", `${numKey} must be a number or null`, 400, `${fieldPath}.${numKey}`);
      }
    }
  }

  for (const boolKey of ["exposeResources", "debug", "trace", "disabled"] as const) {
    if (Object.prototype.hasOwnProperty.call(mutation, boolKey)) {
      const value = mutation[boolKey];
      if (value === null) delete next[boolKey];
      else if (typeof value === "boolean") next[boolKey] = value;
      else if (value !== undefined) {
        throw new McpConfigError("VALIDATION_ERROR", `${boolKey} must be boolean or null`, 400, `${fieldPath}.${boolKey}`);
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(mutation, "directTools")) {
    if (mutation.directTools === null) delete next.directTools;
    else if (
      typeof mutation.directTools === "boolean"
      || (Array.isArray(mutation.directTools) && mutation.directTools.every((x) => typeof x === "string"))
    ) {
      next.directTools = mutation.directTools;
    } else if (mutation.directTools !== undefined) {
      throw new McpConfigError("VALIDATION_ERROR", "directTools must be boolean, string[], or null", 400, `${fieldPath}.directTools`);
    }
  }

  for (const listKey of ["includeTools", "excludeTools"] as const) {
    if (Object.prototype.hasOwnProperty.call(mutation, listKey)) {
      const value = mutation[listKey];
      if (value === null) delete next[listKey];
      else if (Array.isArray(value) && value.every((x) => typeof x === "string")) next[listKey] = value;
      else if (value !== undefined) {
        throw new McpConfigError("VALIDATION_ERROR", `${listKey} must be string[] or null`, 400, `${fieldPath}.${listKey}`);
      }
    }
  }

  // Secrets
  if (mutation.env) {
    const envResult = applySecretMap(next.env, mutation.env, `${fieldPath}.env`);
    if (envResult.changed) {
      if (envResult.remove) delete next.env;
      else next.env = envResult.value;
    }
  }
  if (mutation.headers) {
    const headersResult = applySecretMap(next.headers, mutation.headers, `${fieldPath}.headers`);
    if (headersResult.changed) {
      if (headersResult.remove) delete next.headers;
      else next.headers = headersResult.value;
    }
  }
  if (mutation.bearerToken) {
    const tokenResult = applySecretOp(next.bearerToken, mutation.bearerToken, `${fieldPath}.bearerToken`);
    if (tokenResult.changed) {
      if (tokenResult.remove) delete next.bearerToken;
      else next.bearerToken = tokenResult.value;
    }
  }

  if (Object.prototype.hasOwnProperty.call(mutation, "oauth")) {
    if (mutation.oauth === null) {
      delete next.oauth;
    } else if (mutation.oauth) {
      if (mutation.oauth.disabled === true) {
        next.oauth = false;
      } else {
        const currentOAuth = next.oauth === false ? {} : isRecord(next.oauth) ? { ...next.oauth } : {};
        if (mutation.oauth.disabled === null && next.oauth === false) {
          // clearing disabled false means remove oauth:false
          delete next.oauth;
        } else {
          const oauthNext: Record<string, unknown> = { ...currentOAuth };
          for (const key of ["grantType", "clientId", "scope", "redirectUri", "clientName", "clientUri"] as const) {
            if (Object.prototype.hasOwnProperty.call(mutation.oauth, key)) {
              const value = mutation.oauth[key];
              if (value === null) delete oauthNext[key];
              else if (typeof value === "string") {
                if (key === "grantType" && !OAUTH_GRANTS.has(value as McpOAuthGrantType)) {
                  throw new McpConfigError("VALIDATION_ERROR", "Invalid oauth.grantType", 400, `${fieldPath}.oauth.grantType`);
                }
                oauthNext[key] = value;
              }
            }
          }
          if (mutation.oauth.clientSecret) {
            const secretResult = applySecretOp(
              oauthNext.clientSecret,
              mutation.oauth.clientSecret,
              `${fieldPath}.oauth.clientSecret`,
            );
            if (secretResult.changed) {
              if (secretResult.remove) delete oauthNext.clientSecret;
              else oauthNext.clientSecret = secretResult.value;
            }
          }
          next.oauth = oauthNext;
        }
      }
    }
  }

  assertExactlyOneTransport(next, fieldPath);
  return next;
}

function applySettingsMutation(
  existingRaw: unknown,
  mutation: McpSettingsMutation | null,
  fieldPath = "settings",
): Record<string, unknown> | undefined {
  if (mutation === null) return undefined;
  assertValidSettingsMutation(mutation, fieldPath);
  const next: Record<string, unknown> = isRecord(existingRaw) ? cloneJson(existingRaw) : {};

  const assignNullable = (key: string, value: unknown, validate?: (v: unknown) => boolean) => {
    if (!Object.prototype.hasOwnProperty.call(mutation, key)) return;
    const raw = (mutation as Record<string, unknown>)[key];
    if (raw === null) {
      delete next[key];
      return;
    }
    if (raw === undefined) return;
    if (validate && !validate(raw)) {
      throw new McpConfigError(
        "VALIDATION_ERROR",
        `Invalid ${fieldPath}.${key}`,
        400,
        `${fieldPath}.${key}`,
      );
    }
    next[key] = raw;
  };

  assignNullable("toolPrefix", mutation.toolPrefix, (v) => typeof v === "string" && TOOL_PREFIXES.has(v as McpToolPrefix));
  assignNullable("showStatusIcon", mutation.showStatusIcon, (v) => typeof v === "boolean");
  assignNullable(
    "hostConfigDiscovery",
    mutation.hostConfigDiscovery,
    (v) => typeof v === "string" && HOST_DISCOVERY.has(v as McpHostConfigDiscovery),
  );
  assignNullable("idleTimeout", mutation.idleTimeout, (v) => typeof v === "number" && Number.isFinite(v));
  assignNullable("requestTimeoutMs", mutation.requestTimeoutMs, (v) => typeof v === "number" && Number.isFinite(v));
  assignNullable("directTools", mutation.directTools, (v) => typeof v === "boolean");
  assignNullable("disableProxyTool", mutation.disableProxyTool, (v) => typeof v === "boolean");
  assignNullable("autoAuth", mutation.autoAuth, (v) => typeof v === "boolean");
  assignNullable("sampling", mutation.sampling, (v) => typeof v === "boolean");
  assignNullable("samplingAutoApprove", mutation.samplingAutoApprove, (v) => typeof v === "boolean");
  assignNullable("elicitation", mutation.elicitation, (v) => typeof v === "boolean");
  assignNullable("authRequiredMessage", mutation.authRequiredMessage, (v) => typeof v === "string");
  assignNullable("oauthDir", mutation.oauthDir, (v) => typeof v === "string");

  if (Object.prototype.hasOwnProperty.call(mutation, "outputGuard")) {
    if (mutation.outputGuard === null) delete next.outputGuard;
    else if (mutation.outputGuard === true || mutation.outputGuard === false) next.outputGuard = mutation.outputGuard;
    else if (isRecord(mutation.outputGuard)) {
      // Allowlist already enforced; only persist known keys.
      const og: Record<string, unknown> = {};
      for (const key of OUTPUT_GUARD_MUTATION_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(mutation.outputGuard, key)) {
          og[key] = (mutation.outputGuard as Record<string, unknown>)[key];
        }
      }
      next.outputGuard = og;
    } else if (mutation.outputGuard !== undefined) {
      throw new McpConfigError("VALIDATION_ERROR", "Invalid settings.outputGuard", 400, `${fieldPath}.outputGuard`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(mutation, "trace")) {
    if (mutation.trace === null) delete next.trace;
    else if (isRecord(mutation.trace)) {
      const tr: Record<string, unknown> = {};
      for (const key of TRACE_MUTATION_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(mutation.trace, key)) {
          tr[key] = (mutation.trace as Record<string, unknown>)[key];
        }
      }
      next.trace = tr;
    } else if (mutation.trace !== undefined) {
      throw new McpConfigError("VALIDATION_ERROR", "Invalid settings.trace", 400, `${fieldPath}.trace`);
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function applyOperationsToRoot(
  root: Record<string, unknown>,
  operations: McpConfigOperation[],
): Record<string, unknown> {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new McpConfigError("VALIDATION_ERROR", "operations must be a non-empty array", 400, "operations");
  }

  let nextRoot = cloneJson(root);

  for (const [index, operation] of operations.entries()) {
    assertValidOperation(operation, index);
    const opPath = `operations[${index}]`;
    switch (operation.op) {
      case "upsertServer": {
        const name = validateServerName(operation.name, `${opPath}.name`);
        const { key, servers } = ensureServersObject(nextRoot);
        const updated = applyServerMutation(
          servers[name],
          operation.server ?? {},
          `${opPath}.server`,
        );
        servers[name] = updated;
        nextRoot = { ...nextRoot, [key]: servers };
        break;
      }
      case "deleteServer": {
        const name = validateServerName(operation.name, `${opPath}.name`);
        const { key, servers } = ensureServersObject(nextRoot);
        if (!(name in servers)) {
          throw new McpConfigError("VALIDATION_ERROR", `Server not found: ${name}`, 400, `mcpServers.${name}`);
        }
        delete servers[name];
        if (Object.keys(servers).length === 0) {
          const copy = { ...nextRoot };
          delete copy[key];
          nextRoot = copy;
        } else {
          nextRoot = { ...nextRoot, [key]: servers };
        }
        break;
      }
      case "renameServer": {
        const from = validateServerName(operation.from, `${opPath}.from`);
        const to = validateServerName(operation.to, `${opPath}.to`);
        if (from === to) break;
        const { key, servers } = ensureServersObject(nextRoot);
        if (!(from in servers)) {
          throw new McpConfigError("VALIDATION_ERROR", `Server not found: ${from}`, 400, `mcpServers.${from}`);
        }
        if (to in servers) {
          throw new McpConfigError("VALIDATION_ERROR", `Server already exists: ${to}`, 400, `mcpServers.${to}`);
        }
        servers[to] = servers[from];
        delete servers[from];
        nextRoot = { ...nextRoot, [key]: servers };
        break;
      }
      case "setSettings": {
        const settings = applySettingsMutation(nextRoot.settings, operation.settings, `${opPath}.settings`);
        if (settings === undefined) {
          const copy = { ...nextRoot };
          delete copy.settings;
          nextRoot = copy;
        } else {
          nextRoot = { ...nextRoot, settings };
        }
        break;
      }
      case "setImports": {
        if (operation.imports === null) {
          const copy = { ...nextRoot };
          delete copy.imports;
          nextRoot = copy;
        } else if (
          Array.isArray(operation.imports)
          && operation.imports.every((item): item is McpImportKind =>
            typeof item === "string" && IMPORT_KINDS.has(item as McpImportKind))
        ) {
          nextRoot = { ...nextRoot, imports: [...new Set(operation.imports)] };
        } else {
          throw new McpConfigError(
            "VALIDATION_ERROR",
            "imports must be a known ImportKind array or null",
            400,
            `${opPath}.imports`,
          );
        }
        break;
      }
      default: {
        // Exhaustiveness: assertValidOperation already rejects unknown ops.
        // Stable contract: no discriminator/request-value echo.
        throw new McpConfigError("UNKNOWN_OPERATION", "Unknown operation", 400, opPath);
      }
    }
  }

  // Final transport validation for all servers
  if (isRecord(nextRoot)) {
    const servers = getServersRecord(nextRoot);
    for (const [name, entry] of Object.entries(servers)) {
      if (!isRecord(entry)) {
        throw new McpConfigError("VALIDATION_ERROR", `Server ${name} must be an object`, 400, `mcpServers.${name}`);
      }
      assertExactlyOneTransport(entry, `mcpServers.${name}`);
    }
  }

  return nextRoot;
}

// ---------------------------------------------------------------------------
// JSONC surgical write
// ---------------------------------------------------------------------------

type JSONPath = Array<string | number>;

function jsoncModify(
  text: string,
  path: JSONPath,
  value: unknown,
): string {
  const edits = modify(text, path, value, {
    formattingOptions: {
      tabSize: 2,
      insertSpaces: true,
      eol: text.includes("\r\n") ? "\r\n" : "\n",
    },
    isArrayInsertion: false,
  });
  return applyEdits(text, edits);
}

/**
 * Rename an object property key in-place so nested comments/formatting survive.
 * Returns null when the property cannot be located (caller may fall back).
 */
function renameJsoncObjectKey(
  text: string,
  objectPath: JSONPath,
  from: string,
  to: string,
): string | null {
  if (from === to) return text;
  const tree = parseTree(text);
  if (!tree) return null;
  const valueNode = findNodeAtLocation(tree, [...objectPath, from]);
  const propertyNode = valueNode?.parent;
  const keyNode = propertyNode?.type === "property" ? propertyNode.children?.[0] : undefined;
  if (!keyNode || keyNode.type !== "string") return null;
  return (
    text.slice(0, keyNode.offset)
    + JSON.stringify(to)
    + text.slice(keyNode.offset + keyNode.length)
  );
}

/**
 * Sync a JSON value via field-level edits when both sides are plain objects so
 * nested comments and unknown sibling fields are preserved.
 */
function syncJsoncValue(
  text: string,
  path: JSONPath,
  existing: unknown,
  next: unknown,
): string {
  if (JSON.stringify(existing) === JSON.stringify(next)) return text;

  if (next === undefined) {
    return jsoncModify(text, path, undefined);
  }

  if (existing === undefined) {
    return jsoncModify(text, path, next);
  }

  if (isRecord(existing) && isRecord(next)) {
    let out = text;
    for (const key of Object.keys(existing)) {
      if (!Object.prototype.hasOwnProperty.call(next, key)) {
        out = jsoncModify(out, [...path, key], undefined);
      }
    }
    for (const [key, value] of Object.entries(next)) {
      out = syncJsoncValue(out, [...path, key], existing[key], value);
    }
    return out;
  }

  // Arrays/primitives/type changes: replace the whole node.
  return jsoncModify(text, path, next);
}

function readRootFromText(text: string): Record<string, unknown> {
  const parsed = parseConfigText(text);
  if (parsed.error || !isRecord(parsed.value)) return {};
  return ensureRootObject(parsed.value);
}

function writeObjectViaJsonc(
  originalText: string,
  nextRoot: Record<string, unknown>,
  options?: { renames?: Array<{ from: string; to: string }> },
): string {
  // Start from original text when possible to preserve comments on untouched regions.
  let text = originalText.trim() === "" ? "{\n}\n" : originalText;

  // Apply server renames first by rewriting only the property key text. This keeps
  // comments nested inside the renamed server object intact.
  for (const rename of options?.renames ?? []) {
    const currentRoot = readRootFromText(text);
    const serversKey = getServersKey(currentRoot);
    const renamed = renameJsoncObjectKey(text, [serversKey], rename.from, rename.to);
    if (renamed !== null) {
      text = renamed;
    }
  }

  const currentRoot = readRootFromText(text);
  const currentServersKey = getServersKey(currentRoot);
  const nextServers = isRecord(nextRoot.mcpServers)
    ? nextRoot.mcpServers
    : isRecord(nextRoot["mcp-servers"])
      ? nextRoot["mcp-servers"]
      : undefined;
  const currentServers = getServersRecord(currentRoot);

  // Delete removed servers
  for (const name of Object.keys(currentServers)) {
    if (!nextServers || !(name in nextServers)) {
      text = jsoncModify(text, [currentServersKey, name], undefined);
    }
  }

  // Upsert servers field-by-field so unknown fields & comments on other fields remain.
  if (nextServers) {
    // Ensure container exists
    if (
      !isRecord(currentRoot[currentServersKey])
      && currentRoot.mcpServers === undefined
      && currentRoot["mcp-servers"] === undefined
    ) {
      text = jsoncModify(text, ["mcpServers"], {});
    }
    const serversKey = (() => {
      const now = readRootFromText(text);
      return getServersKey(now);
    })();

    // Re-read current servers after renames/deletes for accurate field diffs.
    const serversNow = getServersRecord(readRootFromText(text));

    for (const [name, serverValue] of Object.entries(nextServers)) {
      if (!isRecord(serverValue)) continue;
      const existing = isRecord(serversNow[name]) ? (serversNow[name] as Record<string, unknown>) : undefined;
      if (!existing) {
        // New server: write whole object once
        text = jsoncModify(text, [serversKey, name], serverValue);
        continue;
      }
      text = syncJsoncValue(text, [serversKey, name], existing, serverValue);
    }
  } else if (isRecord(currentRoot.mcpServers) || isRecord(currentRoot["mcp-servers"])) {
    text = jsoncModify(text, [currentServersKey], undefined);
  }

  // settings: field-level (and nested object field-level) to keep comments
  const rootAfterServers = readRootFromText(text);
  const currentSettings = Object.prototype.hasOwnProperty.call(rootAfterServers, "settings")
    ? rootAfterServers.settings
    : undefined;
  const nextHasSettings = Object.prototype.hasOwnProperty.call(nextRoot, "settings");
  if (!nextHasSettings) {
    if (currentSettings !== undefined) {
      text = jsoncModify(text, ["settings"], undefined);
    }
  } else if (!isRecord(nextRoot.settings)) {
    if (JSON.stringify(currentSettings) !== JSON.stringify(nextRoot.settings)) {
      text = jsoncModify(text, ["settings"], nextRoot.settings);
    }
  } else if (!isRecord(currentSettings)) {
    text = jsoncModify(text, ["settings"], nextRoot.settings);
  } else {
    text = syncJsoncValue(text, ["settings"], currentSettings, nextRoot.settings);
  }

  // imports
  const rootAfterSettings = readRootFromText(text);
  if (!Object.prototype.hasOwnProperty.call(nextRoot, "imports")) {
    if (Object.prototype.hasOwnProperty.call(rootAfterSettings, "imports")) {
      text = jsoncModify(text, ["imports"], undefined);
    }
  } else if (JSON.stringify(rootAfterSettings.imports) !== JSON.stringify(nextRoot.imports)) {
    text = jsoncModify(text, ["imports"], nextRoot.imports);
  }

  // Preserve unknown root keys already present; do not invent removals.
  return text.endsWith("\n") ? text : `${text}\n`;
}

function atomicWriteFile(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.mcp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    writeFileSync(tmpPath, content, "utf8");
    renameSync(tmpPath, path);
  } catch (error) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw new McpConfigError(
      "IO_ERROR",
      `Failed to write MCP config: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// Write entry
// ---------------------------------------------------------------------------

export async function applyMcpConfigOperations(input: McpConfigWriteInput): Promise<McpConfigWriteResult> {
  if (!isWritableTargetId(input.targetId)) {
    throw new McpConfigError("INVALID_TARGET", `Invalid target: ${String(input.targetId)}`, 400);
  }
  if (typeof input.expectedRevision !== "string" || !input.expectedRevision.trim()) {
    throw new McpConfigError("VALIDATION_ERROR", "expectedRevision is required", 400, "expectedRevision");
  }

  let cwd: string | undefined;
  if (scopeForTarget(input.targetId) === "project") {
    cwd = await assertProjectCwdAuthorized(input.cwd);
  }

  const pathOptions: McpPathOptions = {
    cwd,
    agentDir: input.agentDir,
    homeDir: input.homeDir,
  };

  const path = getMcpTargetPath(input.targetId, pathOptions);
  assertResolvedPathIsTarget(input.targetId, path, pathOptions);

  const raw = readRawFile(path);
  const currentRevision = computeRevisionFromBytes(path, raw.text);
  if (currentRevision !== input.expectedRevision) {
    throw new McpConfigError(
      "REVISION_CONFLICT",
      `Revision mismatch: expected ${input.expectedRevision} but current file has ${currentRevision}`,
      409,
    );
  }

  let currentRoot: Record<string, unknown> = {};
  if (raw.exists && raw.text !== null && raw.text.trim() !== "") {
    const parsed = parseConfigText(raw.text);
    if (parsed.error) {
      throw new McpConfigError(
        "PARSE_ERROR",
        `MCP config cannot be modified while it has parse errors: ${parsed.error}`,
        409,
      );
    }
    currentRoot = ensureRootObject(parsed.value);
  }

  const nextRoot = applyOperationsToRoot(currentRoot, input.operations);
  const renames = input.operations.flatMap((operation) => {
    if (operation.op !== "renameServer") return [];
    if (operation.from === operation.to) return [];
    return [{ from: operation.from, to: operation.to }];
  });
  const nextText = writeObjectViaJsonc(raw.text ?? "{\n}\n", nextRoot, { renames });

  // Re-validate parse of output before writing
  const outParsed = parseConfigText(nextText);
  if (outParsed.error || !isRecord(outParsed.value)) {
    throw new McpConfigError("VALIDATION_ERROR", "Internal error: produced invalid JSONC", 500);
  }

  // Ensure secrets that should be preserved are still present byte-wise when ops said preserve.
  // (Covered by field-level edit path + smoke tests.)

  atomicWriteFile(path, nextText);

  const selected = readMcpTargetFile(input.targetId, pathOptions);
  return {
    selected,
    reloadRequired: true,
    sources: listMcpSourceSummaries(pathOptions),
    adapter: detectMcpAdapterPackage({ cwd, agentDir: input.agentDir }),
  };
}

/** Test helper: project without filesystem. */
export function projectMcpConfigFromText(text: string): {
  projection: McpConfigProjection;
  parseError?: string;
} {
  const parsed = parseConfigText(text);
  if (parsed.error) return { projection: { ...EMPTY_PROJECTION }, parseError: parsed.error };
  return { projection: projectMcpConfig(parsed.value) };
}

/**
 * Choose the revision for a save/reapply PUT.
 * After conflict recovery, pass the freshly loaded revision so the request does
 * not reuse a stale React state closure value.
 */
export function resolveMcpSaveRevision(options: {
  stateRevision: string;
  loadedRevision?: string | null;
}): string {
  if (typeof options.loadedRevision === "string" && options.loadedRevision.trim()) {
    return options.loadedRevision;
  }
  return options.stateRevision;
}

/** Parse scope query values; distinguish missing from explicitly invalid. */
export function parseMcpScopeQuery(value: string | null | undefined): {
  scope: McpScope | null;
  invalid: boolean;
} {
  if (value === null || value === undefined || value === "") {
    return { scope: null, invalid: false };
  }
  if (value === "user" || value === "project") {
    return { scope: value, invalid: false };
  }
  return { scope: null, invalid: true };
}

/** Test helper exposing path list without authorization. */
export function resolveAllMcpPaths(options: McpPathOptions = {}): Record<McpSourceId, string> {
  const cwd = options.cwd ? canonicalizeCwd(options.cwd) : undefined;
  return {
    "user-shared": getMcpTargetPath("user-shared", options),
    "user-pi": getMcpTargetPath("user-pi", options),
    "project-shared": getMcpTargetPath("project-shared", { ...options, cwd }),
    "project-pi": getMcpTargetPath("project-pi", { ...options, cwd }),
    "agents-global": getReadOnlySourcePath("agents-global", options.homeDir),
    "agents-nested-global": getReadOnlySourcePath("agents-nested-global", options.homeDir),
  };
}
