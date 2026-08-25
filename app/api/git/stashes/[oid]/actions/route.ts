import { NextRequest, NextResponse } from "next/server";
import { GitWorkbenchError, gitErrorResponse } from "@/lib/git-executor";
import { executeGitStashMutation } from "@/lib/git-stash";

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
  if (unknown) throw new GitWorkbenchError("INVALID_REQUEST", `Unsupported stash action field: ${unknown}`, { status: 400 });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ oid: string }> },
) {
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
    const action = requiredString(body, "action");
    const cwd = requiredString(body, "cwd");
    const expectedRevision = requiredString(body, "expectedRevision");
    const { oid } = await params;

    if (action === "drop") {
      assertExactKeys(body, ["action", "cwd", "expectedRevision"]);
      return NextResponse.json(await executeGitStashMutation({ action, cwd, oid, expectedRevision }), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (action !== "apply" && action !== "pop") {
      throw new GitWorkbenchError("INVALID_REQUEST", "Unsupported stash action.", { status: 400 });
    }
    assertExactKeys(body, ["action", "cwd", "reinstateIndex", "expectedRevision", "expectedTargetRevision"]);
    if (typeof body.reinstateIndex !== "boolean") {
      throw new GitWorkbenchError("INVALID_REQUEST", "reinstateIndex must be a boolean.", { status: 400 });
    }
    return NextResponse.json(await executeGitStashMutation({
      action,
      cwd,
      oid,
      reinstateIndex: body.reinstateIndex,
      expectedRevision,
      expectedTargetRevision: requiredString(body, "expectedTargetRevision"),
    }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const mapped = gitErrorResponse(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}
