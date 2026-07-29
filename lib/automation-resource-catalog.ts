/**
 * Headless-oriented resource catalog descriptors.
 * Describes tools/extensions without importing unapproved extension factories.
 */

import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import type {
  AutomationExtensionSourceSnapshot,
  AutomationToolOrigin,
  AutomationToolRiskFlags,
  AutomationToolSnapshot,
} from "./automation-types";

export type CatalogToolDescriptor = {
  name: string;
  description: string;
  origin: AutomationToolOrigin;
  sourcePath?: string;
  sourceIdentity: string;
  schema: unknown;
  risks: AutomationToolRiskFlags;
  credentialHandles?: string[];
  extensionSourceIdentity?: string;
};

export type CatalogExtensionDescriptor = {
  sourceIdentity: string;
  sourcePath: string;
  hookInventory: string[];
  tools: string[];
};

const BUILTIN_READONLY = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "list_files", // alias safety
]);

const BUILTIN_MUTATION = new Set(["write", "edit"]);

const ALWAYS_BLOCKED = new Set([
  "bash",
  "subprocess",
  "automation_tasks",
  "ask_user",
  "browser",
  "browser_action",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "browser_console",
]);

// Reviewed web tools live in the immutable registry (automation-reviewed-web-tools).
// Name-only membership is not sufficient for execution — digests must match.

export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hashJson(value: unknown): string {
  return hashContent(JSON.stringify(value));
}

export function sourceIdentityForPath(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, "/");
  return `path:${normalized}`;
}

/**
 * Deterministic file or directory closure digest.
 * Directories include every regular file under the root (sorted relative paths),
 * including package entry/dist/lock/deps — never size/mtime-only, never blind
 * exclusion of dist/node_modules at the digest layer.
 */
export function hashPathClosure(rootPath: string): string {
  if (!existsSync(rootPath)) return hashContent(`missing:${rootPath}`);
  let st;
  try {
    st = statSync(rootPath);
  } catch {
    return hashContent(`unreadable-stat:${rootPath}`);
  }
  if (st.isFile()) {
    try {
      return hashContent(readFileSync(rootPath));
    } catch {
      return hashContent(`unreadable:${rootPath}:${st.size}`);
    }
  }
  if (!st.isDirectory()) {
    return hashContent(`unsupported-type:${rootPath}`);
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      // Skip VCS only — keep dist/node_modules/lockfiles so executable closure is real.
      if (name === ".git" || name === ".hg" || name === ".svn") continue;
      const full = path.join(dir, name);
      let child;
      try {
        child = statSync(full);
      } catch {
        continue;
      }
      if (child.isDirectory()) walk(full);
      else if (child.isFile()) files.push(full);
    }
  };
  walk(rootPath);
  files.sort((a, b) => a.replace(/\\/g, "/").localeCompare(b.replace(/\\/g, "/")));
  const h = createHash("sha256");
  // Content-only closure: relative paths + bytes (no absolute root) so authorize/stage/extract match.
  h.update("dir-closure:v2\0");
  for (const f of files) {
    const rel = f.slice(rootPath.length).replace(/\\/g, "/").replace(/^\//, "");
    h.update(rel);
    h.update("\0");
    try {
      h.update(readFileSync(f));
    } catch {
      h.update(`unreadable:${rel}`);
    }
    h.update("\0");
  }
  return h.digest("hex");
}

/** @deprecated Prefer hashPathClosure — kept as alias for file-or-dir sources. */
export function digestFile(filePath: string): string {
  return hashPathClosure(filePath);
}

/** Directory-only helper used by worker staging (same algorithm as hashPathClosure). */
export function hashDirectoryClosure(root: string): string {
  return hashPathClosure(root);
}

