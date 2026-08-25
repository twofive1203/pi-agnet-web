import { NextRequest, NextResponse } from "next/server";
import type {
  GitCommitFileDiffResponse,
  GitWorkingTreeDiffScope,
  GitWorkingTreeFileDiffResponse,
} from "@/lib/types";
import {
  GIT_READ_TIMEOUT_MS,
  GitWorkbenchError,
  gitErrorResponse,
  resolveGitRepository,
  runGit,
} from "@/lib/git-executor";
import { normalizeGitCommit } from "@/lib/git-workbench";

export const dynamic = "force-dynamic";

const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DIFF_BUFFER = 2 * 1024 * 1024;
const COMMON_DIFF_ARGS = ["--no-ext-diff", "--no-color", "--find-renames", "--find-copies", "--patch"] as const;

function literalPathspec(file: string): string {
  return `:(literal)${file}`;
}

function getPathspecs(file: string, oldFile?: string): string[] {
  return oldFile && oldFile !== file
    ? [literalPathspec(file), literalPathspec(oldFile)]
    : [literalPathspec(file)];
}

function looksBinaryDiff(diff: string): boolean {
  return /(^|\n)Binary files .+ differ(\n|$)/.test(diff) || /(^|\n)GIT binary patch(\n|$)/.test(diff);
}

async function executeDiff(cwd: string, args: readonly string[]): Promise<string> {
  return (await runGit(cwd, args, { timeoutMs: GIT_READ_TIMEOUT_MS, maxBuffer: DIFF_BUFFER })).stdout;
}

function unavailableResponse(
  scope: GitWorkingTreeDiffScope | null,
  hash: string,
  file: string,
  oldFile?: string,
): GitCommitFileDiffResponse | GitWorkingTreeFileDiffResponse {
  return scope
    ? { scope, file, oldFile, diffAvailable: false, reason: "unavailable" }
    : { hash, file, oldFile, diffAvailable: false, reason: "unavailable" };
}

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd") ?? "";
  const hash = req.nextUrl.searchParams.get("hash")?.trim() ?? "";
  const scopeParam = req.nextUrl.searchParams.get("scope")?.trim() ?? "";
  const scope: GitWorkingTreeDiffScope | null = scopeParam === "staged" || scopeParam === "unstaged" ? scopeParam : null;
  const file = req.nextUrl.searchParams.get("path") ?? "";
  const oldFile = req.nextUrl.searchParams.get("oldPath") || undefined;

  if (!cwd.trim()) return NextResponse.json({ error: "cwd is required", code: "INVALID_CWD" }, { status: 400 });
  if (scopeParam && !scope) return NextResponse.json({ error: "scope must be staged or unstaged", code: "INVALID_REQUEST" }, { status: 400 });
  if (!scope && !hash) return NextResponse.json({ error: "hash is required when scope is omitted", code: "INVALID_REQUEST" }, { status: 400 });
  if (!file) return NextResponse.json({ error: "path is required", code: "INVALID_REQUEST" }, { status: 400 });

  try {
    let normalizedHash = hash;
    let diff: string;
    if (scope) {
      const repo = await resolveGitRepository(cwd);
      const cached = scope === "staged" ? ["--cached"] : [];
      diff = await executeDiff(repo.cwd, ["diff", ...cached, ...COMMON_DIFF_ARGS, "--", ...getPathspecs(file, oldFile)]);
    } else {
      const normalized = await normalizeGitCommit(cwd, hash);
      normalizedHash = normalized.hash;
      const parents = (await runGit(normalized.repo.cwd, ["show", "-s", "--format=%P", normalizedHash])).stdout.trim().split(/\s+/).filter(Boolean);
      const base = parents[0] ?? EMPTY_TREE_HASH;
      diff = await executeDiff(normalized.repo.cwd, ["diff", ...COMMON_DIFF_ARGS, base, normalizedHash, "--", ...getPathspecs(file, oldFile)]);
    }

    if (looksBinaryDiff(diff)) {
      return NextResponse.json(scope
        ? { scope, file, oldFile, diffAvailable: false, reason: "binary" } satisfies GitWorkingTreeFileDiffResponse
        : { hash: normalizedHash, file, oldFile, diffAvailable: false, reason: "binary" } satisfies GitCommitFileDiffResponse);
    }
    if (!diff.trim()) return NextResponse.json(unavailableResponse(scope, normalizedHash, file, oldFile));
    return NextResponse.json(scope
      ? { scope, file, oldFile, diffAvailable: true, diff } satisfies GitWorkingTreeFileDiffResponse
      : { hash: normalizedHash, file, oldFile, diffAvailable: true, diff } satisfies GitCommitFileDiffResponse);
  } catch (error) {
    if (error instanceof GitWorkbenchError && error.code === "NOT_GIT_REPOSITORY") {
      return NextResponse.json(unavailableResponse(scope, hash, file, oldFile));
    }
    if (error instanceof GitWorkbenchError && error.code === "GIT_OUTPUT_TOO_LARGE") {
      return NextResponse.json(scope
        ? { scope, file, oldFile, diffAvailable: false, reason: "too-large" } satisfies GitWorkingTreeFileDiffResponse
        : { hash, file, oldFile, diffAvailable: false, reason: "too-large" } satisfies GitCommitFileDiffResponse);
    }
    const mapped = gitErrorResponse(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}
