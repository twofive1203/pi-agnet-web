/**
 * Frozen authorization snapshots ∩ live policy for Automation headless runs.
 * Fail closed on missing/drift/revocation. Never falls back to dynamic `all`.
 */

import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname as pathDirname, join as pathJoin } from "path";
import { getAgentDirLocal } from "./automation-paths";
import {
  buildExtensionSnapshot,
  buildReviewedActualToolSchema,
  buildToolSnapshot,
  classifyBuiltinTool,
  classifyExtensionTool,
  defaultAutomationCatalog,
  defaultBuiltinCatalog,
  defaultBuiltinCatalogAsync,
  hashJson,
  hashPathClosure,
  isAlwaysBlockedToolName,
  isReviewedWebToolName,
  loadActualBuiltinToolSchemasAsync,
  type CatalogToolDescriptor,
} from "./automation-resource-catalog";
import {
  assertReviewedWebSnapshot,
  buildReviewedWebToolSnapshot,
  listReviewedWebCatalogDescriptors,
} from "./automation-reviewed-web-tools";
import type {
  AutomationAuthorityConfig,
  AutomationBlockedReason,
  AutomationExtensionSourceSnapshot,
  AutomationToolSnapshot,
} from "./automation-types";
import {
  AUTOMATION_AUTHORITY_POLICY_VERSION,
  defaultBudgetPolicy,
} from "./automation-types";

export class AutomationPolicyError extends Error {
  readonly code = "blocked" as const;
  readonly blockedReason: AutomationBlockedReason;

  constructor(message: string, blockedReason: AutomationBlockedReason = "policy_violation") {
    super(message);
    this.name = "AutomationPolicyError";
    this.blockedReason = blockedReason;
  }
}

export function computeAuthorityPolicyHash(input: {
  tools: AutomationToolSnapshot[];
  extensions: AutomationExtensionSourceSnapshot[];
  budgets: unknown;
  credentialHandles: string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: AUTOMATION_AUTHORITY_POLICY_VERSION,
        tools: input.tools.map((t) => ({
          name: t.name,
          sourceIdentity: t.sourceIdentity,
          executableDigest: t.executableDigest,
          schemaHash: t.schemaHash,
          configHash: t.configHash,
        })),
        extensions: input.extensions.map((e) => ({
          sourceIdentity: e.sourceIdentity,
          executableDigest: e.executableDigest,
          configHash: e.configHash,
          hookInventory: e.hookInventory,
        })),
        budgets: input.budgets,
        credentialHandles: [...input.credentialHandles].sort(),
      }),
    )
    .digest("hex");
}

export function buildAuthorityConfig(input: {
  tools: AutomationToolSnapshot[];
  extensions?: AutomationExtensionSourceSnapshot[];
  budgets?: AutomationAuthorityConfig["budgets"];
  credentialHandles?: string[];
  approvalExpiresAt?: string | null;
}): AutomationAuthorityConfig {
  // NEVER silently filter requested authority down to a smaller/empty set.
  // Unsupported, blocked, or drifted selections must fail validation before config construction.
  const tools = input.tools;
  for (const t of tools) {
    if (isAlwaysBlockedToolName(t.name) || t.risks.blocked) {
      throw new AutomationPolicyError(
        `Selected tool is blocked or unsupported: ${t.name}${t.risks.blockedReason ? ` (${t.risks.blockedReason})` : ""}`,
        (t.risks.blockedReason as AutomationBlockedReason | undefined) ?? "policy_violation",
      );
    }
  }
  const extensions = input.extensions ?? [];
  for (const ext of extensions) {
    if (!ext.sourcePath || !ext.executableDigest) {
      throw new AutomationPolicyError(
        `Selected extension missing path/digest: ${ext.sourceIdentity}`,
        "policy_violation",
      );
    }
  }
  const budgets = input.budgets ?? defaultBudgetPolicy();
  const credentialHandles = input.credentialHandles ?? [];
  const policyHash = computeAuthorityPolicyHash({
    tools,
    extensions,
    budgets,
    credentialHandles,
  });
  return {
    authorityPolicyVersion: AUTOMATION_AUTHORITY_POLICY_VERSION,
    tools,
    extensions,
    policyHash,
    approvalExpiresAt: input.approvalExpiresAt ?? null,
    budgets,
    credentialHandles,
  };
}

export type LiveToolPolicy = {
  tools: CatalogToolDescriptor[];
  /** When true, write/edit require proven cwd confinement. */
  cwdConfinementProven?: boolean;
};

export type EffectivePermissions = {
  tools: AutomationToolSnapshot[];
  extensions: AutomationExtensionSourceSnapshot[];
  blocked: boolean;
  blockedReason: AutomationBlockedReason | null;
  blockMessage: string | null;
  policyHash: string;
};

