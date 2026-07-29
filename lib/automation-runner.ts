/**
 * Headless Automation runner: awaited prompt, hard outer deadline/abort/dispose,
 * pre-import extension allowlist, no interactive UI waits.
 * Session is sealed only after dispose/session_shutdown/drain complete.
 */

import { createHash } from "crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { fork, type ChildProcess } from "child_process";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { createFileChangeObserver } from "./agent-session-observer";
import { createAgentSessionWithServices, type AgentSessionLike } from "./agent-session-services";
import { getAutomationRoot, getAutomationTaskSessionDir } from "./automation-paths";
import {
  createApprovedExtensionPathAllowlist,
  filterExtensionsBeforeImport,
  type EffectivePermissions,
} from "./automation-tool-policy";
import { buildRunnerEnv, redactSecrets, redactUnknown } from "./automation-secret-policy";
import { createAutomationReviewedWebTools } from "./automation-reviewed-web-tools";
import { disposeAgentSession } from "./pi-session-lifecycle";
import type {
  AutomationRunRecord,
  AutomationRunUsage,
  AutomationSessionRef,
  AutomationTaskConfig,
} from "./automation-types";
import type {
  WorkerExtensionArtifact,
  WorkerJob,
  WorkerReviewedWebTool,
} from "./automation-worker-protocol";
import {
  deriveMaxOutputTokens,
  estimatePromptTokens,
  hashDirectoryClosure,
} from "./automation-worker-protocol";
import { hashPathClosure } from "./automation-resource-catalog";
import {
  classifySessionOutcome,
  recordSpentTokens,
  wrapStreamFnWithTokenBudget,
  type TokenBudgetState,
} from "./automation-token-budget";

export type HeadlessUiRequest =
  | { type: "confirm"; message: string }
  | { type: "select"; message: string; options: unknown[] }
  | { type: "input"; message: string }
  | { type: "editor"; message: string };

export class AutomationInteractionRequiredError extends Error {
  readonly code = "blocked" as const;
  readonly blockedReason = "interaction_required" as const;

  constructor(message = "Headless automation cannot satisfy interactive UI request") {
    super(message);
    this.name = "AutomationInteractionRequiredError";
  }
}

export class AutomationDeadlineError extends Error {
  readonly code = "timeout" as const;

  constructor(message: string) {
    super(message);
    this.name = "AutomationDeadlineError";
  }
}

export type LateSettlementHandle = {
  /** Resolves when the isolated worker/session is known dead or the prompt settles. */
  waitUntilSettledOrDead: () => Promise<Partial<AutomationRunnerResult> | null>;
  /** Best-effort kill of the isolated worker/process. */
  forceKill: () => Promise<void>;
  /** True when the worker process (if any) has exited. */
  isDead: () => boolean;
};

export type AutomationRunnerResult = {
  status: "succeeded" | "failed" | "timed_out" | "cancelled" | "blocked" | "ambiguous";
  summary: string | null;
  errorCategory: string | null;
  errorMessage: string | null;
  usage: AutomationRunUsage | null;
  actualModel: AutomationRunRecord["actualModel"];
  session: AutomationSessionRef;
  sideEffectsStarted: boolean;
  /**
   * When true, model/tool execution may still be running after return (abort ignored).
   * Caller MUST retain lease + registry authority only until verified death/expiry,
   * register late-settlement finalization, and never heartbeat forever.
   */
  executionMayContinue?: boolean;
  lateSettlement?: LateSettlementHandle;
};

