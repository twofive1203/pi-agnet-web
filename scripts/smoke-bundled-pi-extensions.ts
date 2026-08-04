import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLED_PI_EXTENSIONS,
  createBundledPiResourceLoader,
  getBundledPiExtensionRuntimeStatus,
  projectBundledPiSourceInfo,
} from "../lib/bundled-pi-extensions";
import { ExtensionWebUiBridge } from "../lib/extension-web-ui";
import { disposeAgentSession } from "../lib/pi-session-lifecycle";
import { preparePiRuntimeEnvironment } from "../lib/pi-runtime-resolver";

let failures = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (condition) console.log(`ok: ${message}`);
  else {
    failures += 1;
    console.error(`FAIL: ${message}`);
  }
}

function writeWebConfig(agentDir: string, bundledExtensions: Partial<Record<string, boolean>> = {}): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "pi-web.json"),
    `${JSON.stringify({ bundledExtensions }, null, 2)}\n`,
    "utf8",
  );
}

async function createRuntime(
  sdk: typeof import("@earendil-works/pi-coding-agent"),
  agentDir: string,
) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cwd = process.cwd();
  const loader = createBundledPiResourceLoader(sdk.DefaultResourceLoader, { cwd, agentDir });
  await loader.reload();
  const created = await sdk.createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
  });
  const bridge = new ExtensionWebUiBridge(() => {});
  await created.session.bindExtensions?.({
    uiContext: bridge.createContext() as never,
    mode: "rpc",
    commandContextActions: {
      waitForIdle: async () => {},
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {},
    },
  });
  return { loader, session: created.session };
}