function liveSnapshotFor(
  name: string,
  live: CatalogToolDescriptor | undefined,
  approved: AutomationToolSnapshot,
): AutomationToolSnapshot | null {
  if (!live) return null;
  if (isAlwaysBlockedToolName(name)) return null;

  // Reviewed web tools must round-trip through the immutable registry, not buildToolSnapshot.
  if (isReviewedWebToolName(name)) {
    try {
      assertReviewedWebSnapshot(approved);
      const expected = buildReviewedWebToolSnapshot(name as "web_search" | "web_fetch");
      // Live descriptor must present the same identity/schema/config/digest.
      if (live.sourceIdentity && live.sourceIdentity !== expected.sourceIdentity) return null;
      const liveDigest = (live as { executableDigest?: string }).executableDigest;
      if (liveDigest && liveDigest !== expected.executableDigest) return null;
      return expected;
    } catch {
      return null;
    }
  }

  const risks =
    live.risks ??
    (live.origin === "builtin" ? classifyBuiltinTool(name) : classifyExtensionTool(name, live.sourcePath));
  if (risks.blocked) return null;
  if (risks.interactionRequired) return null;

  // Prefer exact digest/schema from a live descriptor that already carries them (catalog).
  const liveDigest = (live as { executableDigest?: string }).executableDigest;
  const liveSchemaHash = (live as { schemaHash?: string }).schemaHash;
  const liveConfigHash = (live as { configHash?: string }).configHash;

  const snap = buildToolSnapshot({
    name: live.name,
    description: live.description,
    origin: live.origin,
    sourcePath: live.sourcePath,
    schema: live.schema,
    risks,
    credentialHandles: live.credentialHandles,
  });

  // When the catalog already computed digest/hashes, prefer those over rebuild.
  const normalized: AutomationToolSnapshot = {
    ...snap,
    sourceIdentity: live.sourceIdentity || snap.sourceIdentity,
    executableDigest: liveDigest || snap.executableDigest,
    schemaHash: liveSchemaHash || snap.schemaHash,
    configHash: liveConfigHash || snap.configHash,
  };

  // Exact identity match required.
  if (normalized.sourceIdentity !== approved.sourceIdentity) return null;
  if (normalized.executableDigest !== approved.executableDigest) return null;
  if (normalized.schemaHash !== approved.schemaHash) return null;
  if (normalized.configHash !== approved.configHash) return null;
  return normalized;
}

export function intersectAuthorityWithLive(
  approved: AutomationAuthorityConfig,
  live: LiveToolPolicy,
): EffectivePermissions {
  if (approved.authorityPolicyVersion !== AUTOMATION_AUTHORITY_POLICY_VERSION) {
    return {
      tools: [],
      extensions: [],
      blocked: true,
      blockedReason: "reauthorization_required",
      blockMessage: "Authority policy version drift",
      policyHash: approved.policyHash,
    };
  }

  if (approved.approvalExpiresAt) {
    const exp = Date.parse(approved.approvalExpiresAt);
    if (Number.isFinite(exp) && exp <= Date.now()) {
      return {
        tools: [],
        extensions: [],
        blocked: true,
        blockedReason: "approval_expired",
        blockMessage: "Task approval has expired",
        policyHash: approved.policyHash,
      };
    }
  }

  const liveByName = new Map(live.tools.map((t) => [t.name, t]));
  const effectiveTools: AutomationToolSnapshot[] = [];

  for (const approvedTool of approved.tools) {
    if (isAlwaysBlockedToolName(approvedTool.name)) {
      return {
        tools: [],
        extensions: [],
        blocked: true,
        blockedReason: "policy_violation",
        blockMessage: `Tool ${approvedTool.name} is forbidden in Automation`,
        policyHash: approved.policyHash,
      };
    }

    if (
      (approvedTool.name === "write" || approvedTool.name === "edit") &&
      !live.cwdConfinementProven
    ) {
      return {
        tools: [],
        extensions: [],
        blocked: true,
        blockedReason: "policy_violation",
        blockMessage: `Tool ${approvedTool.name} requires proven cwd confinement`,
        policyHash: approved.policyHash,
      };
    }

    if (isReviewedWebToolName(approvedTool.name)) {
      // Still require exact digest/source match against live descriptor.
    }

    const liveTool = liveByName.get(approvedTool.name);
    const matched = liveSnapshotFor(approvedTool.name, liveTool, approvedTool);
    if (!matched) {
      return {
        tools: [],
        extensions: [],
        blocked: true,
        blockedReason: liveTool ? "reauthorization_required" : "tool_unavailable",
        blockMessage: liveTool
          ? `Tool drift detected for ${approvedTool.name}`
          : `Approved tool missing: ${approvedTool.name}`,
        policyHash: approved.policyHash,
      };
    }
    effectiveTools.push(matched);
  }

  // Extension sources: must still exist with same digest before import.
  const effectiveExtensions: AutomationExtensionSourceSnapshot[] = [];
  for (const ext of approved.extensions) {
    if (!existsSync(ext.sourcePath)) {
      return {
        tools: [],
        extensions: [],
        blocked: true,
        blockedReason: "tool_unavailable",
        blockMessage: `Approved extension missing: ${ext.sourcePath}`,
        policyHash: approved.policyHash,
      };
    }
    // Consistent file/package closure digest (not size/mtime, not file-only on dirs).
    const liveDigest = hashPathClosure(ext.sourcePath);
    if (liveDigest !== ext.executableDigest) {
      return {
        tools: [],
        extensions: [],
        blocked: true,
        blockedReason: "reauthorization_required",
        blockMessage: `Extension digest drift: ${ext.sourcePath}`,
        policyHash: approved.policyHash,
      };
    }
    const liveSnap = buildExtensionSnapshot({
      sourcePath: ext.sourcePath,
      hookInventory: ext.hookInventory,
    });
    if (liveSnap.sourceIdentity !== ext.sourceIdentity) {
      return {
        tools: [],
        extensions: [],
        blocked: true,
        blockedReason: "reauthorization_required",
        blockMessage: `Extension identity drift: ${ext.sourcePath}`,
        policyHash: approved.policyHash,
      };
    }
    effectiveExtensions.push(ext);
  }

  // Empty tool set is valid (true no-tools).
  const policyHash = computeAuthorityPolicyHash({
    tools: effectiveTools,
    extensions: effectiveExtensions,
    budgets: approved.budgets,
    credentialHandles: approved.credentialHandles,
  });

  return {
    tools: effectiveTools,
    extensions: effectiveExtensions,
    blocked: false,
    blockedReason: null,
    blockMessage: null,
    policyHash,
  };
}

