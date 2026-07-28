/**
 * Focused config round-trip: legacy raw pi-web.json.trellis must survive
 * unrelated supported section patches and must not appear in the public projection.
 * Run: npx --yes tsx scripts/smoke-pi-web-config-legacy-trellis.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import path from "path";
import {
  DEFAULT_PI_WEB_CONFIG,
  getPiWebConfigPath,
  PiWebConfigValidationError,
  readPiWebConfigForApi,
  writePiWebConfigPatch,
} from "../lib/pi-web-config";

/** Match pi SDK getAgentDir/expandTildePath semantics via the exported config path helper. */
function assertAgentDirPathParity(): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = "~";
    assert.equal(
      getPiWebConfigPath(),
      path.join(homedir(), "pi-web.json"),
      "exact ~ expands to homedir",
    );

    process.env.PI_CODING_AGENT_DIR = "~/agent-custom";
    assert.equal(
      getPiWebConfigPath(),
      path.join(homedir(), "agent-custom", "pi-web.json"),
      "~/... expands under homedir",
    );

    if (process.platform === "win32") {
      process.env.PI_CODING_AGENT_DIR = "~\\agent-win";
      assert.equal(
        getPiWebConfigPath(),
        path.join(homedir(), "agent-win", "pi-web.json"),
        "Windows ~\\... expands under homedir",
      );
    }

    const plain = path.join(tmpdir(), "plain-agent-dir");
    process.env.PI_CODING_AGENT_DIR = plain;
    assert.equal(
      getPiWebConfigPath(),
      path.join(plain, "pi-web.json"),
      "non-tilde absolute override is preserved unchanged",
    );

    // SDK expandTildePath does not trim; whitespace-bearing values stay as-is.
    process.env.PI_CODING_AGENT_DIR = ` ${plain} `;
    assert.equal(
      getPiWebConfigPath(),
      path.join(` ${plain} `, "pi-web.json"),
      "whitespace around non-tilde override is preserved (no trim)",
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

const agentDir = mkdtempSync(path.join(tmpdir(), "pi-web-config-legacy-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

try {
  const configPath = path.join(agentDir, "pi-web.json");
  const legacyTrellis = {
    enabled: true,
    includeArchived: true,
    proxyEnabled: true,
    proxyUrl: "https://legacy.example/proxy",
    workflowAssistant: {
      model: { mode: "specific", provider: "openai", modelId: "gpt-test" },
      thinking: "high",
    },
    workflowAssistantFallback: {
      model: { mode: "piDefault" },
      thinking: "minimal",
    },
    subagents: {
      enabled: true,
      defaultPolicy: {
        model: { mode: "followMain" },
        thinking: "inherit",
      },
      router: {
        enabled: false,
        model: { mode: "piDefault" },
        thinking: "minimal",
        fallbackOnError: { modality: "text", tier: "standard" },
      },
      routes: {
        text: {
          simple: { model: { mode: "followMain" }, thinking: "inherit" },
          standard: { model: { mode: "followMain" }, thinking: "inherit" },
          complex: { model: { mode: "followMain" }, thinking: "high" },
          critical: { model: { mode: "followMain" }, thinking: "xhigh" },
        },
        multimodal: {
          simple: { model: { mode: "followMain" }, thinking: "inherit" },
          standard: { model: { mode: "followMain" }, thinking: "medium" },
          complex: { model: { mode: "followMain" }, thinking: "high" },
          critical: { model: { mode: "followMain" }, thinking: "xhigh" },
        },
      },
      agents: {
        "trellis-implement": { strategy: "default", minimumTier: "complex" },
      },
    },
    customLegacyMarker: "keep-me-intact",
  };

  writeFileSync(
    configPath,
    `${JSON.stringify({
      worktree: DEFAULT_PI_WEB_CONFIG.worktree,
      usage: { includeArchived: false },
      trellis: legacyTrellis,
    }, null, 2)}\n`,
    "utf8",
  );

  const before = readPiWebConfigForApi();
  assert.equal(before.exists, true, "legacy config file is readable");
  assert.equal(before.path, configPath, "config path uses PI_CODING_AGENT_DIR override");
  assert.equal(
    Object.prototype.hasOwnProperty.call(before.config, "trellis"),
    false,
    "public projection must omit trellis",
  );
  assert.equal(before.config.usage.includeArchived, false, "supported section still normalizes");
  assert.deepEqual(
    before.config.terminal.envAssistant,
    DEFAULT_PI_WEB_CONFIG.terminal.envAssistant,
    "terminal env assistant defaults remain available without trellis fallback",
  );

  const patched = writePiWebConfigPatch({
    usage: { includeArchived: true },
    workflow: { includeArchived: true, trackInGit: false },
  });
  assert.equal(patched.config.usage.includeArchived, true, "usage patch applies");
  assert.equal(patched.config.workflow.includeArchived, true, "workflow patch applies");
  assert.equal(
    Object.prototype.hasOwnProperty.call(patched.config, "trellis"),
    false,
    "API response still omits trellis after patch",
  );

  const rawAfter = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(rawAfter.trellis, legacyTrellis, "raw trellis object survives unrelated supported patches");
  assert.deepEqual(rawAfter.usage, { includeArchived: true }, "usage section is rewritten");
  assert.deepEqual(
    rawAfter.workflow,
    { includeArchived: true, trackInGit: false },
    "workflow section is written",
  );

  assert.throws(
    () => writePiWebConfigPatch({ trellis: { enabled: false } } as never),
    (error: unknown) => error instanceof PiWebConfigValidationError
      && /no supported config sections provided/.test(error.message),
    "trellis-only patch is rejected as unsupported",
  );

  const rawRejected = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(rawRejected.trellis, legacyTrellis, "rejected trellis patch leaves raw data untouched");

  assertAgentDirPathParity();

  console.log("smoke-pi-web-config-legacy-trellis: OK");
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
}
