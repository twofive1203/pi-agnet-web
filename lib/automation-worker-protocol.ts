/**
 * Shared Automation worker protocol types and pure helpers.
 *
 * Kept free of automation-extension-runtime / createRequire so Next.js server
 * bundles can import these without dynamic createRequire warnings. Extension
 * factory evaluation stays in the standalone worker/discovery artifacts only.
 */

import {
  decideRequestBudget,
  estimateTextTokens,
} from "./automation-token-budget";
import { hashDirectoryClosure as hashPathClosureDir } from "./automation-resource-catalog";

/** Immutable extension artifact verified by parent before fork and re-checked in worker. */
export type WorkerExtensionArtifact = {
  /**
   * Authoritative verified bundle bytes (base64 of JSON map rel→bytes).
   * Execution loads factories exclusively from these in-memory bytes.
   */
  bundleBytesBase64: string;
  /** sha256 of the full bundle bytes (authoritative immutable artifact digest). */
  bundleSha256: string;
  /** Entry relative path inside the bundle. */
  entryRel: string;
  /** Original approved source identity for audit. */
  sourceIdentity: string;
  /** Original approved source path (metadata only; never imported). */
  sourcePath: string;
  /** Manifest/dependency closure digest (when packaged). */
  closureDigest?: string | null;
  /** Optional on-disk content-addressed cache of the bundle (never imported). */
  bundlePath?: string | null;
  /** @deprecated Legacy extract path — ignored for execution. */
  artifactPath?: string;
  /** @deprecated Legacy entry digest — ignored for execution. */
  sha256?: string;
  /** @deprecated Legacy package extract root — ignored for execution. */
  packageRoot?: string | null;
};

/** Exact reviewed web tool snapshot identity bound by parent. */
export type WorkerReviewedWebTool = {
  name: string;
  origin: "custom";
  sourceIdentity: string;
  executableDigest: string;
  schemaHash: string;
  configHash: string;
  description?: string;
  risks?: {
    headlessCompatible: boolean;
    localMutation: boolean;
    networkEgress: boolean;
    credentialUse: boolean;
    interactionRequired: boolean;
    blocked: boolean;
  };
};

export type WorkerJob = {
  taskId: string;
  runId: string;
  cwd: string;
  sessionDir: string;
  agentDir: string;
  prompt: string;
  model: { provider: string; modelId: string; thinking?: string | null };
  toolNames: string[];
  /** Verified immutable extension artifacts only — never raw mutable source paths. */
  extensionArtifacts: WorkerExtensionArtifact[];
  maxRuntimeMs: number;
  /** Hard total token ceiling for the run (input + output). */
  maxTokensPerRun: number;
  /** Pre-computed max output tokens = remaining budget after estimated input. */
  maxOutputTokens: number;
  /** Estimated input tokens already reserved against the ceiling. */
  estimatedInputTokens: number;
  /**
   * Exact reviewed web tool snapshots (schema/config/executable digests).
   * Prefer this over name-only reconstruction.
   */
  reviewedWebTools?: WorkerReviewedWebTool[];
  /** @deprecated Prefer reviewedWebTools with exact digests. */
  reviewedWebToolNames?: string[];
  /** Builtin tool schema digests bound by parent (name → schemaHash). */
  builtinSchemaDigests?: Record<string, string>;
};

/** Deterministic directory/file closure digest (shared with authorize-time hashing). */
export function hashDirectoryClosure(root: string): string {
  return hashPathClosureDir(root);
}

/** Estimate prompt tokens with a conservative char heuristic (+safety). */
export function estimatePromptTokens(text: string): number {
  return estimateTextTokens(text) + 256;
}

/**
 * Derive provider max output tokens from remaining budget after estimated input.
 */
export function deriveMaxOutputTokens(input: {
  maxTokensPerRun: number;
  estimatedInputTokens: number;
  safetyMargin?: number;
}): { ok: true; maxOutputTokens: number } | { ok: false; reason: string } {
  const decision = decideRequestBudget({
    maxTokensPerRun: input.maxTokensPerRun,
    spentTokens: 0,
    estimatedInputTokens: input.estimatedInputTokens,
    safetyMargin: input.safetyMargin,
  });
  if (!decision.ok) return { ok: false, reason: decision.reason };
  return { ok: true, maxOutputTokens: decision.maxOutputTokens };
}
