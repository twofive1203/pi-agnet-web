import { NextResponse } from "next/server";
import { statSync, type Stats } from "fs";
import {
  getAllowedRoots,
  isPathAllowed,
  isRegisteredAllowedRoot,
  registerAllowedRoot,
} from "@/lib/allowed-roots";
import { canonicalizeCwd } from "@/lib/cwd";
import { openPathInFileManager } from "@/lib/open-path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/cwd/open  body: { cwd: string }
 * Opens an authorized workspace directory in the host OS file manager.
 * Runs on the WebUI server machine (not the browser client).
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";

    if (!cwd) {
      return NextResponse.json({ error: "Path is required" }, { status: 400 });
    }

    const canonicalCwd = canonicalizeCwd(cwd);

    let stat: Stats;
    try {
      stat = statSync(canonicalCwd);
    } catch {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    if (!stat.isDirectory()) {
      return NextResponse.json({ error: `Path is not a directory: ${cwd}` }, { status: 400 });
    }

    const allowed = await isOpenAllowed(cwd, canonicalCwd);
    if (!allowed) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    registerAllowedRoot(canonicalCwd);

    const result = await openPathInFileManager(canonicalCwd);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({ success: true, cwd: canonicalCwd });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

async function isOpenAllowed(cwd: string, canonicalCwd: string): Promise<boolean> {
  // In-process roots registered by validate/select (fastest).
  if (isRegisteredAllowedRoot(canonicalCwd) || isRegisteredAllowedRoot(cwd)) {
    return true;
  }

  // Project index is much cheaper than a full session scan.
  try {
    const { listProjectSummaries } = await import("@/lib/session-reader");
    const projects = await listProjectSummaries();
    for (const project of projects) {
      if (!project.cwd) continue;
      if (pathsMatch(project.cwd, cwd) || pathsMatch(project.cwd, canonicalCwd)) {
        return true;
      }
    }
  } catch {
    // Fall through to full allowed-roots check.
  }

  const allowedRoots = await getAllowedRoots();
  return isPathAllowed(cwd, allowedRoots) && isPathAllowed(canonicalCwd, allowedRoots);
}

function pathsMatch(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return canonicalizeCwd(left) === canonicalizeCwd(right);
  } catch {
    return false;
  }
}