/**
 * Pre-import allowlist: only approved extension source paths may be loaded.
 * Returns filter predicate for resource loader overrides.
 */
export function createApprovedExtensionPathAllowlist(
  extensions: AutomationExtensionSourceSnapshot[],
): Set<string> {
  const set = new Set<string>();
  for (const ext of extensions) {
    set.add(ext.sourcePath.replace(/\\/g, "/"));
    set.add(ext.sourcePath);
  }
  return set;
}

export function filterExtensionsBeforeImport<T extends { path: string }>(
  extensions: T[],
  allow: Set<string>,
): T[] {
  return extensions.filter((ext) => {
    const norm = ext.path.replace(/\\/g, "/");
    return allow.has(ext.path) || allow.has(norm);
  });
}

/** Static preflight without importing extensions. */
export function staticPreflight(input: {
  cwd: string;
  cwdExists: boolean;
  modelAvailable: boolean;
  credentialHandlesOk: boolean;
  authority: AutomationAuthorityConfig;
  live: LiveToolPolicy;
}): {
  ok: boolean;
  blockedReason: AutomationBlockedReason | null;
  message: string | null;
  effective: EffectivePermissions;
} {
  if (!input.cwdExists) {
    return {
      ok: false,
      blockedReason: "cwd_unavailable",
      message: `cwd unavailable: ${input.cwd}`,
      effective: {
        tools: [],
        extensions: [],
        blocked: true,
        blockedReason: "cwd_unavailable",
        blockMessage: "cwd unavailable",
        policyHash: input.authority.policyHash,
      },
    };
  }
  if (!input.modelAvailable) {
    return {
      ok: false,
      blockedReason: "model_unavailable",
      message: "model unavailable",
      effective: {
        tools: [],
        extensions: [],
        blocked: true,
        blockedReason: "model_unavailable",
        blockMessage: "model unavailable",
        policyHash: input.authority.policyHash,
      },
    };
  }
  if (!input.credentialHandlesOk) {
    return {
      ok: false,
      blockedReason: "credential_unavailable",
      message: "credential handles unavailable",
      effective: {
        tools: [],
        extensions: [],
        blocked: true,
        blockedReason: "credential_unavailable",
        blockMessage: "credential unavailable",
        policyHash: input.authority.policyHash,
      },
    };
  }
  const effective = intersectAuthorityWithLive(input.authority, input.live);
  if (effective.blocked) {
    return {
      ok: false,
      blockedReason: effective.blockedReason,
      message: effective.blockMessage,
      effective,
    };
  }
  return { ok: true, blockedReason: null, message: null, effective };
}

export type AuthoritySummaryStructured = {
  policyHash: string;
  approvalExpiresAt: string | null;
  budgets: {
    maxRunsPerDay: number;
    maxTokensPerRun: number;
    maxMonthlyCostUsd: number;
    consecutiveFailureThreshold?: number;
  };
  tools: Array<{
    name: string;
    origin: string;
    risks: string[];
    digestShort: string;
  }>;
  extensionCount: number;
  serviceOnlineRequired: true;
};

