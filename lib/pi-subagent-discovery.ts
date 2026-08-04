/**
 * Agent discovery for native pi-subagents.
 *
 * Uses the extension's public management tool surface rather than importing
 * private TypeScript modules or duplicating directory-discovery logic.
 * Falls back gracefully when the extension/tool is unavailable.
 */

import { createBundledPiResourceLoader } from "./bundled-pi-extensions";
import { disposeAgentSession } from "./pi-session-lifecycle";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredAgent {
  /** Runtime agent name (e.g. "reviewer", "pi-subagents.scout") */
  name: string;
  /** Source scope */
  source: "builtin" | "package" | "user" | "project" | "settings-only";
  /** Human-readable description from frontmatter or discovery */
  description: string;
  /** Whether the agent defaults to forked context */
  defaultContext?: "fresh" | "fork";
}

export interface AgentDiscoveryResult {
  agents: DiscoveredAgent[];
  /** Whether the pi-subagents extension and management tool are available */
  extensionAvailable: boolean;
  /** Human-readable diagnostic when discovery encountered a problem */
  diagnostic?: string;
}

interface ToolTextResult {
  content?: Array<{ type?: string; text?: string }>;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const SOURCE_VALUES = new Set(["builtin", "package", "user", "project"]);

function parseSource(raw: string): DiscoveredAgent["source"] | null {
  const source = raw.split(",")[0]?.trim();
  if (SOURCE_VALUES.has(source)) return source as DiscoveredAgent["source"];
  return null;
}

function parseDefaultContext(raw: string): "fresh" | "fork" | undefined {
  const match = raw.match(/(?:^|,)\s*context:\s*(fresh|fork)\s*(?:,|$)/);
  return match?.[1] as "fresh" | "fork" | undefined;
}

export function parseSubagentListOutput(text: string): DiscoveredAgent[] {
  const agents: DiscoveredAgent[] = [];
  let inAgents = false;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "Executable agents:") {
      inAgents = true;
      continue;
    }
    if (!inAgents) continue;
    if (!trimmed || trimmed === "Chains:" || trimmed.startsWith("Chains:")) break;

    const match = trimmed.match(/^-\s+([^\s(]+)\s+\(([^)]*)\):\s*(.*)$/);
    if (!match) continue;

    const [, name, meta, description] = match;
    const source = parseSource(meta);
    if (!source) continue;

    agents.push({
      name,
      source,
      description: description.trim() || "No description provided by discovery",
      defaultContext: parseDefaultContext(meta),
    });
  }

  return agents;
}

function toolResultText(result: ToolTextResult): string {
  return (result.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Main discovery function
// ---------------------------------------------------------------------------

/**
 * Discover available subagents through the registered pi-subagents tool.
 *
 * @param cwd - Workspace directory for extension discovery
 * @returns Discovery result with agents and diagnostics
 */
export async function discoverAgents(cwd: string): Promise<AgentDiscoveryResult> {
  let session: { dispose: () => void; agent?: { state?: { tools?: Array<{ name?: string; execute?: unknown }> } } } | undefined;

  try {
    // Keep the Pi extension loader in its native ESM graph under smoke/tsx hosts.
    const {
      createAgentSession,
      DefaultResourceLoader,
      getAgentDir,
      SessionManager,
    } = await import("@earendil-works/pi-coding-agent");
    const agentDir = getAgentDir();
    const resourceLoader = createBundledPiResourceLoader(DefaultResourceLoader, { cwd, agentDir });
    await resourceLoader.reload();
    const created = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
    });
    session = created.session as typeof session;

    const subagentTool = session?.agent?.state?.tools?.find((tool) => tool.name === "subagent");
    if (!subagentTool || typeof subagentTool.execute !== "function") {
      return {
        agents: [],
        extensionAvailable: false,
        diagnostic: "pi-subagents extension is not available: registered subagent management tool was not found.",
      };
    }

    const result = await subagentTool.execute(
      "inspect",
      { action: "list", agentScope: "both" },
      undefined,
      undefined,
    ) as ToolTextResult;
    const output = toolResultText(result);
    const agents = parseSubagentListOutput(output);

    if (agents.length === 0) {
      return {
        agents: [],
        extensionAvailable: true,
        diagnostic: output.trim()
          ? "pi-subagents list output could not be parsed; configured settings-only entries are still shown."
          : "pi-subagents list returned no executable agents.",
      };
    }

    return { agents, extensionAvailable: true };
  } catch (error) {
    return {
      agents: [],
      extensionAvailable: false,
      diagnostic: `Agent discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await disposeAgentSession(session);
  }
}

/**
 * Merge settings-only override names into the discovered agent list.
 * Names that appear in settings but not in discovery are added as
 * "settings-only" entries so they remain visible and clearable.
 */
export function mergeSettingsOnlyAgents(
  agents: DiscoveredAgent[],
  configuredNames: string[],
): DiscoveredAgent[] {
  const existing = new Set(agents.map((a) => a.name));
  const merged = [...agents];

  for (const name of configuredNames) {
    if (!existing.has(name)) {
      merged.push({
        name,
        source: "settings-only",
        description: "Configured in settings (agent not currently discovered)",
      });
      existing.add(name);
    }
  }

  merged.sort((a, b) => {
    const order: Record<string, number> = { builtin: 0, package: 1, user: 2, project: 3, "settings-only": 4 };
    return (order[a.source] ?? 0) - (order[b.source] ?? 0) || a.name.localeCompare(b.name);
  });

  return merged;
}