export function classifyBuiltinTool(name: string): AutomationToolRiskFlags {
  if (ALWAYS_BLOCKED.has(name)) {
    return {
      headlessCompatible: false,
      localMutation: name === "bash" || name === "subprocess",
      networkEgress: false,
      credentialUse: false,
      interactionRequired: name === "ask_user",
      blocked: true,
      blockedReason:
        name === "bash" || name === "subprocess"
          ? "unrestricted_subprocess_forbidden"
          : name === "automation_tasks"
            ? "automation_mutation_tool_forbidden"
            : name.startsWith("browser")
              ? "browser_bound_tool_forbidden"
              : "interactive_tool_forbidden",
    };
  }
  if (BUILTIN_READONLY.has(name)) {
    return {
      headlessCompatible: true,
      localMutation: false,
      networkEgress: false,
      credentialUse: false,
      interactionRequired: false,
      blocked: false,
    };
  }
  if (BUILTIN_MUTATION.has(name)) {
    return {
      headlessCompatible: true,
      localMutation: true,
      networkEgress: false,
      credentialUse: false,
      interactionRequired: false,
      blocked: false,
    };
  }
  return {
    headlessCompatible: false,
    localMutation: false,
    networkEgress: false,
    credentialUse: false,
    interactionRequired: false,
    blocked: true,
    blockedReason: "unknown_builtin_not_reviewed",
  };
}

export type ClassifyExtensionToolOptions = {
  /**
   * Exact immutable closure digest is in the trusted reviewed registry AND production
   * discovery returned actual tool/schema/hook registrations. Such tools are headless-
   * compatible authority candidates (still subject to digest/schema/hook preflight).
   */
  reviewedActual?: boolean;
};

/**
 * Canonical reviewed-actual schema identity shared by authorize-time snapshots and
 * live catalog/preflight. Field set/order must stay stable so schemaHash matches.
 */
export function buildReviewedActualToolSchema(input: {
  name: string;
  description?: string | null;
  parameters?: unknown;
  packageClosure?: string[] | null;
  hooks?: string[] | null;
  entry?: string | null;
  bundleSha256?: string | null;
  closureDigest: string;
}): {
  name: string;
  description: string;
  parameters: unknown;
  packageClosure: string[];
  hooks: string[];
  entry: string;
  bundleSha256: string;
  closureDigest: string;
  catalogMode: "reviewed_actual";
} {
  return {
    name: input.name,
    description: input.description ?? "",
    parameters: input.parameters ?? {},
    packageClosure: [...(input.packageClosure ?? [])].sort(),
    hooks: [...(input.hooks ?? [])].sort(),
    entry: input.entry ?? "",
    bundleSha256: input.bundleSha256 ?? "",
    closureDigest: input.closureDigest.toLowerCase(),
    catalogMode: "reviewed_actual",
  };
}

export function classifyExtensionTool(
  name: string,
  sourcePath?: string,
  options?: ClassifyExtensionToolOptions,
): AutomationToolRiskFlags {
  if (ALWAYS_BLOCKED.has(name)) {
    return classifyBuiltinTool(name);
  }
  if (options?.reviewedActual) {
    // Reviewed actual registration: allow headless authorization. Risk dims stay
    // conservative (extensions may touch fs/network) but are not hard-blocked.
    return {
      headlessCompatible: true,
      localMutation: true,
      networkEgress: true,
      credentialUse: false,
      interactionRequired: false,
      blocked: false,
    };
  }
  // Unknown extensions are blocked in v1. Name-only web tools without registry digest are blocked.
  return {
    headlessCompatible: false,
    localMutation: true,
    networkEgress: true,
    credentialUse: true,
    interactionRequired: false,
    blocked: true,
    blockedReason: sourcePath ? "unknown_extension_forbidden" : "unknown_tool_forbidden",
  };
}