export function buildAuthoritySummaryStructured(
  authority: AutomationAuthorityConfig,
): AuthoritySummaryStructured {
  return {
    policyHash: authority.policyHash,
    approvalExpiresAt: authority.approvalExpiresAt ?? null,
    budgets: {
      maxRunsPerDay: authority.budgets.maxRunsPerDay,
      maxTokensPerRun: authority.budgets.maxTokensPerRun,
      maxMonthlyCostUsd: authority.budgets.maxMonthlyCostUsd,
      consecutiveFailureThreshold: authority.budgets.consecutiveFailureThreshold,
    },
    tools: authority.tools.map((t) => {
      const risks: string[] = [];
      if (t.risks.networkEgress) risks.push("network");
      if (t.risks.localMutation) risks.push("filesystem");
      if (t.risks.credentialUse) risks.push("credentials");
      if (t.risks.interactionRequired) risks.push("interactive");
      return {
        name: t.name,
        origin: t.origin,
        risks,
        digestShort: t.executableDigest.slice(0, 12),
      };
    }),
    extensionCount: authority.extensions.length,
    serviceOnlineRequired: true,
  };
}

/** English machine lines for agent-tool confirms / challenge binding. Prefer structured+i18n in UI. */
export function authoritySummaryLines(authority: AutomationAuthorityConfig): string[] {
  const s = buildAuthoritySummaryStructured(authority);
  const toolLines = s.tools.map(
    (t) =>
      `- ${t.name} (${t.origin}${t.risks.length ? `; ${t.risks.join(", ")}` : ""}) digest=${t.digestShort}`,
  );
  return [
    `Policy hash: ${s.policyHash.slice(0, 16)}`,
    `Approval expires: ${s.approvalExpiresAt ?? "(none)"}`,
    `Budgets: ${s.budgets.maxRunsPerDay}/day, ${s.budgets.maxTokensPerRun} tokens/run, ${s.budgets.maxMonthlyCostUsd}/mo`,
    `Tools (${s.tools.length}):`,
    ...(toolLines.length ? toolLines : ["- (no tools)"]),
    `Extensions: ${s.extensionCount}`,
    "Schedules execute only while Snail Pi Web service is running.",
  ];
}

export function snapshotsEqualEnough(a: AutomationToolSnapshot, b: AutomationToolSnapshot): boolean {
  return (
    a.name === b.name &&
    a.sourceIdentity === b.sourceIdentity &&
    a.executableDigest === b.executableDigest &&
    a.schemaHash === b.schemaHash &&
    a.configHash === b.configHash
  );
}

export function buildLivePolicyFromSnapshots(tools: AutomationToolSnapshot[]): LiveToolPolicy {
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      origin: t.origin,
      sourcePath: t.sourcePath,
      sourceIdentity: t.sourceIdentity,
      // Preserve enough schema/digest metadata for exact intersection (do not synthesize `{name}` only).
      schema: { name: t.name, schemaHash: t.schemaHash, configHash: t.configHash },
      risks: t.risks,
      credentialHandles: t.credentialHandles,
      executableDigest: t.executableDigest,
      schemaHash: t.schemaHash,
      configHash: t.configHash,
    })) as LiveToolPolicy["tools"],
    // SDK write/edit accept absolute paths that escape cwd — never claim confinement.
    cwdConfinementProven: false,
  };
}

/** Discover extension entry paths under a directory without importing factories. */
function discoverExtensionEntriesInDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    const entryPath = pathJoin(dir, name);
    let isFile = false;
    let isDir = false;
    try {
      const st = statSync(entryPath);
      isFile = st.isFile();
      isDir = st.isDirectory();
    } catch {
      continue;
    }
    if (isFile && (name.endsWith(".ts") || name.endsWith(".js"))) {
      out.push(entryPath);
      continue;
    }
    if (!isDir) continue;
    const pkgJson = pathJoin(entryPath, "package.json");
    if (existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as {
          main?: string;
          pi?: { extensions?: string[] };
        };
        const declared = pkg.pi?.extensions ?? [];
        if (declared.length) {
          for (const rel of declared) {
            const resolved = pathJoin(entryPath, rel);
            if (existsSync(resolved)) out.push(resolved);
          }
          continue;
        }
        if (pkg.main) {
          const mainPath = pathJoin(entryPath, pkg.main);
          if (existsSync(mainPath)) {
            out.push(mainPath);
            continue;
          }
        }
      } catch {
        // fall through to index
      }
    }
    for (const idx of ["index.ts", "index.js", "index.mjs", "index.cjs"]) {
      const p = pathJoin(entryPath, idx);
      if (existsSync(p)) {
        out.push(p);
        break;
      }
    }
  }
  return out;
}

/**
 * Discover live catalog descriptors for a target cwd without importing unapproved
 * extension factories. Uses actual SDK builtin schemas + static filesystem extension
 * enumeration + reviewed web registry. Factory evaluation runs only for exact digests
 * present in the trusted reviewed registry, via the standalone discovery worker.
 */
