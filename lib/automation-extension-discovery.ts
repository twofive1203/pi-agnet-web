/**
 * Reviewed-extension discovery client.
 *
 * Catalog / authority paths never import automation-extension-runtime in the
 * Next server process. Factory evaluation runs only inside the standalone
 * compiled discovery worker, and only after the trusted reviewed registry
 * accepts the live immutable digests (fail closed on drift/missing).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { hashPathClosure } from "./automation-resource-catalog";
import {
  assertReviewedExtensionDigestsMatch,
  isReviewedExtensionDigest,
  type ReviewedExtensionRegistryEntry,
} from "./automation-reviewed-extension-registry";

/** Mirrors discovery-worker registration result without importing the runtime module. */
export type DiscoveredExtensionRegistration = {
  sourcePath: string;
  entryRel: string;
  bundleSha256: string;
  packageClosure: string[];
  tools: Array<{
    name: string;
    description?: string;
    parameters?: unknown;
    label?: string;
  }>;
  hooks: string[];
  flags: string[];
};

export const AUTOMATION_DISCOVERY_RUNTIME_REL = "lib/automation-extension-discovery-runtime.cjs";

function findPackageRoot(): string {
  const starts: string[] = [];
  if (typeof __dirname !== "undefined") starts.push(__dirname);
  try {
    const meta = (import.meta as { url?: string }).url;
    if (meta) starts.push(dirname(fileURLToPath(meta)));
  } catch {
    // ignore
  }
  starts.push(process.cwd());
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 8; i += 1) {
      const pkg = join(dir, "package.json");
      if (existsSync(pkg)) {
        try {
          const raw = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string };
          if (
            raw.name === "@twofive/snail-pi-web" ||
            existsSync(join(dir, AUTOMATION_DISCOVERY_RUNTIME_REL)) ||
            existsSync(join(dir, "lib", "automation-extension-discovery-host.ts"))
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
 * Resolve the standalone discovery worker artifact (never Next-chunk adjacent).
 */
export function resolveDiscoveryWorkerPath(): string {
  if (process.env.AUTOMATION_DISCOVERY_WORKER_PATH) {
    const explicit = process.env.AUTOMATION_DISCOVERY_WORKER_PATH;
    if (existsSync(explicit)) return explicit;
  }
  const root = findPackageRoot();
  const runtime = join(root, AUTOMATION_DISCOVERY_RUNTIME_REL);
  if (existsSync(runtime)) return runtime;
  const ts = join(root, "lib", "automation-extension-discovery-host.ts");
  if (existsSync(ts)) return ts;
  const dir =
    typeof __dirname !== "undefined"
      ? __dirname
      : dirname(fileURLToPath((import.meta as { url?: string }).url ?? `file://${__filename}`));
  const siblingRuntime = join(dir, "automation-extension-discovery-runtime.cjs");
  if (existsSync(siblingRuntime)) return siblingRuntime;
  return join(dir, "automation-extension-discovery-host.ts");
}

export function isCompiledDiscoveryWorkerArtifact(path: string): boolean {
  return /automation-extension-discovery-runtime\.cjs$/.test(path.replace(/\\/g, "/"));
}

export type ReviewedDiscoveryResult = {
  registration: DiscoveredExtensionRegistration;
  registryEntry: ReviewedExtensionRegistryEntry;
  liveClosureDigest: string;
  liveBundleSha256: string;
};

/**
 * Discover actual tool/schema/hook registrations for a reviewed extension only.
 * Blocks before any factory evaluation when the digest is missing or drifted.
 */
export async function discoverReviewedExtensionRegistration(input: {
  sourcePath: string;
  agentDir?: string;
  /** Optional precomputed closure digest; recomputed when omitted. */
  liveClosureDigest?: string;
}): Promise<ReviewedDiscoveryResult> {
  const liveClosureDigest =
    input.liveClosureDigest ?? hashPathClosure(input.sourcePath);

  // Trust gate BEFORE bundling side effects that are heavier, and always before factory.
  const registryEntry = assertReviewedExtensionDigestsMatch({
    liveClosureDigest,
    agentDir: input.agentDir,
  });

  const { buildExtensionBundle } = await import("./automation-runner");
  const built = buildExtensionBundle(input.sourcePath);

  // Second gate: if registry pins bundle sha, enforce exact match before fork/factory.
  assertReviewedExtensionDigestsMatch({
    liveClosureDigest: built.closureDigest,
    liveBundleSha256: built.bundleSha256,
    agentDir: input.agentDir,
  });

  if (built.closureDigest !== liveClosureDigest) {
    // Bundle builder and path-closure disagreed — fail closed.
    throw new Error(
      `extension closure digest inconsistent before factory: path=${liveClosureDigest.slice(0, 12)} bundle=${built.closureDigest.slice(0, 12)}`,
    );
  }

  const registration = await runDiscoveryWorker({
    bundleBytesBase64: built.bundleBytes.toString("base64"),
    expectedSha256: built.bundleSha256,
    sourcePath: input.sourcePath,
  });

  return {
    registration,
    registryEntry,
    liveClosureDigest: built.closureDigest,
    liveBundleSha256: built.bundleSha256,
  };
}

/**
 * Static-only check used by catalog enumeration (no factory, no worker).
 */
export function tryGetReviewedExtensionTrust(input: {
  sourcePath: string;
  agentDir?: string;
}): { trusted: true; closureDigest: string; entry: ReviewedExtensionRegistryEntry } | {
  trusted: false;
  closureDigest: string;
  reason: "not_reviewed" | "invalid_digest";
} {
  const closureDigest = hashPathClosure(input.sourcePath);
  if (!/^[a-f0-9]{64}$/i.test(closureDigest)) {
    return { trusted: false, closureDigest, reason: "invalid_digest" };
  }
  if (!isReviewedExtensionDigest(closureDigest, input.agentDir)) {
    return { trusted: false, closureDigest, reason: "not_reviewed" };
  }
  const entry = assertReviewedExtensionDigestsMatch({
    liveClosureDigest: closureDigest,
    agentDir: input.agentDir,
  });
  return { trusted: true, closureDigest, entry };
}

async function runDiscoveryWorker(req: {
  bundleBytesBase64: string;
  expectedSha256: string;
  sourcePath: string;
}): Promise<DiscoveredExtensionRegistration> {
  const workerPath = resolveDiscoveryWorkerPath();
  if (!existsSync(workerPath)) {
    throw new Error(
      `Automation discovery worker missing at ${workerPath}. Run scripts/build-automation-discovery-worker.mjs or npm run build.`,
    );
  }

  const execArgv = workerPath.endsWith(".ts") ? ["--import", "tsx"] : [];
  const payload = JSON.stringify(req);

  return await new Promise<DiscoveredExtensionRegistration>((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = {
      // Minimal env — no ambient NODE_OPTIONS / secrets.
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      LANG: process.env.LANG,
      NODE_ENV: process.env.NODE_ENV ?? "production",
    };
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [...execArgv, workerPath],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
        windowsHide: true,
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });

    child.on("error", (err: Error) => {
      reject(new Error(`discovery worker spawn failed: ${err.message}`));
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(new Error("discovery worker timed out"));
    }, 30_000);

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(
          new Error(
            `discovery worker produced no output (code=${code}): ${stderr.slice(0, 400)}`,
          ),
        );
        return;
      }
      try {
        const parsed = JSON.parse(trimmed) as
          | { ok: true; registration: DiscoveredExtensionRegistration }
          | { ok: false; error: string };
        if (!parsed || typeof parsed !== "object") {
          reject(new Error("discovery worker response invalid"));
          return;
        }
        if ("ok" in parsed && parsed.ok === true && parsed.registration) {
          resolve(parsed.registration);
          return;
        }
        const errMsg =
          "error" in parsed && typeof parsed.error === "string"
            ? parsed.error
            : `discovery worker failed (code=${code})`;
        reject(new Error(errMsg));
      } catch (error) {
        reject(
          new Error(
            `discovery worker JSON parse failed: ${error instanceof Error ? error.message : String(error)}; stderr=${stderr.slice(0, 200)}`,
          ),
        );
      }
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}