function resolvePiCodingAgentPackageRoot(): string | null {
  const candidates = [
    path.join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent"),
    path.join(__dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent"),
  ];
  for (const c of candidates) {
    if (existsSync(path.join(c, "package.json"))) return c;
  }
  return null;
}

/** Absolute path to a builtin tool's actual executable implementation bytes. */
export function builtinToolExecutablePath(name: string): string | null {
  const root = resolvePiCodingAgentPackageRoot();
  if (!root) return null;
  const candidate = path.join(root, "dist", "core", "tools", `${name}.js`);
  return existsSync(candidate) ? candidate : null;
}

/**
 * Package/implementation digest for builtin tools so SDK upgrades force reauthorization.
 * Hashes actual executable tool module bytes (not size/mtime) plus package identity.
 * Uses filesystem reads only — never require() of package exports — so Next/webpack stays clean.
 */
export function builtinSdkImplementationDigest(toolName?: string): string {
  try {
    const pkgRoot = resolvePiCodingAgentPackageRoot();
    if (!pkgRoot) return hashContent("sdk:pi-coding-agent:unknown");
    const pkgPath = path.join(pkgRoot, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
    const parts: string[] = [`sdk:${pkg.name ?? "pi-coding-agent"}@${pkg.version ?? "?"}`];
    // Always bind package.json bytes.
    parts.push(`pkgjson=${hashContent(readFileSync(pkgPath))}`);
    if (toolName) {
      const toolPath = builtinToolExecutablePath(toolName);
      if (toolPath) {
        parts.push(`tool:${toolName}=${hashContent(readFileSync(toolPath))}`);
      } else {
        // Fall back to tools index bytes when per-tool file is missing.
        const indexPath = path.join(pkgRoot, "dist", "core", "tools", "index.js");
        if (existsSync(indexPath)) {
          parts.push(`tools-index=${hashContent(readFileSync(indexPath))}`);
        }
      }
    } else {
      const toolsDir = path.join(pkgRoot, "dist", "core", "tools");
      if (existsSync(toolsDir)) {
        parts.push(`tools-closure=${hashPathClosure(toolsDir)}`);
      }
    }
    return hashContent(parts.join(":"));
  } catch {
    return hashContent("sdk:pi-coding-agent:unknown");
  }
}

export function buildToolSnapshot(input: {
  name: string;
  description?: string;
  origin: AutomationToolOrigin;
  sourcePath?: string;
  schema?: unknown;
  hookInventory?: string[];
  config?: unknown;
  credentialHandles?: string[];
  risks?: AutomationToolRiskFlags;
}): AutomationToolSnapshot {
  const risks =
    input.risks ??
    (input.origin === "builtin"
      ? classifyBuiltinTool(input.name)
      : classifyExtensionTool(input.name, input.sourcePath));
  const schema = input.schema ?? { name: input.name };
  const schemaHash = hashJson(schema);
  const configHash = hashJson(input.config ?? {});
  const sourceIdentity = input.sourcePath
    ? sourceIdentityForPath(input.sourcePath)
    : `builtin:${input.name}`;
  // Builtin identity must bind schema + SDK package digest so SDK tool changes
  // invalidate frozen authority snapshots (not name-only).
  const executableDigest = input.sourcePath
    ? hashPathClosure(input.sourcePath)
    : hashContent(
        `builtin:${input.name}:schema=${schemaHash}:cfg=${configHash}:impl=${builtinSdkImplementationDigest(input.name)}`,
      );
  return {
    name: input.name,
    origin: input.origin,
    description: input.description,
    sourceIdentity,
    sourcePath: input.sourcePath,
    executableDigest,
    schemaHash,
    configHash,
    hookInventory: input.hookInventory,
    risks,
    credentialHandles: input.credentialHandles,
  };
}

export function buildExtensionSnapshot(input: {
  sourcePath: string;
  hookInventory?: string[];
  config?: unknown;
}): AutomationExtensionSourceSnapshot {
  const sourcePath = path.resolve(input.sourcePath);
  // One consistent file/package closure digest for authorize → stage → verify → import.
  return {
    sourceIdentity: sourceIdentityForPath(sourcePath),
    sourcePath,
    executableDigest: hashPathClosure(sourcePath),
    hookInventory: input.hookInventory ?? [],
    configHash: hashJson(input.config ?? {}),
  };
}

/**
 * Build a static catalog from declared descriptors (no extension import).
 * Live Pi resource discovery is layered by callers that already loaded safely.
 */
export function buildStaticCatalog(descriptors: CatalogToolDescriptor[]): {
  tools: AutomationToolSnapshot[];
  extensions: AutomationExtensionSourceSnapshot[];
} {
  const tools = descriptors.map((d) =>
    buildToolSnapshot({
      name: d.name,
      description: d.description,
      origin: d.origin,
      sourcePath: d.sourcePath,
      schema: d.schema,
      risks: d.risks,
      credentialHandles: d.credentialHandles,
    }),
  );
  const extMap = new Map<string, AutomationExtensionSourceSnapshot>();
  for (const d of descriptors) {
    if (d.origin === "extension" && d.sourcePath) {
      const snap = buildExtensionSnapshot({ sourcePath: d.sourcePath });
      extMap.set(snap.sourceIdentity, snap);
    }
  }
  return { tools, extensions: [...extMap.values()] };
}

/**
 * Fallback schemas used only when SDK tool constructors are unavailable.
 * Prefer loadActualBuiltinToolSchemas() which reads live Tool.parameters.
 */
const BUILTIN_TOOL_SCHEMA_FALLBACK: Record<string, unknown> = {
  read: {
    name: "read",
    parameters: { path: "string", offset: "number?", limit: "number?" },
  },
  grep: {
    name: "grep",
    parameters: { pattern: "string", path: "string?", glob: "string?" },
  },
  find: {
    name: "find",
    parameters: { pattern: "string", path: "string?" },
  },
  ls: {
    name: "ls",
    parameters: { path: "string?" },
  },
  write: {
    name: "write",
    parameters: { path: "string", content: "string" },
  },
  edit: {
    name: "edit",
    parameters: { path: "string", oldText: "string", newText: "string" },
  },
  bash: {
    name: "bash",
    parameters: { command: "string" },
  },
};

let cachedActualBuiltinSchemas: Record<string, unknown> | null = null;
let actualBuiltinSchemasLoad: Promise<Record<string, unknown>> | null = null;

type SdkToolLike = { name: string; description?: string; parameters?: unknown };
type SdkToolModule = {
  createCodingTools?: (cwd: string) => SdkToolLike[];
  createReadTool?: (cwd: string) => SdkToolLike;
  createWriteTool?: (cwd: string) => SdkToolLike;
  createEditTool?: (cwd: string) => SdkToolLike;
  createBashTool?: (cwd: string) => SdkToolLike;
  createGrepTool?: (cwd: string) => SdkToolLike;
  createFindTool?: (cwd: string) => SdkToolLike;
  createLsTool?: (cwd: string) => SdkToolLike;
};

function collectSdkTool(
  out: Record<string, unknown>,
  tool: SdkToolLike | null | undefined,
): void {
  if (!tool?.name) return;
  out[tool.name] = {
    name: tool.name,
    description: tool.description ?? `Builtin tool ${tool.name}`,
    parameters: tool.parameters ?? BUILTIN_TOOL_SCHEMA_FALLBACK[tool.name] ?? { name: tool.name },
  };
}

function applySdkToolModule(toolsMod: SdkToolModule): Record<string, unknown> {
  const out: Record<string, unknown> = { ...BUILTIN_TOOL_SCHEMA_FALLBACK };
  const cwd = process.cwd();
  if (typeof toolsMod.createCodingTools === "function") {
    try {
      for (const t of toolsMod.createCodingTools(cwd) ?? []) collectSdkTool(out, t);
    } catch {
      // fall through to individual constructors
    }
  }
  const singles: Array<[(cwd: string) => SdkToolLike, string]> = [];
  if (typeof toolsMod.createReadTool === "function") singles.push([toolsMod.createReadTool, "read"]);
  if (typeof toolsMod.createGrepTool === "function") singles.push([toolsMod.createGrepTool, "grep"]);
  if (typeof toolsMod.createFindTool === "function") singles.push([toolsMod.createFindTool, "find"]);
  if (typeof toolsMod.createLsTool === "function") singles.push([toolsMod.createLsTool, "ls"]);
  if (typeof toolsMod.createWriteTool === "function") singles.push([toolsMod.createWriteTool, "write"]);
  if (typeof toolsMod.createEditTool === "function") singles.push([toolsMod.createEditTool, "edit"]);
  if (typeof toolsMod.createBashTool === "function") singles.push([toolsMod.createBashTool, "bash"]);
  for (const [fn, name] of singles) {
    if (out[name] && out[name] !== BUILTIN_TOOL_SCHEMA_FALLBACK[name]) continue;
    try {
      collectSdkTool(out, fn(cwd));
    } catch {
      // keep fallback for this tool only
    }
  }
  return out;
}

/**
 * Async ESM import of actual SDK builtin tool definitions (supported path).
 * Never uses sync require() against the ESM package export.
 */
export async function loadActualBuiltinToolSchemasAsync(): Promise<Record<string, unknown>> {
  if (cachedActualBuiltinSchemas && !isFallbackOnlySchemaCache(cachedActualBuiltinSchemas)) {
    return cachedActualBuiltinSchemas;
  }
  if (!actualBuiltinSchemasLoad) {
    actualBuiltinSchemasLoad = (async () => {
      try {
        const toolsMod = (await import("@earendil-works/pi-coding-agent")) as SdkToolModule;
        const out = applySdkToolModule(toolsMod);
        cachedActualBuiltinSchemas = out;
        return out;
      } catch {
        const fallback = { ...BUILTIN_TOOL_SCHEMA_FALLBACK };
        cachedActualBuiltinSchemas = fallback;
        return fallback;
      } finally {
        // Allow retry after failure so later calls can pick up a warm cache.
        actualBuiltinSchemasLoad = null;
      }
    })();
  }
  return actualBuiltinSchemasLoad;
}

function isFallbackOnlySchemaCache(cache: Record<string, unknown>): boolean {
  // Actual SDK schemas include TypeBox-like `type:"object"` parameter trees.
  const read = cache.read;
  if (!read || typeof read !== "object") return true;
  const params = (read as { parameters?: unknown }).parameters;
  if (!params || typeof params !== "object") return true;
  return !("type" in (params as object) || "properties" in (params as object));
}

/**
 * Sync accessor: returns cached actual SDK schemas when previously loaded async,
 * otherwise filesystem-derived schema stubs bound to real executable digests.
 * Callers that need guaranteed live SDK schemas should await loadActualBuiltinToolSchemasAsync().
 */
export function loadActualBuiltinToolSchemas(): Record<string, unknown> {
  if (cachedActualBuiltinSchemas) return cachedActualBuiltinSchemas;
  // Kick off background ESM load (no sync require of package exports).
  void loadActualBuiltinToolSchemasAsync();
  // Filesystem-bound interim schemas: still hash real tool executable bytes via buildToolSnapshot.
  const interim: Record<string, unknown> = { ...BUILTIN_TOOL_SCHEMA_FALLBACK };
  for (const name of Object.keys(BUILTIN_TOOL_SCHEMA_FALLBACK)) {
    const execPath = builtinToolExecutablePath(name);
    interim[name] = {
      ...(interim[name] as object),
      executablePath: execPath,
      // Mark interim so tests can detect upgrade to actual SDK schema.
      source: execPath ? "filesystem-interim" : "fallback",
    };
  }
  // Do not permanently cache interim as "actual" — keep null so async load can replace.
  return interim;
}

/** Test helper: clear cached actual schemas. */
export function clearBuiltinSchemaCache(): void {
  cachedActualBuiltinSchemas = null;
  actualBuiltinSchemasLoad = null;
}

function catalogFromSchemas(schemas: Record<string, unknown>): CatalogToolDescriptor[] {
  const names = ["read", "grep", "find", "ls", "write", "edit", "bash"];
  return names.map((name) => {
    const schema = schemas[name] ?? BUILTIN_TOOL_SCHEMA_FALLBACK[name] ?? { name };
    const description =
      schema && typeof schema === "object" && "description" in (schema as object)
        ? String((schema as { description?: string }).description ?? `Builtin tool ${name}`)
        : `Builtin tool ${name}`;
    return {
      name,
      description,
      origin: "builtin" as const,
      sourceIdentity: `builtin:${name}`,
      // Bind actual loaded parameter schema + SDK package/entry digest — not name-only.
      schema,
      risks: classifyBuiltinTool(name),
    };
  });
}

export function defaultBuiltinCatalog(): CatalogToolDescriptor[] {
  return catalogFromSchemas(loadActualBuiltinToolSchemas());
}

/** Awaitable catalog using actual SDK tool constructors (ESM). */
export async function defaultBuiltinCatalogAsync(): Promise<CatalogToolDescriptor[]> {
  const schemas = await loadActualBuiltinToolSchemasAsync();
  return catalogFromSchemas(schemas);
}

/** Full default Automation catalog: safe builtins + reviewed web tools. */
export function defaultAutomationCatalog(): CatalogToolDescriptor[] {
  // Dynamic import path avoided here for sync callers; reviewed-web is a local module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { listReviewedWebCatalogDescriptors } = require("./automation-reviewed-web-tools") as typeof import("./automation-reviewed-web-tools");
  const web = listReviewedWebCatalogDescriptors().map((d) => ({
    name: d.name,
    description: d.description,
    origin: d.origin,
    sourceIdentity: d.sourceIdentity,
    schema: d.schema,
    risks: d.risks,
  }));
  return [
    ...defaultBuiltinCatalog().filter((t) => !t.risks.blocked),
    ...web,
  ];
}

export async function defaultAutomationCatalogAsync(): Promise<CatalogToolDescriptor[]> {
  const { listReviewedWebCatalogDescriptors } = await import("./automation-reviewed-web-tools");
  const web = listReviewedWebCatalogDescriptors().map((d) => ({
    name: d.name,
    description: d.description,
    origin: d.origin,
    sourceIdentity: d.sourceIdentity,
    schema: d.schema,
    risks: d.risks,
  }));
  const builtins = (await defaultBuiltinCatalogAsync()).filter((t) => !t.risks.blocked);
  return [...builtins, ...web];
}

/**
 * Discover catalog descriptors from an already-constructed AgentSession-like object.
 * Does not create sessions itself.
 */
export function catalogFromSessionTools(
  tools: Array<{ name: string; description?: string; sourceInfo?: { path?: string; source?: string } }>,
): CatalogToolDescriptor[] {
  return tools.map((tool) => {
    const sourcePath = tool.sourceInfo?.path;
    const origin: AutomationToolOrigin = sourcePath
      ? "extension"
      : tool.sourceInfo?.source === "custom"
        ? "custom"
        : "builtin";
    const risks =
      origin === "builtin" ? classifyBuiltinTool(tool.name) : classifyExtensionTool(tool.name, sourcePath);
    return {
      name: tool.name,
      description: tool.description ?? "",
      origin,
      sourcePath,
      sourceIdentity: sourcePath ? sourceIdentityForPath(sourcePath) : `builtin:${tool.name}`,
      schema: { name: tool.name, description: tool.description ?? "" },
      risks,
    };
  });
}

/** Reviewed registry entries for first-party web tools (immutable registry, not name-only). */
export function isReviewedWebToolName(name: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isReviewedWebRegistryName } = require("./automation-reviewed-web-tools") as typeof import("./automation-reviewed-web-tools");
  return isReviewedWebRegistryName(name);
}

export function isAlwaysBlockedToolName(name: string): boolean {
  return ALWAYS_BLOCKED.has(name);
}