export async function discoverLiveCatalogForTargetCwd(input: {
  cwd: string;
  approvedTools?: AutomationToolSnapshot[];
  agentDir?: string;
}): Promise<CatalogToolDescriptor[]> {
  const byName = new Map<string, CatalogToolDescriptor>();

  // Prefer actual SDK builtin schemas (async ESM) so snapshots match production tools.
  await loadActualBuiltinToolSchemasAsync();
  const builtins = await defaultBuiltinCatalogAsync();
  for (const d of builtins.filter((t) => !t.risks.blocked || t.name === "bash")) {
    byName.set(d.name, d);
  }
  for (const d of listReviewedWebCatalogDescriptors()) {
    byName.set(d.name, d as CatalogToolDescriptor);
  }

  // Isolated filesystem discovery of target-cwd + agentDir extension entries.
  // Unapproved: static blocked metadata only — never import/evaluate factories.
  // Reviewed digests: actual registration via standalone discovery worker only.
  let agentDir: string | undefined = input.agentDir;
  if (!agentDir) {
    try {
      agentDir = getAgentDirLocal();
    } catch {
      agentDir = process.env.PI_CODING_AGENT_DIR;
    }
  }
  const discoveryRoots = [
    pathJoin(input.cwd, ".pi", "extensions"),
    agentDir ? pathJoin(agentDir, "extensions") : null,
  ].filter((p): p is string => Boolean(p));

  const {
    tryGetReviewedExtensionTrust,
    discoverReviewedExtensionRegistration,
  } = await import("./automation-extension-discovery");

  for (const root of discoveryRoots) {
    for (const entryPath of discoverExtensionEntriesInDir(root)) {
      let sourcePath = entryPath;
      const dir = pathDirname(entryPath);
      if (existsSync(pathJoin(dir, "package.json"))) sourcePath = dir;

      const trust = tryGetReviewedExtensionTrust({ sourcePath, agentDir });

      // Unapproved / untrusted: enumerate as blocked metadata only. No factory.
      if (!trust.trusted) {
        const shortName = sourcePath.replace(/\\/g, "/").split("/").slice(-2).join("/");
        const snap = buildToolSnapshot({
          name: `extension:${shortName}`,
          description:
            "Unreviewed extension (static catalog metadata only; factory not executed)",
          origin: "extension",
          sourcePath,
          schema: {
            entry: entryPath.replace(/\\/g, "/"),
            catalogMode: "static_blocked",
            trustReason: trust.reason,
            closureDigest: trust.closureDigest,
          },
          hookInventory: [],
          risks: {
            ...classifyExtensionTool("extension", sourcePath),
            blocked: true,
            blockedReason: "unknown_extension_forbidden",
          },
        });
        // Force digest to the live static closure so UI/authority can show identity.
        const desc = {
          name: snap.name,
          description: snap.description ?? "",
          origin: snap.origin,
          sourcePath: snap.sourcePath,
          sourceIdentity: snap.sourceIdentity,
          schema: {
            name: snap.name,
            schemaHash: snap.schemaHash,
            configHash: snap.configHash,
            catalogMode: "static_blocked",
            trustReason: trust.reason,
            closureDigest: trust.closureDigest,
          },
          risks: snap.risks,
          credentialHandles: snap.credentialHandles,
          executableDigest: trust.closureDigest || snap.executableDigest,
          schemaHash: snap.schemaHash,
          configHash: snap.configHash,
          hookInventory: [] as string[],
          catalogMode: "static_blocked" as const,
        } as CatalogToolDescriptor & { catalogMode?: string };
        byName.set(snap.sourceIdentity, desc);
        continue;
      }

      // Reviewed: actual tool/schema/hook discovery via standalone worker only.
      let registrations: Array<{
        name: string;
        description?: string;
        parameters?: unknown;
      }> = [];
      let hooks: string[] = [];
      let packageClosure: string[] = [];
      let entryRel = "";
      let bundleSha256 = "";
      try {
        const discovered = await discoverReviewedExtensionRegistration({
          sourcePath,
          agentDir,
          liveClosureDigest: trust.closureDigest,
        });
        registrations = discovered.registration.tools;
        hooks = discovered.registration.hooks;
        packageClosure = discovered.registration.packageClosure;
        entryRel = discovered.registration.entryRel;
        bundleSha256 = discovered.liveBundleSha256;
      } catch {
        // Reviewed but discovery failed — still do not fall back to untrusted in-process eval.
        registrations = [];
      }

      if (!registrations.length) {
        const snap = buildToolSnapshot({
          name: `extension:${sourcePath.replace(/\\/g, "/").split("/").slice(-2).join("/")}`,
          description: "Reviewed extension (no tools registered during discovery)",
          origin: "extension",
          sourcePath,
          schema: {
            entry: entryRel || entryPath.replace(/\\/g, "/"),
            catalogMode: "reviewed_empty",
            packageClosure,
            hooks,
            bundleSha256,
            closureDigest: trust.closureDigest,
          },
          hookInventory: hooks,
          // Trusted digest but no tools registered — keep blocked until actual surface exists.
          risks: classifyExtensionTool("extension", sourcePath),
        });
        byName.set(snap.sourceIdentity, {
          name: snap.name,
          description: snap.description ?? "",
          origin: snap.origin,
          sourcePath: snap.sourcePath,
          sourceIdentity: snap.sourceIdentity,
          schema: {
            name: snap.name,
            schemaHash: snap.schemaHash,
            configHash: snap.configHash,
            packageClosure,
            hooks,
            catalogMode: "reviewed_empty",
            bundleSha256,
            closureDigest: trust.closureDigest,
          },
          risks: snap.risks,
          credentialHandles: snap.credentialHandles,
          executableDigest: trust.closureDigest || snap.executableDigest,
          schemaHash: snap.schemaHash,
          configHash: snap.configHash,
          hookInventory: hooks,
        } as CatalogToolDescriptor);
        continue;
      }

      for (const tool of registrations) {
        const actualSchema = buildReviewedActualToolSchema({
          name: tool.name,
          description: tool.description ?? `Extension tool ${tool.name}`,
          parameters: tool.parameters ?? {},
          packageClosure,
          hooks,
          entry: entryRel,
          bundleSha256,
          closureDigest: trust.closureDigest,
        });
        const snap = buildToolSnapshot({
          name: tool.name,
          description: tool.description ?? `Extension tool ${tool.name}`,
          origin: "extension",
          sourcePath,
          schema: actualSchema,
          hookInventory: hooks,
          // Exact registry digest + actual registration ⇒ reviewed/headless-compatible.
          risks: classifyExtensionTool(tool.name, sourcePath, { reviewedActual: true }),
        });
        const desc = {
          name: snap.name,
          description: snap.description ?? "",
          origin: snap.origin,
          sourcePath: snap.sourcePath,
          sourceIdentity: snap.sourceIdentity,
          // Preserve the actual registration descriptor (do not collapse to synthetic hashes).
          schema: actualSchema,
          risks: snap.risks,
          credentialHandles: snap.credentialHandles,
          executableDigest: trust.closureDigest || snap.executableDigest,
          schemaHash: snap.schemaHash,
          configHash: snap.configHash,
          hookInventory: hooks,
          catalogMode: "reviewed_actual" as const,
        } as CatalogToolDescriptor & { catalogMode?: string };
        if (!byName.has(tool.name) || byName.get(tool.name)?.origin !== "builtin") {
          byName.set(tool.name, desc);
        } else {
          byName.set(`ext:${tool.name}:${snap.sourceIdentity}`, desc);
        }
      }
    }
  }

  // Re-stat approved extension/custom sources against the real filesystem (no import).
  // Never overwrite a discovered reviewed_actual descriptor with synthetic schema metadata.
  for (const t of input.approvedTools ?? []) {
    if (t.origin === "extension" || t.origin === "custom") {
      if (t.sourcePath && existsSync(t.sourcePath)) {
        const existing = byName.get(t.name) as
          | (CatalogToolDescriptor & {
              catalogMode?: string;
              executableDigest?: string;
              schemaHash?: string;
              configHash?: string;
              hookInventory?: string[];
            })
          | undefined;
        const existingMode =
          existing?.catalogMode ??
          (existing?.schema &&
          typeof existing.schema === "object" &&
          (existing.schema as { catalogMode?: string }).catalogMode);
        const sameSource =
          existing?.sourcePath &&
          existing.sourcePath.replace(/\\/g, "/") === t.sourcePath.replace(/\\/g, "/");
        if (existing && sameSource && existingMode === "reviewed_actual") {
          // Keep actual tools/schema/hooks from discovery; only backfill approved digests if missing.
          byName.set(t.name, {
            ...existing,
            risks: t.risks?.blocked ? existing.risks : t.risks ?? existing.risks,
            executableDigest: existing.executableDigest || t.executableDigest,
            schemaHash: existing.schemaHash || t.schemaHash,
            configHash: existing.configHash || t.configHash,
            hookInventory: existing.hookInventory?.length
              ? existing.hookInventory
              : t.hookInventory ?? [],
            credentialHandles: t.credentialHandles ?? existing.credentialHandles,
          } as CatalogToolDescriptor);
          continue;
        }
        // No live actual discovery — restate approved identity without inventing a new schema hash.
        byName.set(t.name, {
          name: t.name,
          description: t.description ?? "",
          origin: t.origin,
          sourcePath: t.sourcePath,
          sourceIdentity: t.sourceIdentity,
          schema: {
            name: t.name,
            schemaHash: t.schemaHash,
            configHash: t.configHash,
            hooks: t.hookInventory ?? [],
            catalogMode: "approved_restated",
          },
          risks: t.risks,
          credentialHandles: t.credentialHandles,
          executableDigest: t.executableDigest,
          schemaHash: t.schemaHash,
          configHash: t.configHash,
          hookInventory: t.hookInventory ?? [],
          catalogMode: "approved_restated",
        } as CatalogToolDescriptor & { catalogMode?: string });
      }
    } else if (t.origin === "builtin" && !byName.has(t.name)) {
      const builtin = (await defaultBuiltinCatalogAsync()).find((x) => x.name === t.name);
      if (builtin) byName.set(t.name, builtin);
    }
  }

  return [...byName.values()];
}

