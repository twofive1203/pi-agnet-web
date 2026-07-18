import { NextResponse } from "next/server";
import path from "path";
import { stat, realpath } from "fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createSessionServicesWithRegistry } from "@/lib/pi-auth";
import { getAllowedRoots, isPathAllowed } from "@/lib/allowed-roots";
import {
  readPiSubagentSettings,
  applySubagentsPatch,
  getUserSettingsPath,
  getProjectSettingsPath,
  type PiSubagentSettingsPatch,
} from "@/lib/pi-subagent-settings";
import {
  discoverAgents,
  mergeSettingsOnlyAgents,
  type DiscoveredAgent,
} from "@/lib/pi-subagent-discovery";
import { existingCanonicalCwd } from "@/lib/cwd";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface ManagedProjection {
  defaultModel?: string;
  agentOverrides: Record<string, {
    model?: string | false;
    thinking?: string | false;
    fallbackModels?: string[] | false;
  }>;
}

interface SubagentConfigResponse {
  scope: "user" | "project";
  path: string;
  exists: boolean;
  revision?: string;
  managed: ManagedProjection;
  parseError?: string;
  validationError?: string;

  // For project scope: the user-scope managed projection for inheritance display
  userManaged?: ManagedProjection;
  userParseError?: string;
  userValidationError?: string;

  // Agent discovery
  agents: DiscoveredAgent[];
  agentDiscovery?: {
    extensionAvailable: boolean;
    diagnostic?: string;
  };
}

// ---------------------------------------------------------------------------
// Resolve model registry
// ---------------------------------------------------------------------------

