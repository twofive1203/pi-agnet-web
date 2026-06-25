import { NextResponse } from "next/server";
import { createGitWorktree, WorktreeUserError } from "@/lib/git-worktree";
import { readPiWebConfig } from "@/lib/pi-web-config";

export const dynamic = "force-dynamic";

declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
}

function addAllowedRoot(cwd: string): void {
  const now = Date.now();
  if (!globalThis.__piAllowedRootsCache) {
    globalThis.__piAllowedRootsCache = { roots: new Set(), expiresAt: now + 5_000 };
  }
  globalThis.__piAllowedRootsCache.roots.add(cwd);
  globalThis.__piAllowedRootsCache.expiresAt = Math.max(globalThis.__piAllowedRootsCache.expiresAt, now + 5_000);
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as {
      cwd?: unknown;
      baseRef?: unknown;
      branchName?: unknown;
      targetPath?: unknown;
    };

    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwd) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }

    const config = readPiWebConfig();
    const result = await createGitWorktree({
      cwd,
      config: config.worktree,
      baseRef: typeof body.baseRef === "string" ? body.baseRef : undefined,
      branchName: typeof body.branchName === "string" ? body.branchName : undefined,
      targetPath: typeof body.targetPath === "string" ? body.targetPath : undefined,
    });

    addAllowedRoot(result.cwd);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof WorktreeUserError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