/**
 * Build live policy from the real target-cwd catalog + reviewed web registry.
 * Never synthesizes availability booleans from the approved snapshot alone.
 * Never asserts cwdConfinementProven for SDK write/edit (absolute paths escape).
 */
export function buildLivePolicyForTargetCwd(input: {
  cwd: string;
  approvedTools?: AutomationToolSnapshot[];
  /** Optional already-discovered descriptors (e.g. from a prior safe resource probe). */
  discovered?: CatalogToolDescriptor[];
}): LiveToolPolicy {
  // Sync path: use provided discovery or safe static+restated sources (no unapproved import).
  let discovered = input.discovered;
  if (!discovered?.length) {
    const byName = new Map<string, CatalogToolDescriptor>();
    for (const d of defaultBuiltinCatalog()) byName.set(d.name, d);
    for (const d of listReviewedWebCatalogDescriptors()) {
      byName.set(d.name, d as CatalogToolDescriptor);
    }
    for (const t of input.approvedTools ?? []) {
      if ((t.origin === "extension" || t.origin === "custom") && t.sourcePath && existsSync(t.sourcePath)) {
        const existing = byName.get(t.name) as
          | (CatalogToolDescriptor & {
              catalogMode?: string;
              executableDigest?: string;
              schemaHash?: string;
              configHash?: string;
              hookInventory?: string[];
            })
          | undefined;
        const existingMode =
          existing?.catalogMode ??
          (existing?.schema &&
          typeof existing.schema === "object" &&
          (existing.schema as { catalogMode?: string }).catalogMode);
        if (existing && existingMode === "reviewed_actual") {
          // Preserve actual discovered descriptor through live policy construction.
          continue;
        }
        // Restate approved identity with frozen digests/hooks — never synthesize a new schema hash.
        byName.set(t.name, {
          name: t.name,
          description: t.description ?? "",
          origin: t.origin,
          sourcePath: t.sourcePath,
          sourceIdentity: t.sourceIdentity,
          schema: {
            name: t.name,
            schemaHash: t.schemaHash,
            configHash: t.configHash,
            hooks: t.hookInventory ?? [],
            catalogMode: "approved_restated",
          },
          risks: t.risks,
          credentialHandles: t.credentialHandles,
          executableDigest: t.executableDigest,
          schemaHash: t.schemaHash,
          configHash: t.configHash,
          hookInventory: t.hookInventory ?? [],
          catalogMode: "approved_restated",
        } as CatalogToolDescriptor & { catalogMode?: string });
      } else if (t.origin === "builtin" && !byName.has(t.name)) {
        const builtin = defaultAutomationCatalog().find((x) => x.name === t.name);
        if (builtin) byName.set(t.name, builtin);
      }
    }
    discovered = [...byName.values()];
  }

  void input.cwd;
  return {
    tools: discovered,
    // SDK write/edit resolve absolute paths outside cwd — confinement is unproven in v1.
    cwdConfinementProven: false,
  };
}