async function getModelIds(cwd: string): Promise<Set<string>> {
  try {
    const { registry } = await createSessionServicesWithRegistry(cwd, getAgentDir());
    const available = registry.getAvailable() as Array<{ provider: string; id: string }>;
    return new Set(available.map((m) => `${m.provider}/${m.id}`));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Scope resolution helpers
// ---------------------------------------------------------------------------

function resolveUserScope(): { path: string } {
  return { path: getUserSettingsPath() };
}

async function assertRealPathInside(target: string, root: string, error: string): Promise<{ error?: string; status?: number }> {
  try {
    const targetStat = await stat(target).catch(() => null);
    if (!targetStat) return {};
    const realTarget = await realpath(target);
    const realRoot = await realpath(root).catch(() => root);
    if (!isPathAllowed(realTarget, new Set([realRoot]))) {
      return { error, status: 403 };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), status: 403 };
  }
  return {};
}

async function resolveProjectScope(cwd: string): Promise<{ path: string; canonicalCwd?: string; error?: string; status?: number }> {
  const canonical = existingCanonicalCwd(cwd);
  if (!canonical) {
    return { path: "", error: `Directory does not exist: ${cwd}`, status: 400 };
  }

  const cwdStat = await stat(canonical).catch(() => null);
  if (!cwdStat?.isDirectory()) {
    return { path: "", error: `Not a directory: ${cwd}`, status: 400 };
  }

  const allowedRoots = await getAllowedRoots();
  if (!isPathAllowed(canonical, allowedRoots)) {
    return { path: "", error: `Unauthorized workspace: ${cwd}. Select the workspace in the sidebar first.`, status: 403 };
  }

  const projectPath = getProjectSettingsPath(canonical);
  if (!projectPath) {
    return { path: "", error: `Cannot resolve project settings path for: ${cwd}`, status: 400 };
  }

  const piDir = path.join(canonical, ".pi");
  const piDirCheck = await assertRealPathInside(piDir, canonical, "Security: .pi directory symlink escapes the workspace");
  if (piDirCheck.error) return { path: "", error: piDirCheck.error, status: piDirCheck.status };
  const existingPiDirStat = await stat(piDir).catch(() => null);
  if (existingPiDirStat && !existingPiDirStat.isDirectory()) {
    return { path: "", error: `Project settings parent is not a directory: ${piDir}`, status: 400 };
  }

  const settingsCheck = await assertRealPathInside(projectPath, piDir, "Security: settings file symlink escapes the workspace .pi directory");
  if (settingsCheck.error) return { path: "", error: settingsCheck.error, status: settingsCheck.status };

  return { path: projectPath, canonicalCwd: canonical };
}

async function resolveSafeDiscoveryCwd(scope: "user" | "project", requestedCwd: string | null, projectCanonical?: string): Promise<string> {
  if (scope === "project" && projectCanonical) return projectCanonical;

  const requestedCanonical = requestedCwd ? existingCanonicalCwd(requestedCwd) : null;
  if (requestedCanonical) {
    const allowedRoots = await getAllowedRoots();
    if (isPathAllowed(requestedCanonical, allowedRoots)) return requestedCanonical;
  }

  return existingCanonicalCwd(process.cwd()) ?? process.cwd();
}

function collectConfiguredNames(selected: ManagedProjection, inherited?: ManagedProjection): string[] {
  return [...new Set([
    ...Object.keys(selected.agentOverrides),
    ...Object.keys(inherited?.agentOverrides ?? {}),
  ])];
}

function normalizePatchBody(body: Record<string, unknown>): PiSubagentSettingsPatch | { error: string } {
  const expectedRevision = body.expectedRevision;
  if (typeof expectedRevision !== "string" || !expectedRevision) {
    return { error: "expectedRevision is required" };
  }

  const patch: PiSubagentSettingsPatch = { expectedRevision };

  if (Object.prototype.hasOwnProperty.call(body, "defaultModel")) {
    if (body.defaultModel !== null && typeof body.defaultModel !== "string") {
      return { error: "defaultModel must be a string or null when present" };
    }
    patch.defaultModel = body.defaultModel;
  }

  if (Object.prototype.hasOwnProperty.call(body, "agentOverrides")) {
    if (body.agentOverrides === null || typeof body.agentOverrides !== "object" || Array.isArray(body.agentOverrides)) {
      return { error: "agentOverrides must be an object when present" };
    }
    patch.agentOverrides = body.agentOverrides as PiSubagentSettingsPatch["agentOverrides"];
  }

  return patch;
}

// ---------------------------------------------------------------------------
// GET /api/subagents/config?scope=user|project&cwd=...
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const scopeParam = url.searchParams.get("scope") || "user";
    const cwdParam = url.searchParams.get("cwd");

    if (scopeParam !== "user" && scopeParam !== "project") {
      return NextResponse.json({ error: "scope must be 'user' or 'project'" }, { status: 400 });
    }
    const scope = scopeParam as "user" | "project";

    let settingsPath: string;
    let projectCanonical: string | undefined;
    if (scope === "user") {
      settingsPath = resolveUserScope().path;
    } else {
      if (!cwdParam) return NextResponse.json({ error: "cwd is required for project scope" }, { status: 400 });
      const projResult = await resolveProjectScope(cwdParam);
      if (projResult.error) {
        return NextResponse.json({ error: projResult.error }, { status: projResult.status ?? 400 });
      }
      settingsPath = projResult.path;
      projectCanonical = projResult.canonicalCwd;
    }

    const settings = readPiSubagentSettings(settingsPath);

    let userManaged: SubagentConfigResponse["userManaged"];
    let userParseError: string | undefined;
    let userValidationError: string | undefined;
    if (scope === "project") {
      const userSettings = readPiSubagentSettings(getUserSettingsPath());
      userManaged = userSettings.managed;
      userParseError = userSettings.parseError;
      userValidationError = userSettings.validationError;
    }

    const discoveryCwd = await resolveSafeDiscoveryCwd(scope, cwdParam, projectCanonical);
    const discovery = await discoverAgents(discoveryCwd);
    const agents = mergeSettingsOnlyAgents(discovery.agents, collectConfiguredNames(settings.managed, userManaged));

    const response: SubagentConfigResponse = {
      scope,
      path: settingsPath,
      exists: settings.exists,
      revision: settings.revision,
      managed: settings.managed,
      parseError: settings.parseError,
      validationError: settings.validationError,
      agents,
      agentDiscovery: {
        extensionAvailable: discovery.extensionAvailable,
        diagnostic: discovery.diagnostic,
      },
    };

    if (userManaged) response.userManaged = userManaged;
    if (userParseError) response.userParseError = userParseError;
    if (userValidationError) response.userValidationError = userValidationError;

    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// PUT /api/subagents/config?scope=user|project&cwd=...
// ---------------------------------------------------------------------------

export async function PUT(req: Request) {
  try {
    const url = new URL(req.url);
    const scopeParam = url.searchParams.get("scope") || "user";
    const cwdParam = url.searchParams.get("cwd");

    if (scopeParam !== "user" && scopeParam !== "project") {
      return NextResponse.json({ error: "scope must be 'user' or 'project'" }, { status: 400 });
    }
    const scope = scopeParam as "user" | "project";

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    }
    const patch = normalizePatchBody(body);
    if ("error" in patch) {
      return NextResponse.json({ error: patch.error }, { status: 400 });
    }

    let settingsPath: string;
    let projectCanonical: string | undefined;
    if (scope === "user") {
      settingsPath = resolveUserScope().path;
    } else {
      if (!cwdParam) return NextResponse.json({ error: "cwd is required for project scope" }, { status: 400 });
      const projResult = await resolveProjectScope(cwdParam);
      if (projResult.error) {
        return NextResponse.json({ error: projResult.error }, { status: projResult.status ?? 400 });
      }
      settingsPath = projResult.path;
      projectCanonical = projResult.canonicalCwd;
    }

    const discoveryCwd = await resolveSafeDiscoveryCwd(scope, cwdParam, projectCanonical);
    const knownModelIds = await getModelIds(discoveryCwd);

    const result = applySubagentsPatch(settingsPath, patch, knownModelIds);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      success: true,
      scope,
      path: settingsPath,
      exists: result.result?.exists ?? true,
      revision: result.result?.revision,
      managed: result.result?.managed,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
