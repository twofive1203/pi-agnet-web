import { NextRequest, NextResponse } from "next/server";
import { GitWorkbenchError, gitErrorResponse } from "@/lib/git-executor";
import { executeGitStashMutation, readGitStashes } from "@/lib/git-stash";

export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 16 * 1024;

function recordBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitWorkbenchError("INVALID_REQUEST", "Request body must be a JSON object.", { status: 400 });
  }
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new GitWorkbenchError("INVALID_REQUEST", `${key} is required.`, { status: 400 });
  }
  return value.trim();
}

function assertExactKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(body).find((key) => !allowedSet.has(key));
  if (unknown) throw new GitWorkbenchError("INVALID_REQUEST", `Unsupported stash field: ${unknown}`, { status: 400 });
}

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd") ?? "";
  if (!cwd.trim()) return NextResponse.json({ error: "cwd is required", code: "INVALID_CWD" }, { status: 400 });
  try {
    return NextResponse.json(await readGitStashes(cwd), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const mapped = gitErrorResponse(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}

export async function POST(req: NextRequest) {
  try {
    const contentLength = Number.parseInt(req.headers.get("content-length") ?? "0", 10);
    if (contentLength > MAX_BODY_BYTES) {
      throw new GitWorkbenchError("INVALID_REQUEST", "Request body is too large.", { status: 413 });
    }
    const rawBody = await req.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      throw new GitWorkbenchError("INVALID_REQUEST", "Request body is too large.", { status: 413 });
    }
    const body = recordBody((() => {
      try {
        return JSON.parse(rawBody) as unknown;
      } catch {
        throw new GitWorkbenchError("INVALID_REQUEST", "Request body must be valid JSON.", { status: 400 });
      }
    })());
    assertExactKeys(body, ["cwd", "name", "includeUntracked"]);
    if (typeof body.includeUntracked !== "boolean") {
      throw new GitWorkbenchError("INVALID_REQUEST", "includeUntracked must be a boolean.", { status: 400 });
    }
    const response = await executeGitStashMutation({
      action: "create",
      cwd: requiredString(body, "cwd"),
      name: requiredString(body, "name"),
      includeUntracked: body.includeUntracked,
    });
    return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const mapped = gitErrorResponse(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}