export type AutomationRunnerDeps = {
  createSession?: typeof defaultCreateSession;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type CreatedSession = {
  session: AgentSessionLike & {
    setModel?: (model: unknown) => Promise<void>;
    setThinkingLevel?: (level: string) => void | Promise<void>;
    modelRuntime?: { getModel?: (provider: string, modelId: string) => unknown };
    model?: { id?: string; provider?: string } | null;
    thinkingLevel?: string;
    getTokenUsage?: () => unknown;
    getSessionStats?: () => {
      tokens?: { input?: number; output?: number; total?: number };
      cost?: number;
      toolCalls?: number;
    };
    usage?: unknown;
  };
  sessionDir: string;
  unsubscribe?: () => void;
  appliedModel: { provider: string; modelId: string; thinking: string | null };
  runnerEnv?: NodeJS.ProcessEnv;
  /** Detached prompt promise when abort is ignored (for late-settle fencing). */
  pendingPrompt?: Promise<unknown>;
};

const OUTER_DEADLINE_GRACE_MS = 2_000;
const DRAIN_MS = 1_500;

async function defaultCreateSession(input: {
  cwd: string;
  sessionDir: string;
  effective: EffectivePermissions;
  model: { provider: string; modelId: string; thinking?: string | null };
  promptPrelude: string;
  runnerEnv: NodeJS.ProcessEnv;
  /** Optional hard ceiling applied to model.maxTokens when supported. */
  maxTokensPerRun?: number;
  /** Derived max output tokens (remaining budget after estimated input). */
  maxOutputTokens?: number;
}): Promise<CreatedSession> {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const agentDir = sdk.getAgentDir();
  const settingsManager = sdk.SettingsManager.create(input.cwd, agentDir);

  // Load factories exclusively from verified in-memory bundle bytes (no extract→import).
  // webpackIgnore keeps createRequire out of the Next server bundle; runtime resolves via Node.
  const staged = stageExtensionArtifacts(input.effective.extensions);
  const { loadFactoryFromVerifiedBundleBytes } = await import(
    /* webpackIgnore: true */ "./automation-extension-runtime"
  );
  const extensionFactories: Array<{ name: string; factory: never }> = [];
  for (const [index, art] of staged.entries()) {
    const bundleBytes = Buffer.from(art.bundleBytesBase64, "base64");
    const loaded = loadFactoryFromVerifiedBundleBytes(bundleBytes, art.bundleSha256);
    extensionFactories.push({
      name: `automation-verified-${index}-${art.bundleSha256.slice(0, 12)}`,
      factory: loaded.factory as never,
    });
  }
  void createApprovedExtensionPathAllowlist;
  void filterExtensionsBeforeImport;
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: input.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths: [],
    extensionFactories: extensionFactories as never,
    extensionsOverride: ((base: { extensions: Array<{ path: string }> }) => ({
      ...base,
      extensions: (base.extensions ?? []).filter((e) => {
        const p = e.path ?? "";
        return p.startsWith("<inline:") || p.includes("automation-verified-");
      }),
    })) as never,
  });
  await resourceLoader.reload();

  // Fail closed: ensure no unapproved filesystem extensions remain.
  const loaded = resourceLoader.getExtensions?.() as { extensions?: Array<{ path: string }> } | undefined;
  const remaining = loaded?.extensions ?? [];
  for (const ext of remaining) {
    const p = ext.path ?? "";
    if (!(p.startsWith("<inline:") || p.includes("automation-verified-"))) {
      throw new Error(`Unapproved extension loaded: ${ext.path}`);
    }
  }

  mkdirSync(input.sessionDir, { recursive: true });
  const sessionManager = sdk.SessionManager.create(input.cwd, input.sessionDir);

  const toolNames = input.effective.tools.map((t) => t.name);
  const requestedWeb = input.effective.tools.filter(
    (t) => t.name === "web_search" || t.name === "web_fetch",
  );
  // Exact registry match required — createAutomationReviewedWebTools throws on drift.
  const reviewedWeb = createAutomationReviewedWebTools(requestedWeb);
  if (reviewedWeb.length !== requestedWeb.length) {
    throw new Error(
      `Reviewed web tools failed exact registry match (refusing silent drop): requested=${requestedWeb.map((t) => t.name).join(",")}`,
    );
  }

  const { session } = await createAgentSessionWithServices({
    cwd: input.cwd,
    agentDir,
    sessionManager,
    resourceLoader,
    tools: toolNames.length ? toolNames : [],
    customTools: reviewedWeb.length ? reviewedWeb : undefined,
    settingsManager,
  });

  // Apply provider/model/thinking explicitly and report actual values.
  let appliedModel = {
    provider: input.model.provider,
    modelId: input.model.modelId,
    thinking: input.model.thinking ?? null,
  };
  try {
    const runtime = (session as CreatedSession["session"]).modelRuntime;
    const model =
      runtime?.getModel?.(input.model.provider, input.model.modelId) ??
      // Some SDK builds expose getModel on session directly via modelRuntime after create.
      undefined;
    if (model && typeof (session as CreatedSession["session"]).setModel === "function") {
      // Hard request-level output ceiling (remaining budget after estimated input).
      const maxOut =
        (input as { maxOutputTokens?: number }).maxOutputTokens ?? input.maxTokensPerRun;
      if (maxOut && maxOut > 0 && typeof model === "object") {
        const m = model as {
          maxTokens?: number;
          request?: { max_tokens?: number; maxTokens?: number };
        };
        if (typeof m.maxTokens === "number") {
          m.maxTokens = Math.min(m.maxTokens, maxOut);
        } else {
          m.maxTokens = maxOut;
        }
        if (m.request && typeof m.request === "object") {
          if (typeof m.request.max_tokens === "number") {
            m.request.max_tokens = Math.min(m.request.max_tokens, maxOut);
          } else {
            m.request.max_tokens = maxOut;
          }
        }
      }
      await (session as CreatedSession["session"]).setModel!(model);
    }
    if (
      input.model.thinking &&
      typeof (session as CreatedSession["session"]).setThinkingLevel === "function"
    ) {
      await (session as CreatedSession["session"]).setThinkingLevel!(input.model.thinking);
    }
    const live = session as CreatedSession["session"];
    appliedModel = {
      provider: live.model?.provider ?? appliedModel.provider,
      modelId: live.model?.id ?? appliedModel.modelId,
      thinking: (live.thinkingLevel as string | undefined) ?? appliedModel.thinking,
    };
  } catch (error) {
    throw new Error(
      `Failed to apply model ${input.model.provider}/${input.model.modelId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Headless UI: any interaction fails immediately.
  const headlessUi = {
    confirm: async () => {
      throw new AutomationInteractionRequiredError("confirm");
    },
    select: async () => {
      throw new AutomationInteractionRequiredError("select");
    },
    input: async () => {
      throw new AutomationInteractionRequiredError("input");
    },
    editor: async () => {
      throw new AutomationInteractionRequiredError("editor");
    },
  };

  if (session.bindExtensions) {
    // SDK contract: uiContext (not ui) for print/headless binding.
    await session.bindExtensions({
      mode: "print",
      uiContext: headlessUi,
    });
  }

  if (session.setActiveToolsByName) {
    session.setActiveToolsByName(toolNames);
  }

  // Hard total-token budget at streamFn boundary (multi-turn tool loops included).
  const maxTokens = input.maxTokensPerRun ?? 0;
  if (maxTokens > 0) {
    const s = session as AgentSessionLike & {
      agent?: {
        streamFunction?: (model: unknown, context: unknown, opts?: Record<string, unknown>) => unknown;
      };
    };
    if (s.agent && typeof s.agent.streamFunction === "function") {
      const budgetState: TokenBudgetState = { maxTokensPerRun: maxTokens, spentTokens: 0, reservedTokens: 0 };
      (s as { __tokenBudgetState?: TokenBudgetState }).__tokenBudgetState = budgetState;
      const base = s.agent.streamFunction.bind(s.agent) as (
        model: unknown,
        context: unknown,
        opts?: Record<string, unknown>,
      ) => unknown;
      s.agent.streamFunction = wrapStreamFnWithTokenBudget(base, budgetState);
    }
  }

  let unsubscribe: (() => void) | undefined;
  if (session.subscribe && session.sessionId) {
    const observer = createFileChangeObserver({
      sessionId: session.sessionId,
      cwd: input.cwd,
      sessionFile: session.sessionFile,
    });
    unsubscribe = session.subscribe((event) => observer.onEvent(event));
  }

  return {
    session: session as CreatedSession["session"],
    sessionDir: input.sessionDir,
    unsubscribe,
    appliedModel,
    runnerEnv: input.runnerEnv,
  };
}

function findJsonl(sessionDir: string): string | null {
  if (!existsSync(sessionDir)) return null;
  const stack = [sessionDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) stack.push(full);
        else if (name.endsWith(".jsonl")) return full;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function sealSessionFile(sessionFile: string | null): AutomationSessionRef["seal"] {
  if (!sessionFile || !existsSync(sessionFile)) return null;
  const buf = readFileSync(sessionFile);
  const text = buf.toString("utf8");
  const entryCount = text.split(/\r?\n/).filter((l) => l.trim()).length;
  return {
    size: buf.byteLength,
    sha256: createHash("sha256").update(buf).digest("hex"),
    entryCount,
    sealedAt: new Date().toISOString(),
  };
}

function summarizeResult(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return redactSecrets(value).slice(0, 4000);
  try {
    return redactSecrets(JSON.stringify(redactUnknown(value))).slice(0, 4000);
  } catch {
    return "[unserializable result]";
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Race a promise against a hard outer deadline that settles even if abort is ignored.
 */
export async function withHardDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<{ timedOut: boolean; value?: T; error?: unknown }> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      promise.then(
        (value) => {
          settled = true;
          return { timedOut: false as const, value };
        },
        (error: unknown) => {
          settled = true;
          return { timedOut: false as const, error };
        },
      ),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => {
          try {
            onTimeout?.();
          } catch {
            // ignore abort errors
          }
          resolve({ timedOut: true });
        }, timeoutMs);
      }),
    ]);
    if (result.timedOut) {
      // Give abort a short grace, then force-return timeout even if prompt never settles.
      await new Promise((r) => setTimeout(r, OUTER_DEADLINE_GRACE_MS));
      if (!settled) {
        return { timedOut: true };
      }
      // Prompt settled during grace — fall through by awaiting original? Treat as timeout if onTimeout fired.
      return { timedOut: true };
    }
    if ("error" in result && result.error !== undefined) {
      return { timedOut: false, error: result.error };
    }
    return { timedOut: false, value: (result as { value: T }).value };
  } finally {
    if (timer) clearTimeout(timer);
    void settled;
  }
}

/** Stable compiled worker artifact relative to package root. */
export const AUTOMATION_WORKER_RUNTIME_REL = join("lib", "automation-worker-runtime.cjs");

/**
 * Walk upward from start dirs looking for package.json that owns this app.
 */
function findPackageRoot(): string {
  const starts: string[] = [];
  try {
    if (typeof __dirname !== "undefined") starts.push(__dirname);
  } catch {
    // ignore
  }
  try {
    const metaUrl = (import.meta as { url?: string }).url;
    if (metaUrl) starts.push(dirname(fileURLToPath(metaUrl)));
  } catch {
    // ignore
  }
  starts.push(process.cwd());
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 10; i += 1) {
      const pkg = join(dir, "package.json");
      if (existsSync(pkg)) {
        try {
          const raw = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string; bin?: unknown };
          // Prefer this package; accept any package that ships the worker artifact.
          if (
            raw.name === "@twofive/snail-pi-web" ||
            existsSync(join(dir, AUTOMATION_WORKER_RUNTIME_REL)) ||
            existsSync(join(dir, "lib", "automation-worker-host.ts"))
          ) {
            return dir;
          }
        } catch {
          // continue
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return process.cwd();
}

/**
 * Resolve the stable standalone worker artifact for child_process.fork.
 * Never resolves beside a Next.js bundled server chunk — always from package root.
 * Prefers compiled runtime.cjs (dev + prod + published); falls back to .ts under tsx.
 */
export function resolveWorkerHostPath(): string {
  if (process.env.AUTOMATION_WORKER_HOST_PATH) {
    const explicit = process.env.AUTOMATION_WORKER_HOST_PATH;
    if (existsSync(explicit)) return explicit;
  }
  const root = findPackageRoot();
  const runtime = join(root, AUTOMATION_WORKER_RUNTIME_REL);
  if (existsSync(runtime)) return runtime;
  // Dev fallback: TypeScript source via tsx (still package-root, not chunk-adjacent).
  const ts = join(root, "lib", "automation-worker-host.ts");
  if (existsSync(ts)) return ts;
  // Last resort: sibling of this module (unit tests / odd layouts).
  const dir =
    typeof __dirname !== "undefined"
      ? __dirname
      : dirname(fileURLToPath((import.meta as { url?: string }).url ?? `file://${__filename}`));
  const siblingRuntime = join(dir, "automation-worker-runtime.cjs");
  if (existsSync(siblingRuntime)) return siblingRuntime;
  const siblingTs = join(dir, "automation-worker-host.ts");
  return siblingTs;
}

/** True when the resolved worker is the stable compiled artifact. */
export function isCompiledWorkerArtifact(path: string): boolean {
  return /automation-worker-runtime\.cjs$/.test(path.replace(/\\/g, "/"));
}

/** Make a staged artifact owner-readonly (best-effort across platforms). */
function makeOwnerReadonly(path: string): void {
  try {
    // 0o444 = r--r--r--; Windows may ignore mode bits but still helps on POSIX.
    chmodSync(path, 0o444);
  } catch {
    // best-effort
  }
}

/**
 * Build a single immutable verified bundle from a file or package directory.
 * Includes executable entry, package.json, lockfiles, dist/, and required deps.
 * Bundle bytes are what get hashed/imported — eliminates check-to-import mutation.
 */
export type ExtensionBundleV1 = {
  v: 1;
  entry: string;
  files: Record<string, string>; // relPath -> base64
};

export function buildExtensionBundle(sourcePath: string): {
  bundle: ExtensionBundleV1;
  bundleBytes: Buffer;
  bundleSha256: string;
  closureDigest: string;
  entryRel: string;
} {
  const st = statSync(sourcePath);
  const files: Record<string, Buffer> = {};
  let entryRel: string;
  let closureRoot: string;

  if (st.isFile()) {
    closureRoot = dirname(sourcePath);
    const hasPkg = existsSync(join(closureRoot, "package.json"));
    if (hasPkg) {
      collectClosureFiles(closureRoot, files);
      entryRel = basename(sourcePath);
      // Ensure the entry file itself is present even if outside naive walk edge cases.
      files[entryRel] = readFileSync(sourcePath);
    } else {
      entryRel = basename(sourcePath);
      files[entryRel] = readFileSync(sourcePath);
      closureRoot = sourcePath;
    }
  } else if (st.isDirectory()) {
    closureRoot = sourcePath;
    collectClosureFiles(sourcePath, files);
    const entryAbs = resolvePackageEntryFromFiles(sourcePath, files);
    if (!entryAbs) {
      throw new Error(`Unsupported extension package (no entry file): ${sourcePath}`);
    }
    entryRel = entryAbs.slice(sourcePath.length).replace(/\\/g, "/").replace(/^\//, "");
  } else {
    throw new Error(`Unsupported extension source type (not file/directory): ${sourcePath}`);
  }

  const sortedRels = Object.keys(files).sort();
  const encoded: Record<string, string> = {};
  for (const rel of sortedRels) {
    encoded[rel.replace(/\\/g, "/")] = files[rel]!.toString("base64");
  }
  const bundle: ExtensionBundleV1 = { v: 1, entry: entryRel.replace(/\\/g, "/"), files: encoded };
  const bundleBytes = Buffer.from(JSON.stringify(bundle), "utf8");
  const bundleSha256 = createHash("sha256").update(bundleBytes).digest("hex");
  // Closure digest matches authorize-time hashPathClosure for the source tree/file.
  const closureDigest = hashPathClosure(st.isDirectory() ? sourcePath : hasNearbyPackage(sourcePath) ? dirname(sourcePath) : sourcePath);
  return { bundle, bundleBytes, bundleSha256, closureDigest, entryRel: bundle.entry };
}

function hasNearbyPackage(filePath: string): boolean {
  return existsSync(join(dirname(filePath), "package.json"));
}

/** Collect package closure files: entry tree + manifest + locks + dist + required deps. */
function collectClosureFiles(root: string, out: Record<string, Buffer>): void {
  const walk = (dir: string, relBase: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === ".git" || name === ".hg" || name === ".svn") continue;
      const abs = join(dir, name);
      const rel = relBase ? `${relBase}/${name}` : name;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        // Include node_modules (required deps) and dist — do not blind-exclude.
        walk(abs, rel.replace(/\\/g, "/"));
      } else if (st.isFile()) {
        try {
          out[rel.replace(/\\/g, "/")] = readFileSync(abs);
        } catch {
          // skip unreadable
        }
      }
    }
  };
  walk(root, "");
  // Ensure critical manifests exist when present at root.
  for (const must of [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "npm-shrinkwrap.json",
  ]) {
    const abs = join(root, must);
    if (existsSync(abs) && statSync(abs).isFile()) {
      out[must] = readFileSync(abs);
    }
  }
}

