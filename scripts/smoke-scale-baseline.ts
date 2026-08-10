/**
 * Scale baseline + regression smoke for Usage / allowed-roots / long JSONL.
 *
 * Default size stays small for CI (seconds). Override with:
 *   SCALE_SESSION_COUNT=1000 SCALE_MESSAGE_COUNT=500 npx tsx scripts/smoke-scale-baseline.ts
 *
 * Prints a timing table and asserts functional correctness of the accelerated paths.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const SESSION_COUNT = Math.max(1, Number(process.env.SCALE_SESSION_COUNT || 40));
const MESSAGE_COUNT = Math.max(1, Number(process.env.SCALE_MESSAGE_COUNT || 120));
const LARGE_MESSAGE_COUNT = Math.max(MESSAGE_COUNT, Number(process.env.SCALE_LARGE_MESSAGE_COUNT || 500));

const root = mkdtempSync(join(tmpdir(), "pi-web-scale-baseline-"));
const agentDir = join(root, "agent");
const cwdA = join(root, "workspace-a");
const cwdB = join(root, "workspace-b");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(cwdA, { recursive: true });
mkdirSync(cwdB, { recursive: true });
mkdirSync(join(agentDir, "sessions"), { recursive: true });

function encodeSessionDirName(cwd: string): string {
  const resolved = cwd.replace(/\\/g, "/");
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function writeSession(opts: {
  projectCwd: string;
  id: string;
  timestamp: string;
  messageCount: number;
  costPerAssistant?: number;
}) {
  const dir = join(agentDir, "sessions", encodeSessionDirName(opts.projectCwd));
  mkdirSync(dir, { recursive: true });
  const fileStamp = opts.timestamp.replace(/[:.]/g, "-");
  const filePath = join(dir, `${fileStamp}_${opts.id}.jsonl`);
  const lines: Array<Record<string, unknown>> = [
    {
      type: "session",
      version: 3,
      id: opts.id,
      timestamp: opts.timestamp,
      cwd: opts.projectCwd,
    },
  ];

  let parentId: string | null = null;
  for (let i = 0; i < opts.messageCount; i++) {
    const userId = `${opts.id}-u${i}`;
    const assistantId = `${opts.id}-a${i}`;
    const ts = new Date(Date.parse(opts.timestamp) + i * 1000).toISOString();
    lines.push({
      type: "message",
      id: userId,
      parentId,
      timestamp: ts,
      message: {
        role: "user",
        content: [{ type: "text", text: `user ${i} for ${opts.id}` }],
      },
    });
    parentId = userId;
    const cost = opts.costPerAssistant ?? 0.01;
    lines.push({
      type: "message",
      id: assistantId,
      parentId,
      timestamp: ts,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `assistant ${i}` }],
        provider: "test-provider",
        model: "test-model",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
        },
      },
    });
    parentId = assistantId;
  }

  writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return filePath;
}

function formatMs(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

function rssMb(): string {
  return `${(process.memoryUsage().rss / (1024 * 1024)).toFixed(1)}MB`;
}

async function timeAsync<T>(label: string, fn: () => Promise<T>): Promise<{ label: string; ms: number; value: T }> {
  const start = performance.now();
  const value = await fn();
  return { label, ms: performance.now() - start, value };
}

async function main() {
  const timings: Array<{ label: string; ms: number; detail?: string }> = [];

  try {
    // Split sessions across two cwds so cwd-scoped usage is meaningfully smaller.
    const half = Math.floor(SESSION_COUNT / 2);
    for (let i = 0; i < SESSION_COUNT; i++) {
      const projectCwd = i < half ? cwdA : cwdB;
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      writeSession({
        projectCwd,
        id: `sess-${i}`,
        timestamp: ts,
        messageCount: i === 0 ? LARGE_MESSAGE_COUNT : Math.min(MESSAGE_COUNT, 20),
        costPerAssistant: 0.01,
      });
    }

    // Dynamic imports after PI_CODING_AGENT_DIR is set.
    const {
      refreshSessionIndex,
      getSessionIndexCwdRoots,
      getSessionIndexEntriesForCwd,
      resetSessionIndexRuntimeForTests,
    } = await import("../lib/session-index");
    const { getAllowedRoots, registerAllowedRoot, isPathAllowed } = await import("../lib/allowed-roots");
    const { getUsageStats } = await import("../lib/usage-stats");
    const { readFileSync } = await import("node:fs");

    resetSessionIndexRuntimeForTests();

    const indexCold = await timeAsync("session-index refresh (cold)", () => refreshSessionIndex({ force: true }));
    timings.push({
      label: indexCold.label,
      ms: indexCold.ms,
      detail: `${indexCold.value.length} entries`,
    });
    assert.equal(indexCold.value.length, SESSION_COUNT, "index lists all synthetic sessions");

    const indexWarm = await timeAsync("session-index refresh (warm)", () => refreshSessionIndex());
    timings.push({
      label: indexWarm.label,
      ms: indexWarm.ms,
      detail: `${indexWarm.value.length} entries`,
    });

    const rootsFromIndex = await timeAsync("session-index cwd roots", () => getSessionIndexCwdRoots());
    timings.push({
      label: rootsFromIndex.label,
      ms: rootsFromIndex.ms,
      detail: `${rootsFromIndex.value.length} roots`,
    });
    assert.ok(rootsFromIndex.value.some((r) => r.replace(/\\/g, "/").includes("workspace-a")));
    assert.ok(rootsFromIndex.value.some((r) => r.replace(/\\/g, "/").includes("workspace-b")));

    // Clear allowed-roots cache between cold measurements.
    (globalThis as { __piAllowedRootsCache?: unknown }).__piAllowedRootsCache = undefined;
    registerAllowedRoot(cwdA);
    const allowedCold = await timeAsync("allowed-roots (cold)", () => getAllowedRoots());
    timings.push({
      label: allowedCold.label,
      ms: allowedCold.ms,
      detail: `${allowedCold.value.size} roots`,
    });
    assert.equal(isPathAllowed(join(cwdA, "file.ts"), allowedCold.value), true);
    assert.equal(isPathAllowed(join(cwdB, "file.ts"), allowedCold.value), true);

    const allowedWarm = await timeAsync("allowed-roots (warm cache)", () => getAllowedRoots());
    timings.push({
      label: allowedWarm.label,
      ms: allowedWarm.ms,
      detail: `${allowedWarm.value.size} roots`,
    });
    assert.ok(allowedWarm.ms < 50 || allowedWarm.ms <= allowedCold.ms, "warm cache should be cheap");

    const range = {
      from: new Date("2025-12-31T00:00:00.000Z"),
      to: new Date("2026-12-31T23:59:59.999Z"),
      includeArchived: false as const,
    };

    const usageCwd = await timeAsync("usage stats (cwd scope)", () =>
      getUsageStats({ ...range, cwd: cwdA }),
    );
    timings.push({
      label: usageCwd.label,
      ms: usageCwd.ms,
      detail: `source=${usageCwd.value.scanSource} matched=${usageCwd.value.matchedSessions} cost=${usageCwd.value.totals.cost.toFixed(2)}`,
    });
    assert.equal(usageCwd.value.scanSource, "index");
    assert.equal(usageCwd.value.matchedSessions, half);
    assert.ok(usageCwd.value.durationMs >= 0);
    assert.ok(usageCwd.value.totals.cost > 0);

    const usageAll = await timeAsync("usage stats (all cwds)", () => getUsageStats({ ...range }));
    timings.push({
      label: usageAll.label,
      ms: usageAll.ms,
      detail: `source=${usageAll.value.scanSource} matched=${usageAll.value.matchedSessions} cost=${usageAll.value.totals.cost.toFixed(2)}`,
    });
    assert.equal(usageAll.value.scanSource, "index");
    assert.equal(usageAll.value.matchedSessions, SESSION_COUNT);
    assert.ok(usageAll.value.totals.cost >= usageCwd.value.totals.cost);

    const cwdEntries = await getSessionIndexEntriesForCwd(cwdA);
    assert.equal(cwdEntries.length, half);

    // Long JSONL parse baseline (largest synthetic transcript).
    const largePath = cwdEntries
      .map((e) => e.path)
      .find((p) => p.includes("sess-0")) ?? indexCold.value.find((e) => e.id === "sess-0")?.path;
    assert.ok(largePath, "large session path");
    const largeStat = statSync(largePath!);
    const parseLarge = await timeAsync("long JSONL line parse", async () => {
      const raw = readFileSync(largePath!, "utf8");
      let count = 0;
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        JSON.parse(line);
        count += 1;
      }
      return count;
    });
    timings.push({
      label: parseLarge.label,
      ms: parseLarge.ms,
      detail: `${parseLarge.value} lines · ${(largeStat.size / 1024).toFixed(1)}KB`,
    });
    // header + user/assistant pairs
    assert.ok(parseLarge.value >= LARGE_MESSAGE_COUNT * 2);

    console.log("\n=== Scale baseline ===");
    console.log(`sessions=${SESSION_COUNT} messageCount(default)=${MESSAGE_COUNT} largeMessages=${LARGE_MESSAGE_COUNT}`);
    console.log(`rss=${rssMb()} agentDir=${agentDir}`);
    console.log("---------------------------------------------");
    for (const row of timings) {
      console.log(`${row.label.padEnd(34)} ${formatMs(row.ms).padStart(10)}  ${row.detail ?? ""}`);
    }
    console.log("---------------------------------------------");
    console.log("scale baseline smoke checks passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
  process.exitCode = 1;
});