/** Probe whether a provider/model pair is actually resolvable via installed SDK ModelRuntime. */
export async function probeModelAvailability(input: {
  cwd: string;
  provider: string;
  modelId: string;
}): Promise<boolean> {
  if (!input.provider?.trim() || !input.modelId?.trim()) return false;
  // Canonical cwd must exist/authorized before model authority is considered valid.
  if (!input.cwd?.trim() || !existsSync(input.cwd)) return false;
  try {
    const sdk = (await import("@earendil-works/pi-coding-agent")) as {
      getAgentDir?: () => string;
      ModelRuntime?: {
        create?: (opts?: {
          authPath?: string;
          modelsPath?: string | null;
          allowModelNetwork?: boolean;
        }) => Promise<{
          getModel?: (p: string, m: string) => unknown;
          hasConfiguredAuth?: (p: string) => boolean;
        }>;
      };
      ModelRegistry?: new (runtime: unknown) => {
        // 0.84+ returns ModelsRefreshResult; callers only need the promise to settle.
        refresh?: () => Promise<unknown>;
        find?: (p: string, m: string) => unknown;
        getAll?: () => unknown[];
      };
      AuthStorage?: { create?: (authPath?: string) => unknown };
    };
    const agentDir = sdk.getAgentDir?.() ?? process.env.PI_CODING_AGENT_DIR;
    if (!sdk.ModelRuntime?.create || !agentDir) {
      // fall through
    } else {
      const { join } = await import("path");
      const authPath = join(agentDir, "auth.json");
      const modelsPath = join(agentDir, "models.json");
      const runtime = await sdk.ModelRuntime.create({
        authPath,
        modelsPath: existsSync(modelsPath) ? modelsPath : null,
        allowModelNetwork: false,
      });
      // Require real credential store / hasConfiguredAuth — catalog presence alone is insufficient.
      const hasAuth =
        typeof runtime.hasConfiguredAuth === "function"
          ? runtime.hasConfiguredAuth(input.provider)
          : (() => {
              try {
                if (!existsSync(authPath)) return false;
                const raw = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
                return Boolean(raw[input.provider]);
              } catch {
                return false;
              }
            })();
      if (!hasAuth) return false;

      const direct = runtime.getModel?.(input.provider, input.modelId);
      if (direct) return true;
      if (sdk.ModelRegistry) {
        const registry = new sdk.ModelRegistry(runtime);
        await registry.refresh?.();
        const found = registry.find?.(input.provider, input.modelId);
        if (found) return true;
      }
      return false;
    }
  } catch {
    // fall through to models.json + auth.json probe
  }
  try {
    const { join } = await import("path");
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    if (!agentDir) return false;
    const modelsPath = join(agentDir, "models.json");
    const authPath = join(agentDir, "auth.json");
    if (!existsSync(modelsPath) || !existsSync(authPath)) return false;
    const raw = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      providers?: Record<string, { models?: Array<{ id?: string }> }>;
    };
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
    if (!auth[input.provider]) return false;
    const models = raw.providers?.[input.provider]?.models ?? [];
    return models.some((m) => m.id === input.modelId);
  } catch {
    return false;
  }
}