function resolvePackageEntryFromFiles(pkgRoot: string, files: Record<string, Buffer>): string | null {
  const pkgBuf = files["package.json"];
  if (pkgBuf) {
    try {
      const pkg = JSON.parse(pkgBuf.toString("utf8")) as { main?: string; pi?: { extensions?: string[] } };
      const candidates = [
        ...(pkg.pi?.extensions ?? []),
        pkg.main,
      ].filter((x): x is string => Boolean(x));
      for (const rel of candidates) {
        const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
        if (files[norm]) return join(pkgRoot, norm);
      }
    } catch {
      // fall through
    }
  }
  for (const candidate of ["index.js", "index.ts", "index.mjs", "index.cjs", "main.js", "main.ts", "dist/index.js"]) {
    if (files[candidate]) return join(pkgRoot, candidate);
  }
  return null;
}

/**
 * Stage immutable extension artifacts under automations/artifacts/ext/<sha256>.
 * Packages are bundled into a single verified content-addressed byte artifact.
 * Child executes factories loaded from the verified in-memory bundle bytes only
 * (never extracts then imports mutable filesystem copies).
 */
export function stageExtensionArtifacts(
  extensions: EffectivePermissions["extensions"],
  agentDir?: string,
): WorkerExtensionArtifact[] {
  const out: WorkerExtensionArtifact[] = [];
  const root = join(getAutomationRoot(agentDir), "artifacts", "ext");
  mkdirSync(root, { recursive: true });
  for (const ext of extensions) {
    if (!ext.sourcePath || !existsSync(ext.sourcePath)) {
      throw new Error(`Approved extension source missing: ${ext.sourcePath}`);
    }
    const st = statSync(ext.sourcePath);
    if (!st.isFile() && !st.isDirectory()) {
      throw new Error(
        `Unsupported extension source type (not file/directory): ${ext.sourcePath}`,
      );
    }

    const built = buildExtensionBundle(ext.sourcePath);
    if (
      ext.executableDigest &&
      /^[a-f0-9]{64}$/i.test(ext.executableDigest) &&
      ext.executableDigest !== built.closureDigest
    ) {
      throw new Error(
        `Extension package digest drift before staging: ${ext.sourcePath}`,
      );
    }

    // Content-addressed cache of the verified bundle (audit/debug only — never imported).
    const bundlePath = join(root, "bundle", `${built.bundleSha256}.json`);
    mkdirSync(dirname(bundlePath), { recursive: true });
    if (!existsSync(bundlePath)) {
      const tmp = join(root, "bundle", `.${built.bundleSha256}.${process.pid}.tmp`);
      writeFileSync(tmp, built.bundleBytes);
      try {
        copyFileSync(tmp, bundlePath);
      } catch {
        // race
      }
      try {
        unlinkSync(tmp);
      } catch {
        // ignore
      }
    }
    const staged = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");
    if (staged !== built.bundleSha256) {
      throw new Error(`Staged extension bundle corrupt: ${bundlePath}`);
    }
    makeOwnerReadonly(bundlePath);

    // Authoritative payload for the worker: verified bytes themselves (IPC/in-memory).
    out.push({
      bundleBytesBase64: built.bundleBytes.toString("base64"),
      bundleSha256: built.bundleSha256,
      entryRel: built.entryRel,
      sourceIdentity: ext.sourceIdentity,
      sourcePath: ext.sourcePath,
      closureDigest: built.closureDigest,
      bundlePath,
    });
  }
  void basename;
  void hashDirectoryClosure;
  void extractBundleToDir;
  void makeOwnerReadonlyTree;
  return out;
}