async function main(): Promise<void> {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const root = mkdtempSync(join(tmpdir(), "spi-bundled-ext-smoke-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalPath = process.env.PATH;
  const originalPathMixed = process.env.Path;

  try {
    const freshAgentDir = join(root, "fresh-agent");
    writeWebConfig(freshAgentDir);
    const fresh = await createRuntime(sdk, freshAgentDir);
    try {
      const status = getBundledPiExtensionRuntimeStatus(fresh.loader);
      assert(status.length === BUNDLED_PI_EXTENSIONS.length, "registry reports every bundled extension");
      assert(status.every((item) => item.enabled && item.available && item.installedVersion === item.pinnedVersion), "fresh agent dir resolves every pinned bundle");

      const extensionSources = fresh.loader.getExtensions().extensions
        .map((extension) => extension.sourceInfo?.source)
        .filter((source): source is string => typeof source === "string");
      assert(extensionSources.filter((source) => source.startsWith("webui-bundled:")).length === 4, "resources are identified as WebUI-bundled");

      const toolNames = fresh.session.getAllTools().map((tool) => tool.name);
      for (const toolName of ["subagent", "subagent_wait", "web_search", "web_fetch", "ask_user", "manage_todo_list"]) {
        assert(toolNames.filter((name) => name === toolName).length === 1, `fresh agent dir exposes one ${toolName} tool`);
      }
      const webSearchTool = fresh.session.getAllTools().find((tool) => tool.name === "web_search");
      assert(projectBundledPiSourceInfo(webSearchTool?.sourceInfo)?.source === "webui-bundled:@juicesharp/rpiv-web-tools@2.3.1", "tool diagnostics project bundled provenance");
      const commandNames = fresh.session.extensionRunner.getRegisteredCommands().map((command) => command.invocationName);
      assert(commandNames.filter((name) => name === "web-tools").length === 1, "fresh session exposes one bundled /web-tools command without suffixes");
      const skillNames = fresh.loader.getSkills().skills.map((skill) => skill.name);
      assert(skillNames.includes("pi-subagents") && skillNames.includes("ask-user"), "bundled skills are discoverable");
      assert(fresh.loader.getPrompts().prompts.some((prompt) => prompt.name === "parallel-review"), "bundled prompt templates are discoverable");
      const { discoverAgents } = await import("../lib/pi-subagent-discovery");
      const discoveredAgents = await discoverAgents(process.cwd());
      assert(discoveredAgents.extensionAvailable && discoveredAgents.agents.some((agent) => agent.name === "scout"), "native agent discovery works from bundled pi-subagents");

      writeWebConfig(freshAgentDir, { "pi-manage-todo-list": false });
      await fresh.session.reload();
      assert(!fresh.session.getAllTools().some((tool) => tool.name === "manage_todo_list"), "/reload applies a newly disabled bundle");
      assert(!fresh.loader.getExtensions().extensions.some((extension) => extension.path.replace(/\\/g, "/").includes("pi-manage-todo-list/")), "/reload keeps session and resource discovery consistent");
      writeWebConfig(freshAgentDir, { "pi-manage-todo-list": true });
      await fresh.session.reload();
      assert(fresh.session.getAllTools().some((tool) => tool.name === "manage_todo_list"), "/reload can re-enable a bundled extension");
    } finally {
      await disposeAgentSession(fresh.session);
    }

    const duplicateAgentDir = join(root, "duplicate-agent");
    const duplicatePackage = join(root, "duplicate-pi-manage-todo-list");
    cpSync(join(process.cwd(), "node_modules", "pi-manage-todo-list"), duplicatePackage, { recursive: true });
    writeFileSync(
      join(duplicatePackage, "src", "index.ts"),
      'export default function duplicate(pi: { registerCommand: (name: string, command: unknown) => void }) { pi.registerCommand("duplicate-marker", { handler: async () => {} }); }\n',
      "utf8",
    );
    mkdirSync(duplicateAgentDir, { recursive: true });
    writeFileSync(join(duplicateAgentDir, "settings.json"), `${JSON.stringify({ packages: [duplicatePackage] }, null, 2)}\n`, "utf8");
    writeWebConfig(duplicateAgentDir);
    const duplicate = await createRuntime(sdk, duplicateAgentDir);
    try {
      const todoExtensions = duplicate.loader.getExtensions().extensions.filter((extension) => (
        extension.path.replace(/\\/g, "/").includes("pi-manage-todo-list/")
      ));
      assert(todoExtensions.length === 1, "configured duplicate extension is removed before lifecycle registration");
      assert(todoExtensions[0]?.sourceInfo?.source === "webui-bundled:pi-manage-todo-list@0.4.0", "pinned WebUI copy wins duplicate resolution");
      assert(duplicate.session.getAllTools().filter((tool) => tool.name === "manage_todo_list").length === 1, "duplicate package does not replace or duplicate tool registration");
      const commandNames = duplicate.session.extensionRunner.getRegisteredCommands().map((command) => command.invocationName);
      assert(!commandNames.includes("duplicate-marker"), "duplicate factory cannot register lifecycle or slash-command handlers");
      assert(getBundledPiExtensionRuntimeStatus(duplicate.loader).find((item) => item.id === "pi-manage-todo-list")?.ignoredDuplicateCount === 1, "duplicate suppression is reported without exposing its path");
    } finally {
      await disposeAgentSession(duplicate.session);
    }

    const disabledAgentDir = join(root, "disabled-agent");
    writeWebConfig(disabledAgentDir, { "pi-manage-todo-list": false });
    const disabled = await createRuntime(sdk, disabledAgentDir);
    try {
      assert(!disabled.session.getAllTools().some((tool) => tool.name === "manage_todo_list"), "disabled bundled tool is absent from a new session");
      assert(!disabled.loader.getExtensions().extensions.some((extension) => extension.path.replace(/\\/g, "/").includes("pi-manage-todo-list/")), "disabled bundle is absent from resource discovery");
      assert(getBundledPiExtensionRuntimeStatus(disabled.loader).find((item) => item.id === "pi-manage-todo-list")?.enabled === false, "disabled state is projected");
    } finally {
      await disposeAgentSession(disabled.session);
    }

    const runtimeAgentDir = join(root, "runtime-agent");
    process.env.PI_CODING_AGENT_DIR = runtimeAgentDir;
    process.env.PATH = "";
    process.env.Path = "";
    const runtime = preparePiRuntimeEnvironment({ cwd: process.cwd(), agentDir: runtimeAgentDir });
    assert(runtime.ok && !!runtime.cliPath && existsSync(runtime.cliPath), "project-local Pi CLI resolves with no global PATH");
    assert(runtime.ok && !!runtime.shimPath && existsSync(runtime.shimPath), "project-local Pi shim is created with no global PATH");

    const automationRunner = readFileSync(join(process.cwd(), "lib", "automation-runner.ts"), "utf8");
    const automationWorker = readFileSync(join(process.cwd(), "lib", "automation-worker-host.ts"), "utf8");
    assert(!automationRunner.includes("createBundledPiResourceLoader") && !automationWorker.includes("createBundledPiResourceLoader"), "Automation does not import interactive bundled-extension defaults");
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPathMixed === undefined) delete process.env.Path;
    else process.env.Path = originalPathMixed;
    rmSync(root, { recursive: true, force: true });
  }

  if (failures > 0) process.exitCode = 1;
  else console.log("All bundled Pi extension smokes passed.");
}

void main();
