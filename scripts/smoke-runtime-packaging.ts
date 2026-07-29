import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import nextConfig from "../next.config";
import {
  isCompiledDiscoveryWorkerArtifact,
  resolveDiscoveryWorkerPath,
} from "../lib/automation-extension-discovery";
import { isCompiledWorkerArtifact, resolveWorkerHostPath } from "../lib/automation-runner";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function checkServerExternals(): void {
  assert(
    nextConfig.serverExternalPackages?.includes("ws"),
    "ws must remain external so its optional native modules resolve at runtime",
  );
}

function checkPublishedLauncher(): void {
  const launcher = readFileSync(join(ROOT, "bin", "pi-web.js"), "utf8");
  const executableSource = launcher
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  assert(!/shell\s*:\s*true/.test(executableSource), "published launcher must not spawn with shell: true");
  assert(launcher.includes('"explorer.exe"'), "Windows browser launch must use explorer.exe directly");
}

/**
 * Automation worker must be a stable standalone artifact available for both
 * next dev and next build/start, and included in output tracing / published files.
 */
function checkAutomationWorkerArtifact(): void {
  const runtime = join(ROOT, "lib", "automation-worker-runtime.cjs");
  const meta = join(ROOT, "lib", "automation-worker-runtime.meta.json");
  const hostTs = join(ROOT, "lib", "automation-worker-host.ts");
  const discoveryRuntime = join(ROOT, "lib", "automation-extension-discovery-runtime.cjs");
  const discoveryMeta = join(ROOT, "lib", "automation-extension-discovery-runtime.meta.json");
  const discoveryHostTs = join(ROOT, "lib", "automation-extension-discovery-host.ts");

  assert(existsSync(hostTs), "lib/automation-worker-host.ts source must exist");
  assert(existsSync(discoveryHostTs), "lib/automation-extension-discovery-host.ts source must exist");

  if (!existsSync(runtime)) {
    const built = spawnSync(process.execPath, [join(ROOT, "scripts", "build-automation-worker.mjs")], {
      cwd: ROOT,
      stdio: "inherit",
    });
    assert(built.status === 0, "failed to build automation-worker-runtime.cjs");
  }
  if (!existsSync(discoveryRuntime)) {
    const built = spawnSync(
      process.execPath,
      [join(ROOT, "scripts", "build-automation-discovery-worker.mjs")],
      { cwd: ROOT, stdio: "inherit" },
    );
    assert(built.status === 0, "failed to build automation-extension-discovery-runtime.cjs");
  }

  assert(existsSync(runtime), "lib/automation-worker-runtime.cjs must exist after build");
  assert(
    existsSync(discoveryRuntime),
    "lib/automation-extension-discovery-runtime.cjs must exist after build",
  );
  const st = statSync(runtime);
  assert(st.isFile() && st.size > 1000, "automation-worker-runtime.cjs must be a non-trivial file");
  const dst = statSync(discoveryRuntime);
  assert(
    dst.isFile() && dst.size > 500,
    "automation-extension-discovery-runtime.cjs must be a non-trivial file",
  );

  const body = readFileSync(runtime, "utf8");
  assert(
    /automation-worker-(host|runtime)/.test(body) || /WorkerJob|runJob/.test(body),
    "worker runtime must contain worker host entry markers",
  );
  // Child refuses ambient NODE_OPTIONS injection.
  assert(/NODE_OPTIONS/.test(body), "worker runtime must guard NODE_OPTIONS");

  const discoveryBody = readFileSync(discoveryRuntime, "utf8");
  assert(
    /discoverExtensionRegistrationFromBytes|DiscoveryWorker|registration/.test(discoveryBody),
    "discovery runtime must contain discovery entry markers",
  );

  if (existsSync(meta)) {
    const m = JSON.parse(readFileSync(meta, "utf8")) as { sha256?: string; size?: number };
    assert(typeof m.sha256 === "string" && m.sha256.length === 64, "worker meta sha256 required");
  }
  if (existsSync(discoveryMeta)) {
    const m = JSON.parse(readFileSync(discoveryMeta, "utf8")) as { sha256?: string; size?: number };
    assert(typeof m.sha256 === "string" && m.sha256.length === 64, "discovery meta sha256 required");
  }

  // Tracing includes must reference both artifacts.
  const includes = (nextConfig as { outputFileTracingIncludes?: Record<string, string[]> })
    .outputFileTracingIncludes;
  assert(includes, "outputFileTracingIncludes must be configured for the worker artifact");
  const all = Object.values(includes ?? {}).flat().join("\n");
  assert(
    all.includes("automation-worker-runtime.cjs"),
    "outputFileTracingIncludes must include automation-worker-runtime.cjs",
  );
  assert(
    all.includes("automation-extension-discovery-runtime.cjs"),
    "outputFileTracingIncludes must include automation-extension-discovery-runtime.cjs",
  );

  // Published package files list must include lib/ (where the artifact lives).
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files?: string[] };
  assert(
    Array.isArray(pkg.files) && pkg.files.some((f) => f === "lib" || f.startsWith("lib/")),
    "package.json files must include lib for published worker runtime",
  );

  // Deterministic resolver from package root (not Next chunk-adjacent).
  const resolved = resolveWorkerHostPath();
  assert(existsSync(resolved), `resolveWorkerHostPath returned missing path: ${resolved}`);
  assert(
    isCompiledWorkerArtifact(resolved) || resolved.endsWith("automation-worker-host.ts"),
    `resolveWorkerHostPath must return stable runtime or ts source, got ${resolved}`,
  );

  const discoveryResolved = resolveDiscoveryWorkerPath();
  assert(
    existsSync(discoveryResolved),
    `resolveDiscoveryWorkerPath returned missing path: ${discoveryResolved}`,
  );
  assert(
    isCompiledDiscoveryWorkerArtifact(discoveryResolved) ||
      discoveryResolved.endsWith("automation-extension-discovery-host.ts"),
    `resolveDiscoveryWorkerPath must return stable runtime or ts source, got ${discoveryResolved}`,
  );

  // Next server modules must not import the extension runtime (createRequire warnings).
  const toolPolicy = readFileSync(join(ROOT, "lib", "automation-tool-policy.ts"), "utf8");
  const service = readFileSync(join(ROOT, "lib", "automation-service.ts"), "utf8");
  assert(
    !toolPolicy.includes('from "./automation-extension-runtime"') &&
      !toolPolicy.includes('import("./automation-extension-runtime")'),
    "tool-policy must not import automation-extension-runtime in-process",
  );
  assert(
    !service.includes('from "./automation-extension-runtime"') &&
      !service.includes('import("./automation-extension-runtime")'),
    "automation-service must not import automation-extension-runtime in-process",
  );

  console.log(`WORKER_ARTIFACT_OK path=${resolved}`);
  console.log(`DISCOVERY_ARTIFACT_OK path=${discoveryResolved}`);
}

checkServerExternals();
checkPublishedLauncher();
checkAutomationWorkerArtifact();
console.log("runtime packaging smoke checks passed");