export function extractBundleToDir(bundle: ExtensionBundleV1, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const [rel, b64] of Object.entries(bundle.files)) {
    const abs = join(dest, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from(b64, "base64"));
  }
}

function makeOwnerReadonlyTree(root: string): void {
  try {
    for (const name of readdirSync(root)) {
      const full = join(root, name);
      const st = statSync(full);
      if (st.isDirectory()) makeOwnerReadonlyTree(full);
      else makeOwnerReadonly(full);
    }
  } catch {
    // best-effort
  }
}

/** Explicit env allowlist only — NEVER inherits NODE_OPTIONS/NODE_PATH/ambient injection. */
export function buildIsolatedChildEnv(runnerEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const essential = [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "LC_ALL",
    "PI_CODING_AGENT_DIR",
    // Windows process essentials
    "COMSPEC",
    "PATHEXT",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
  ] as const;
  const env: Record<string, string | undefined> = {};
  if (process.env.NODE_ENV) env.NODE_ENV = process.env.NODE_ENV;
  for (const k of essential) {
    if (process.env[k] != null) env[k] = process.env[k];
  }
  // Overlay allowlisted credential handles from runnerEnv (already filtered).
  for (const [k, v] of Object.entries(runnerEnv)) {
    if (v != null) env[k] = v;
  }
  // Explicitly strip ambient injection + known secrets that must never cross.
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.NODE_EXTRA_CA_CERTS;
  delete env.JS_NOTICE;
  delete env.AUTOMATION_CANARY_SECRET;
  delete env.AWS_SECRET_ACCESS_KEY;
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.GOOGLE_API_KEY;
  // Re-apply only if present in the allowlisted runnerEnv (explicit credential handles).
  if (runnerEnv.OPENAI_API_KEY) env.OPENAI_API_KEY = runnerEnv.OPENAI_API_KEY;
  if (runnerEnv.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = runnerEnv.ANTHROPIC_API_KEY;
  // Final hard strip of injection vectors even if runnerEnv tried to set them.
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return env as NodeJS.ProcessEnv;
}

async function runInIsolatedChild(input: {
  taskId: string;
  runId: string;
  config: AutomationTaskConfig;
  effective: EffectivePermissions;
  agentDir?: string;
  signal?: AbortSignal;
  sessionDir: string;
  runnerEnv: NodeJS.ProcessEnv;
  maxRuntimeMs: number;
  maxTokens: number;
  prompt: string;
}): Promise<AutomationRunnerResult> {
  const fullPrompt = [
    `[Automation task=${input.taskId} run=${input.runId}]`,
    "You are running non-interactively. Do not ask the user questions.",
    `Model: ${input.config.agent.provider}/${input.config.agent.modelId}`,
    `Tools: ${input.effective.tools.map((t) => t.name).join(", ") || "(none)"}`,
    "",
    input.prompt,
  ].join("\n");

  // Hard token ceiling: reject BEFORE any child/model work if estimated input consumes the ceiling.
  const estimatedInputTokens = estimatePromptTokens(fullPrompt);
  const bound = deriveMaxOutputTokens({
    maxTokensPerRun: input.maxTokens,
    estimatedInputTokens,
  });
  if (!bound.ok) {
    return {
      status: "failed",
      summary: null,
      errorCategory: "budget",
      errorMessage: bound.reason,
      usage: {
        inputTokens: estimatedInputTokens,
        outputTokens: 0,
        totalTokens: estimatedInputTokens,
        costUsd: 0,
      },
      actualModel: null,
      session: {
        sessionId: null,
        sessionFile: null,
        availability: "unavailable",
        unavailableReason: "budget_preflight",
        sealed: false,
        seal: null,
      },
      sideEffectsStarted: false,
    };
  }

  let extensionArtifacts: WorkerExtensionArtifact[] = [];
  try {
    extensionArtifacts = stageExtensionArtifacts(input.effective.extensions, input.agentDir);
  } catch (error) {
    return {
      status: "blocked",
      summary: null,
      errorCategory: "preflight",
      errorMessage: redactSecrets(error instanceof Error ? error.message : String(error)),
      usage: null,
      actualModel: null,
      session: {
        sessionId: null,
        sessionFile: null,
        availability: "unavailable",
        unavailableReason: "extension_staging_failed",
        sealed: false,
        seal: null,
      },
      sideEffectsStarted: false,
    };
  }

  const builtinSchemaDigests: Record<string, string> = {};
  for (const t of input.effective.tools) {
    if (t.origin === "builtin" && t.schemaHash) {
      builtinSchemaDigests[t.name] = t.schemaHash;
    }
  }

  // Exact reviewed web tool snapshots (schema/config/executable digests) — never dummy hashes.
  const reviewedWebTools: WorkerReviewedWebTool[] = input.effective.tools
    .filter((t) => t.name === "web_search" || t.name === "web_fetch")
    .map((t) => ({
      name: t.name,
      origin: "custom" as const,
      sourceIdentity: t.sourceIdentity,
      executableDigest: t.executableDigest,
      schemaHash: t.schemaHash,
      configHash: t.configHash,
      description: t.description,
      risks: t.risks,
    }));

  const job: WorkerJob = {
    taskId: input.taskId,
    runId: input.runId,
    cwd: input.config.target.cwd,
    sessionDir: input.sessionDir,
    agentDir: input.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? "",
    prompt: fullPrompt,
    model: {
      provider: input.config.agent.provider,
      modelId: input.config.agent.modelId,
      thinking: input.config.agent.thinking,
    },
    toolNames: input.effective.tools.map((t) => t.name),
    extensionArtifacts,
    maxRuntimeMs: input.maxRuntimeMs,
    maxTokensPerRun: input.maxTokens,
    maxOutputTokens: bound.maxOutputTokens,
    estimatedInputTokens,
    reviewedWebTools,
    reviewedWebToolNames: reviewedWebTools.map((t) => t.name),
    builtinSchemaDigests,
  };

  const workerPath = resolveWorkerHostPath();
  if (!existsSync(workerPath)) {
    return {
      status: "failed",
      summary: null,
      errorCategory: "worker_missing",
      errorMessage: `Automation worker artifact missing at ${workerPath}. Run scripts/build-automation-worker.mjs or npm run build.`,
      usage: null,
      actualModel: null,
      session: {
        sessionId: null,
        sessionFile: null,
        availability: "unavailable",
        unavailableReason: "worker_missing",
        sealed: false,
        seal: null,
      },
      sideEffectsStarted: false,
    };
  }

  const childEnv = buildIsolatedChildEnv(input.runnerEnv);
  // Compiled CJS needs no loader; .ts needs tsx. Never pass NODE_OPTIONS.
  const execArgv = workerPath.endsWith(".ts") ? ["--import", "tsx"] : [];

  let child: ChildProcess | null = null;
  let exited = false;
  let exitCode: number | null = null;
  let forceKilled = false;
  // Mutable holder avoids TS control-flow narrowing of closed-over locals to `never`.
  const ipcState: {
    resultMsg: AutomationRunnerResult | null;
    lastUsage: AutomationRunUsage | null;
  } = { resultMsg: null, lastUsage: null };

  const waitExit = new Promise<void>((resolve) => {
    child = fork(workerPath, [], {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      execArgv,
      // Do not silently inherit parent's full env — we pass childEnv explicitly.
      serialization: "json",
    });
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      resolve();
    });
    child.on("error", () => {
      exited = true;
      resolve();
    });
    child.on("message", (msg: unknown) => {
      const m = msg as {
        type?: string;
        result?: AutomationRunnerResult;
        message?: string;
        usage?: AutomationRunUsage;
        budgetExceeded?: boolean;
      };
      if (m?.type === "ready") {
        child?.send?.({ type: "start", job });
        return;
      }
      if (m?.type === "progress" && m.usage) {
        ipcState.lastUsage = m.usage;
        if (m.budgetExceeded) {
          try {
            child?.send?.({ type: "abort" });
          } catch {
            // ignore
          }
        }
        return;
      }
      if (m?.type === "result" && m.result) {
        ipcState.resultMsg = m.result;
        return;
      }
      if (m?.type === "error") {
        ipcState.resultMsg = {
          status: "failed",
          summary: null,
          errorCategory: "runner",
          errorMessage: redactSecrets(m.message ?? "worker error"),
          usage: ipcState.lastUsage,
          actualModel: null,
          session: {
            sessionId: null,
            sessionFile: findJsonl(input.sessionDir),
            availability: "unavailable",
            unavailableReason: "worker_error",
            sealed: false,
            seal: null,
          },
          sideEffectsStarted: true,
        };
      }
    });
  });

  const killTree = async (): Promise<void> => {
    if (!child || exited) return;
    forceKilled = true;
    try {
      child.send?.({ type: "abort" });
    } catch {
      // ignore
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Bounded wait then SIGKILL.
    await Promise.race([
      waitExit,
      sleep(1_500),
    ]);
    if (!exited && child.pid) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      // Windows: also try taskkill for process tree.
      if (process.platform === "win32" && child.pid) {
        try {
          const { spawnSync } = await import("child_process");
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          // ignore
        }
      }
      await Promise.race([waitExit, sleep(2_000)]);
    }
  };

  const lateSettlement: LateSettlementHandle = {
    waitUntilSettledOrDead: async () => {
      await waitExit;
      return ipcState.resultMsg;
    },
    forceKill: async () => {
      await killTree();
    },
    // NEVER claim isDead while work continues — only after verified exit.
    isDead: () => exited,
  };

  const onAbort = () => {
    void killTree();
  };
  input.signal?.addEventListener("abort", onAbort);

  const hardDeadlineMs = input.maxRuntimeMs + OUTER_DEADLINE_GRACE_MS;
  try {
    const raced = await Promise.race([
      waitExit.then(() => ({ kind: "exit" as const })),
      sleep(hardDeadlineMs).then(() => ({ kind: "timeout" as const })),
      input.signal?.aborted
        ? Promise.resolve({ kind: "cancelled" as const })
        : new Promise<{ kind: "cancelled" }>((resolve) => {
            input.signal?.addEventListener("abort", () => resolve({ kind: "cancelled" }), {
              once: true,
            });
          }),
    ]);

    if (raced.kind === "timeout" || raced.kind === "cancelled") {
      await killTree();
      // Verify exit before releasing authority.
      if (!exited) {
        return {
          status: "ambiguous",
          summary: null,
          errorCategory: raced.kind === "cancelled" ? "cancel_unconfirmed" : "abort_ignored",
          errorMessage:
            raced.kind === "cancelled"
              ? "Cancel requested but child exit not verified"
              : `Exceeded maxRuntimeMs=${input.maxRuntimeMs}; child kill pending verification`,
          usage: ipcState.lastUsage,
          actualModel: null,
          session: {
            sessionId: null,
            sessionFile: findJsonl(input.sessionDir),
            availability: "pending",
            unavailableReason: "child_exit_unverified",
            sealed: false,
            seal: null,
          },
          sideEffectsStarted: true,
          executionMayContinue: true,
          lateSettlement,
        };
      }
      if (ipcState.resultMsg) return { ...ipcState.resultMsg, lateSettlement: undefined, executionMayContinue: false };
      return {
        status: raced.kind === "cancelled" ? "cancelled" : forceKilled ? "timed_out" : "ambiguous",
        summary: null,
        errorCategory: raced.kind === "cancelled" ? "cancelled" : "timeout",
        errorMessage:
          raced.kind === "cancelled"
            ? "Cancelled"
            : `Exceeded maxRuntimeMs=${input.maxRuntimeMs} (child terminated)`,
        usage: ipcState.lastUsage,
        actualModel: null,
        session: {
          sessionId: null,
          sessionFile: findJsonl(input.sessionDir),
          availability: findJsonl(input.sessionDir) ? "available" : "unavailable",
          unavailableReason: findJsonl(input.sessionDir) ? null : "no_session_file",
          sealed: false,
          seal: null,
        },
        sideEffectsStarted: true,
        executionMayContinue: false,
      };
    }

    // Child exited.
    if (ipcState.resultMsg) {
      // Enforce token ceiling on the returned usage as a final gate.
      const budgetFail = enforceTokenBudget(ipcState.resultMsg.usage, input.maxTokens);
      if (budgetFail && ipcState.resultMsg.status === "succeeded") {
        return {
          ...ipcState.resultMsg,
          status: "failed",
          errorCategory: "budget",
          errorMessage: budgetFail,
          executionMayContinue: false,
        };
      }
      return { ...ipcState.resultMsg, executionMayContinue: false };
    }
    return {
      status: exitCode === 0 ? "succeeded" : "failed",
      summary: null,
      errorCategory: exitCode === 0 ? null : "worker_exit",
      errorMessage: exitCode === 0 ? null : `Worker exited with code ${exitCode}`,
      usage: ipcState.lastUsage,
      actualModel: null,
      session: {
        sessionId: null,
        sessionFile: findJsonl(input.sessionDir),
        availability: findJsonl(input.sessionDir) ? "available" : "unavailable",
        unavailableReason: findJsonl(input.sessionDir) ? null : "no_session_file",
        sealed: false,
        seal: null,
      },
      sideEffectsStarted: true,
      executionMayContinue: false,
    };
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
  }
}