/**
 * Probe credential handle presence against real provider/tool credential stores.
 * Handles may be env var names or provider ids stored in AuthStorage.
 */
export function probeCredentialHandlesOk(handles: string[] | undefined): boolean {
  if (!handles?.length) return true;
  let authList: Array<{ provider?: string; id?: string }> | null = null;
  try {
    // Read real auth storage file (identifier presence only — never values in logs).
    const agentDir = getAgentDirLocal();
    const authPath = pathJoin(agentDir, "auth.json");
    if (existsSync(authPath)) {
      try {
        const raw = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
        authList = Object.keys(raw).map((k) => ({ provider: k, id: k }));
      } catch {
        authList = [];
      }
    } else {
      authList = [];
    }
  } catch {
    authList = null;
  }

  for (const id of handles) {
    if (!id) return false;
    if (process.env[id] != null && process.env[id] !== "") continue;
    if (authList?.some((c) => c.provider === id || c.id === id)) continue;
    return false;
  }
  return true;
}

/** List models available for a target cwd via ModelRuntime (for UI pickers). */
export async function listModelsForTargetCwd(input: {
  cwd: string;
}): Promise<Array<{ provider: string; id: string; name?: string; hasAuth?: boolean }>> {
  // Target cwd must exist and be a directory; otherwise fail closed.
  if (!input.cwd?.trim() || !existsSync(input.cwd)) return [];
  try {
    const st = statSync(input.cwd);
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }
  try {
    const sdk = (await import("@earendil-works/pi-coding-agent")) as {
      getAgentDir?: () => string;
      ModelRuntime?: {
        create?: (opts?: {
          authPath?: string;
          modelsPath?: string | null;
          allowModelNetwork?: boolean;
        }) => Promise<{
          getModels?: () => ReadonlyArray<{ id?: string; provider?: string; name?: string }>;
          getProviders?: () => ReadonlyArray<{ id?: string }>;
          hasConfiguredAuth?: (p: string) => boolean;
        }>;
      };
      ModelRegistry?: new (runtime: unknown) => {
        // 0.84+ returns ModelsRefreshResult; callers only need the promise to settle.
        refresh?: () => Promise<unknown>;
        getAll?: () => Array<{ id?: string; provider?: string; name?: string }>;
      };
    };
    const agentDir = sdk.getAgentDir?.() ?? process.env.PI_CODING_AGENT_DIR;
    if (!sdk.ModelRuntime?.create || !agentDir) return [];
    const { join } = await import("path");
    const runtime = await sdk.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: existsSync(join(agentDir, "models.json")) ? join(agentDir, "models.json") : null,
      allowModelNetwork: false,
    });
    const hasAuth = (provider: string): boolean => {
      if (typeof runtime.hasConfiguredAuth === "function") {
        try {
          return runtime.hasConfiguredAuth(provider);
        } catch {
          return false;
        }
      }
      try {
        const authPath = join(agentDir, "auth.json");
        if (!existsSync(authPath)) return false;
        const raw = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
        return Boolean(raw[provider]);
      } catch {
        return false;
      }
    };
    if (sdk.ModelRegistry) {
      const registry = new sdk.ModelRegistry(runtime);
      await registry.refresh?.();
      const all = registry.getAll?.() ?? [];
      // Only return models whose provider has configured auth (or extension-provided
      // models that ModelRuntime can resolve with hasConfiguredAuth).
      return all
        .filter((m) => m.provider && m.id && hasAuth(m.provider))
        .map((m) => ({
          provider: m.provider!,
          id: m.id!,
          name: m.name,
          hasAuth: true,
        }));
    }
    const models = runtime.getModels?.() ?? [];
    return models
      .filter((m) => m.provider && m.id && hasAuth(m.provider))
      .map((m) => ({
        provider: m.provider!,
        id: m.id!,
        name: m.name,
        hasAuth: true,
      }));
  } catch {
    return [];
  }
}

// Avoid unused import warnings in some TS configs
void hashJson;
