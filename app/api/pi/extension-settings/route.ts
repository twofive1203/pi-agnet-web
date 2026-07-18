import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  applyExtensionSettingsPatch,
  buildExtensionSettingRows,
  discoverRegisteredExtensionSettings,
  readExtensionSettingsFile,
  writeExtensionSettingsFile,
} from "@/lib/extension-settings";

export const dynamic = "force-dynamic";

/**
 * GET /api/pi/extension-settings?cwd=...
 * Discover registered extension settings and return current stored values.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd") ?? process.cwd();
  const agentDir = getAgentDir();

  try {
    const stored = readExtensionSettingsFile(agentDir);
    const discovered = await discoverRegisteredExtensionSettings(cwd, agentDir);
    const rows = buildExtensionSettingRows(discovered.groups, stored);

    return NextResponse.json({
      cwd,
      agentDir,
      settingsPath: `${agentDir.replace(/\\/g, "/")}/settings-extensions.json`,
      groups: discovered.groups,
      packages: discovered.packages,
      values: rows,
      stored,
      diagnostics: discovered.diagnostics,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

type PatchBody = {
  cwd?: string;
  patch?: Array<{ extensionName: string; settingId: string; value?: string; clear?: boolean }>;
  replace?: Record<string, Record<string, string>>;
};

/**
 * PUT /api/pi/extension-settings
 * Apply a patch or full replace of settings-extensions.json.
 */
export async function PUT(req: Request) {
  const agentDir = getAgentDir();
  try {
    const body = (await req.json()) as PatchBody;
    const current = readExtensionSettingsFile(agentDir);

    let next = current;
    if (body.replace && typeof body.replace === "object") {
      next = {};
      for (const [extName, settings] of Object.entries(body.replace)) {
        if (!settings || typeof settings !== "object") continue;
        const row: Record<string, string> = {};
        for (const [key, value] of Object.entries(settings)) {
          if (typeof value === "string") row[key] = value;
        }
        if (Object.keys(row).length > 0) next[extName] = row;
      }
    } else if (Array.isArray(body.patch)) {
      next = applyExtensionSettingsPatch(current, body.patch);
    } else {
      return NextResponse.json({ error: "Expected { patch: [...] } or { replace: {...} }" }, { status: 400 });
    }

    writeExtensionSettingsFile(next, agentDir);

    const cwd = body.cwd ?? process.cwd();
    const discovered = await discoverRegisteredExtensionSettings(cwd, agentDir);
    const rows = buildExtensionSettingRows(discovered.groups, next);

    return NextResponse.json({
      ok: true,
      cwd,
      agentDir,
      groups: discovered.groups,
      packages: discovered.packages,
      values: rows,
      stored: next,
      diagnostics: discovered.diagnostics,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