export async function runAutomationOnce(input: {
  taskId: string;
  runId: string;
  config: AutomationTaskConfig;
  effective: EffectivePermissions;
  agentDir?: string;
  signal?: AbortSignal;
  /** When true, skip real session creation (preflight-only path). */
  skipExecution?: boolean;
  /**
   * When true (default for production), run AgentSession in a killable child process
   * with allowlisted env only. Injected createSession (tests) always uses in-process path.
   */
  isolateProcess?: boolean;
  deps?: AutomationRunnerDeps;
}): Promise<AutomationRunnerResult> {
  const createSession = input.deps?.createSession ?? defaultCreateSession;
  const useIsolatedChild =
    input.isolateProcess !== false && !input.deps?.createSession;
  const maxRuntimeMs = input.config.agent.maxRuntimeMs;
  const sessionDir = getAutomationTaskSessionDir(input.taskId, input.runId, input.agentDir);

  if (input.skipExecution) {
    return {
      status: "blocked",
      summary: null,
      errorCategory: "preflight",
      errorMessage: "Execution skipped",
      usage: null,
      actualModel: null,
      session: {
        sessionId: null,
        sessionFile: null,
        availability: "unavailable",
        unavailableReason: "preflight_blocked",
        sealed: false,
        seal: null,
      },
      sideEffectsStarted: false,
    };
  }

  const prompt = input.config.agent.prompt?.trim();
  if (!prompt) {
    return {
      status: "failed",
      summary: null,
      errorCategory: "validation",
      errorMessage: "Prompt must be non-empty",
      usage: null,
      actualModel: null,
      session: {
        sessionId: null,
        sessionFile: null,
        availability: "unavailable",
        unavailableReason: "empty_prompt",
        sealed: false,
        seal: null,
      },
      sideEffectsStarted: false,
    };
  }

  // Allowlisted env for tools/adapters. NEVER mutate shared process.env around an
  // async session that may outlive this call — isolation is via explicit env handoff
  // (and optional killable worker). Original secrets must never become visible to
  // continuing execution after return.
  const runnerEnv = buildRunnerEnv({
    credentialHandles: [
      ...input.effective.tools.flatMap((t) =>
        (t.credentialHandles ?? []).map((id) => ({ id, scope: "env" as const })),
      ),
      ...((input.config.authority.credentialHandles ?? []).map((id) => ({
        id,
        scope: "env" as const,
      }))),
    ],
  });

  // Production path: killable child process with only allowlisted env/credential handles.
  // Injected createSession (tests) keeps the in-process fake/injected path.
  if (useIsolatedChild) {
    mkdirSync(sessionDir, { recursive: true });
    return runInIsolatedChild({
      taskId: input.taskId,
      runId: input.runId,
      config: input.config,
      effective: input.effective,
      agentDir: input.agentDir,
      signal: input.signal,
      sessionDir,
      runnerEnv,
      maxRuntimeMs,
      maxTokens: input.config.authority.budgets.maxTokensPerRun,
      prompt,
    });
  }

  // In-process path also enforces hard input ceiling before any session/model work.
  {
    const preludeEstimate = estimatePromptTokens(prompt);
    const bound = deriveMaxOutputTokens({
      maxTokensPerRun: input.config.authority.budgets.maxTokensPerRun,
      estimatedInputTokens: preludeEstimate,
    });
    if (!bound.ok) {
      return {
        status: "failed",
        summary: null,
        errorCategory: "budget",
        errorMessage: bound.reason,
        usage: {
          inputTokens: preludeEstimate,
          outputTokens: 0,
          totalTokens: preludeEstimate,
          costUsd: 0,
        },
        actualModel: null,
        session: {
          sessionId: null,
          sessionFile: null,
          availability: "unavailable",
          unavailableReason: "budget_preflight",
          sealed: false,
          seal: null,
        },
        sideEffectsStarted: false,
      };
    }
    // Stash for createSession maxTokens clamp.
    (input as { __maxOutputTokens?: number }).__maxOutputTokens = bound.maxOutputTokens;
  }

  let created: CreatedSession | null = null;
  let timedOut = false;
  let cancelled = false;
  let sideEffectsStarted = false;
  let appliedModel: CreatedSession["appliedModel"] | null = null;
  let promptSettled = false;
  let budgetAborted = false;
  let tokenMonitor: ReturnType<typeof setInterval> | null = null;
  let pendingPrompt: Promise<unknown> | null = null;
  let workerDead = false;

  const hardDeadlineMs = maxRuntimeMs + OUTER_DEADLINE_GRACE_MS;
  const maxTokens = input.config.authority.budgets.maxTokensPerRun;

  const onAbort = () => {
    cancelled = true;
    try {
      created?.session.abort?.();
    } catch {
      // ignore
    }
  };
  input.signal?.addEventListener("abort", onAbort);

  const makeLateSettlement = (session: CreatedSession | null): LateSettlementHandle => {
    let killed = false;
    return {
      waitUntilSettledOrDead: async () => {
        if (pendingPrompt) {
          try {
            const value = await pendingPrompt;
            workerDead = true;
            return {
              status: "succeeded",
              summary: summarizeResult(value),
              usage: extractUsage(session, value),
              session: {
                sessionId: session?.session.sessionId ?? null,
                sessionFile: session?.session.sessionFile ?? (session ? findJsonl(session.sessionDir) : null),
                availability: "available",
                unavailableReason: null,
                sealed: false,
                seal: null,
              },
            };
          } catch (error) {
            workerDead = true;
            return {
              status: "failed",
              errorMessage: redactSecrets(error instanceof Error ? error.message : String(error)),
              usage: extractUsage(session, null),
            };
          }
        }
        workerDead = true;
        return null;
      },
      forceKill: async () => {
        if (killed) return;
        killed = true;
        try {
          session?.session.abort?.();
        } catch {
          // ignore
        }
        try {
          session?.unsubscribe?.();
        } catch {
          // ignore
        }
        // Best-effort dispose; may race continuing tools — caller only invokes after deadline.
        try {
          if (session?.session) {
            await disposeAgentSession(session.session as never);
          }
        } catch {
          // ignore
        }
        // Only mark dead when the prompt has actually settled — never claim isDead
        // while work continues after abort/dispose.
        if (promptSettled) workerDead = true;
      },
      // Never claim isDead while work continues.
      isDead: () => workerDead || promptSettled,
    };
  };

  try {
    const prelude = [
      `[Automation task=${input.taskId} run=${input.runId}]`,
      "You are running non-interactively. Do not ask the user questions.",
      `Model: ${input.config.agent.provider}/${input.config.agent.modelId}`,
      `Tools: ${input.effective.tools.map((t) => t.name).join(", ") || "(none)"}`,
      "",
      prompt,
    ].join("\n");

    // Isolation: pass allowlisted env explicitly; do not swap process.env.
    // Prove secrets isolation by never restoring ambient env into a live session.
    created = await createSession({
      cwd: input.config.target.cwd,
      sessionDir,
      effective: input.effective,
      model: {
        provider: input.config.agent.provider,
        modelId: input.config.agent.modelId,
        thinking: input.config.agent.thinking,
      },
      promptPrelude: prelude,
      runnerEnv,
      maxTokensPerRun: maxTokens,
      maxOutputTokens: (input as { __maxOutputTokens?: number }).__maxOutputTokens ?? maxTokens,
    } as Parameters<typeof createSession>[0] & { maxOutputTokens?: number });
    appliedModel = created.appliedModel;
    sideEffectsStarted = true;

    // Assert isolation: original canary secrets must not be readable via runnerEnv.
    if (runnerEnv.AUTOMATION_CANARY_SECRET) {
      delete runnerEnv.AUTOMATION_CANARY_SECRET;
    }

    if (input.signal?.aborted) {
      cancelled = true;
    }

    // Monitor session stats during execution and abort at maxTokens ceiling.
    if (maxTokens > 0) {
      tokenMonitor = setInterval(() => {
        if (budgetAborted || promptSettled) return;
        try {
          const usage = extractUsage(created, null);
          const fail = enforceTokenBudget(usage, maxTokens);
          if (fail) {
            budgetAborted = true;
            try {
              created?.session.abort?.();
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore monitor errors
        }
      }, 250);
      tokenMonitor.unref?.();
    }

    pendingPrompt = created.session.prompt(prelude).finally(() => {
      promptSettled = true;
      workerDead = true;
    });
    const raced = await withHardDeadline(pendingPrompt, hardDeadlineMs, () => {
      timedOut = true;
      try {
        created?.session.abort?.();
      } catch {
        // ignore
      }
    });

    if (budgetAborted) {
      const usage = extractUsage(created, raced.value ?? null);
      return await finalizeAfterShutdown({
        status: "failed",
        summary: null,
        errorCategory: "budget",
        errorMessage: `Exceeded maxTokensPerRun=${maxTokens} (aborted at ceiling)`,
        created,
        usage,
        actualModel: appliedModel,
        sideEffectsStarted,
        requireDisposeConfirm: true,
      });
    }

    if (raced.timedOut || timedOut) {
      if (!promptSettled) {
        // Uncertain shutdown: do NOT dispose. Return late-settlement handle.
        // process.env was never mutated, so ambient secrets are not exposed to the session
        // via a restored environment. Session only received allowlisted runnerEnv.
        const usage = extractUsage(created, null);
        const budgetFail = enforceTokenBudget(usage, maxTokens);
        return {
          status: budgetFail ? "failed" : "ambiguous",
          summary: null,
          errorCategory: budgetFail ? "budget" : "abort_ignored",
          errorMessage: budgetFail
            ? budgetFail
            : `Exceeded maxRuntimeMs=${maxRuntimeMs}; abort ignored — authority retained until verified death/expiry`,
          usage,
          actualModel: appliedModel,
          session: {
            sessionId: created.session.sessionId ?? null,
            sessionFile: created.session.sessionFile ?? findJsonl(created.sessionDir),
            availability: "pending",
            unavailableReason: "abort_ignored_unsealed",
            sealed: false,
            seal: null,
          },
          sideEffectsStarted: true,
          executionMayContinue: true,
          lateSettlement: makeLateSettlement(created),
        };
      }
      const usage = extractUsage(created, raced.value);
      const budgetFail = enforceTokenBudget(usage, maxTokens);
      return await finalizeAfterShutdown({
        status: budgetFail ? "failed" : "timed_out",
        summary: null,
        errorCategory: budgetFail ? "budget" : "timeout",
        errorMessage: budgetFail
          ? budgetFail
          : `Exceeded maxRuntimeMs=${maxRuntimeMs} (hard outer deadline)`,
        created,
        usage,
        actualModel: appliedModel,
        sideEffectsStarted,
        requireDisposeConfirm: true,
        forceUnsealed: false,
      });
    }

    if (raced.error) {
      const error = raced.error;
      if (error instanceof AutomationInteractionRequiredError) {
        return await finalizeAfterShutdown({
          status: "blocked",
          summary: null,
          errorCategory: "interaction_required",
          errorMessage: error.message,
          created,
          usage: extractUsage(created, null),
          actualModel: appliedModel,
          sideEffectsStarted,
          requireDisposeConfirm: true,
        });
      }
      if (cancelled || input.signal?.aborted) {
        return await finalizeAfterShutdown({
          status: "cancelled",
          summary: null,
          errorCategory: "cancelled",
          errorMessage: "Cancelled",
          created,
          usage: extractUsage(created, null),
          actualModel: appliedModel,
          sideEffectsStarted,
          requireDisposeConfirm: true,
        });
      }
      return await finalizeAfterShutdown({
        status: "failed",
        summary: null,
        errorCategory: "runner",
        errorMessage: redactSecrets(error instanceof Error ? error.message : String(error)),
        created,
        usage: extractUsage(created, null),
        actualModel: appliedModel,
        sideEffectsStarted,
        requireDisposeConfirm: true,
      });
    }

    if (cancelled || input.signal?.aborted) {
      return await finalizeAfterShutdown({
        status: "cancelled",
        summary: summarizeResult(raced.value),
        errorCategory: "cancelled",
        errorMessage: "Cancelled",
        created,
        usage: extractUsage(created, raced.value),
        actualModel: appliedModel,
        sideEffectsStarted,
        requireDisposeConfirm: true,
      });
    }

    {
      const usage = extractUsage(created, raced.value);
      const budgetFail = enforceTokenBudget(usage, maxTokens);
      // Track spent tokens on the session-attached budget state (streamFn multi-turn).
      const budgetState = (created.session as { __tokenBudgetState?: TokenBudgetState })
        ?.__tokenBudgetState;
      if (budgetState) recordSpentTokens(budgetState, usage);

      if (budgetFail) {
        return await finalizeAfterShutdown({
          status: "failed",
          summary: null,
          errorCategory: "budget",
          errorMessage: budgetFail,
          created,
          usage,
          actualModel: appliedModel,
          sideEffectsStarted,
          requireDisposeConfirm: true,
        });
      }

      // Provider/auth failure must not be reported as succeeded.
      const outcome = classifySessionOutcome(
        {
          agent: (created.session as { agent?: { state?: { errorMessage?: string | null; messages?: Array<{ role?: string; stopReason?: string; errorMessage?: string | null }> } } }).agent,
        },
        { promptResolved: true },
      );
      if (!outcome.ok) {
        return await finalizeAfterShutdown({
          status: outcome.status,
          summary: null,
          errorCategory: outcome.errorCategory,
          errorMessage: outcome.errorMessage,
          created,
          usage,
          actualModel: appliedModel,
          sideEffectsStarted,
          requireDisposeConfirm: true,
        });
      }

      return await finalizeAfterShutdown({
        status: "succeeded",
        summary: summarizeResult(raced.value) || "Automation completed",
        errorCategory: null,
        errorMessage: null,
        created,
        usage,
        actualModel: appliedModel,
        sideEffectsStarted,
        requireDisposeConfirm: true,
      });
    }
  } catch (error) {
    if (created) {
      return await finalizeAfterShutdown({
        status: "failed",
        summary: null,
        errorCategory: "runner_setup",
        errorMessage: redactSecrets(error instanceof Error ? error.message : String(error)),
        created,
        usage: extractUsage(created, null),
        actualModel: appliedModel,
        sideEffectsStarted,
        requireDisposeConfirm: true,
      });
    }
    return {
      status: "failed" as const,
      summary: null,
      errorCategory: "runner_setup",
      errorMessage: redactSecrets(error instanceof Error ? error.message : String(error)),
      usage: null,
      actualModel: null,
      session: {
        sessionId: null,
        sessionFile: null,
        availability: "unavailable" as const,
        unavailableReason: "setup_failed",
        sealed: false,
        seal: null,
      },
      sideEffectsStarted,
    };
  } finally {
    if (tokenMonitor) clearInterval(tokenMonitor);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * @deprecated Do not use around sessions that may outlive the call.
 * Kept for focused tests that prove allowlisted env composition only.
 * Prefer passing runnerEnv into createSession / worker without mutating process.env.
 */
export async function withRestrictedProcessEnv<T>(
  runnerEnv: NodeJS.ProcessEnv,
  fn: () => Promise<T>,
): Promise<T> {
  // Composition-only helper for tests: invoke fn with a frozen snapshot view,
  // without mutating the shared process.env (which would leak on abort-ignore).
  const frozen = { ...runnerEnv };
  const lookup = new Proxy(frozen, {
    get(target, prop, receiver) {
      if (prop === "then") return undefined;
      return Reflect.get(target, prop, receiver);
    },
  });
  void lookup;
  // Expose via AsyncLocalStorage-like handshake: set a symbol on global for test probes
  // without touching process.env keys.
  const g = globalThis as { __piAutomationRestrictedEnvProbe?: NodeJS.ProcessEnv };
  const prev = g.__piAutomationRestrictedEnvProbe;
  g.__piAutomationRestrictedEnvProbe = frozen;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete g.__piAutomationRestrictedEnvProbe;
    else g.__piAutomationRestrictedEnvProbe = prev;
  }
}

function extractUsage(created: CreatedSession | null, promptResult: unknown): AutomationRunUsage | null {
  const candidates: unknown[] = [];
  if (promptResult && typeof promptResult === "object") candidates.push(promptResult);
  // Preferred: installed SDK getSessionStats().
  try {
    const stats = created?.session.getSessionStats?.();
    if (stats) {
      const fromStats: AutomationRunUsage = {
        inputTokens: num(stats.tokens?.input) ?? 0,
        outputTokens: num(stats.tokens?.output) ?? 0,
        totalTokens: num(stats.tokens?.total) ?? (num(stats.tokens?.input) ?? 0) + (num(stats.tokens?.output) ?? 0),
        costUsd: num(stats.cost) ?? 0,
      };
      if (fromStats.totalTokens > 0 || (fromStats.costUsd ?? 0) > 0) {
        return fromStats;
      }
      candidates.push({
        inputTokens: fromStats.inputTokens,
        outputTokens: fromStats.outputTokens,
        totalTokens: fromStats.totalTokens,
        costUsd: fromStats.costUsd,
      });
    }
  } catch {
    // ignore
  }
  try {
    const fromSession = created?.session.getTokenUsage?.() ?? created?.session.usage;
    if (fromSession) candidates.push(fromSession);
  } catch {
    // ignore
  }
  for (const c of candidates) {
    const usage = normalizeUsage(c);
    if (usage) return usage;
  }
  // Minimal zero usage so budget counters have a defined shape when SDK omits totals.
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

function enforceTokenBudget(usage: AutomationRunUsage | null, maxTokensPerRun: number): string | null {
  if (!maxTokensPerRun || maxTokensPerRun <= 0) return null;
  const total = usage?.totalTokens ?? 0;
  if (total > maxTokensPerRun) {
    return `Exceeded maxTokensPerRun=${maxTokensPerRun} (used ${total})`;
  }
  return null;
}

function normalizeUsage(value: unknown): AutomationRunUsage | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const nested =
    rec.usage && typeof rec.usage === "object" ? (rec.usage as Record<string, unknown>) : rec;
  const inputTokens = num(nested.inputTokens ?? nested.input_tokens ?? nested.promptTokens);
  const outputTokens = num(nested.outputTokens ?? nested.output_tokens ?? nested.completionTokens);
  let totalTokens = num(nested.totalTokens ?? nested.total_tokens);
  if (totalTokens == null && (inputTokens != null || outputTokens != null)) {
    totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
  }
  const costUsd = num(nested.costUsd ?? nested.cost_usd ?? nested.totalCost);
  if (inputTokens == null && outputTokens == null && totalTokens == null && costUsd == null) {
    return null;
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: totalTokens ?? 0,
    costUsd: costUsd ?? 0,
  };
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * Dispose / drain first, then seal session file. Seal never precedes shutdown.
 * If dispose/shutdown cannot be confirmed, leave unsealed (cannot promote).
 */
async function finalizeAfterShutdown(input: {
  status: AutomationRunnerResult["status"];
  summary: string | null;
  errorCategory: string | null;
  errorMessage: string | null;
  created: CreatedSession | null;
  usage: AutomationRunUsage | null;
  actualModel: AutomationRunnerResult["actualModel"];
  sideEffectsStarted: boolean;
  requireDisposeConfirm?: boolean;
  forceUnsealed?: boolean;
}): Promise<AutomationRunnerResult> {
  let disposeConfirmed = !input.created;
  if (input.created) {
    try {
      input.created.unsubscribe?.();
    } catch {
      // ignore
    }
    try {
      input.created.session.abort?.();
    } catch {
      // ignore
    }
    try {
      let done = false;
      await Promise.race([
        disposeAgentSession(input.created.session as never, "quit").then(() => {
          done = true;
        }),
        sleep(DRAIN_MS),
      ]);
      disposeConfirmed = done;
    } catch {
      disposeConfirmed = false;
    }
    // Bounded drain after dispose for late writers only when dispose confirmed.
    if (disposeConfirmed) {
      await sleep(100);
    }
  }

  const sessionFile =
    input.created?.session.sessionFile ??
    (input.created ? findJsonl(input.created.sessionDir) : null);
  const sessionId = input.created?.session.sessionId ?? null;

  const canSeal =
    !input.forceUnsealed &&
    (!input.requireDisposeConfirm || disposeConfirmed) &&
    Boolean(sessionFile && existsSync(sessionFile));

  const seal = canSeal ? sealSessionFile(sessionFile) : null;
  let status = input.status;
  let errorCategory = input.errorCategory;
  let errorMessage = input.errorMessage;
  if (input.created && input.requireDisposeConfirm && !disposeConfirmed) {
    // Abort-ignoring / hung sessions remain unsealed and cannot promote.
    if (status === "succeeded" || status === "timed_out" || status === "cancelled") {
      status = "ambiguous";
      errorCategory = errorCategory ?? "dispose_unconfirmed";
      errorMessage =
        errorMessage ??
        "Session dispose/shutdown did not confirm; left unsealed/ambiguous";
    }
  }

  const availability =
    sessionFile && existsSync(sessionFile) ? "available" : sessionId ? "pending" : "unavailable";

  return {
    status,
    summary: input.summary,
    errorCategory,
    errorMessage,
    usage: input.usage,
    actualModel: input.actualModel ?? null,
    session: {
      sessionId,
      sessionFile,
      availability: availability === "available" ? "available" : sessionFile ? "available" : "unavailable",
      unavailableReason: sessionFile ? null : "no_session_file",
      sealed: Boolean(seal),
      seal,
    },
    sideEffectsStarted: input.sideEffectsStarted,
  };
}

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}
