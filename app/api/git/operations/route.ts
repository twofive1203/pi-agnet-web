import { NextRequest, NextResponse } from "next/server";
import type { GitResetMode, GitWorkbenchOperationRequest } from "@/lib/types";
import { GitWorkbenchError, gitErrorResponse } from "@/lib/git-executor";
import { executeGitWorkbenchOperation } from "@/lib/git-workbench-operations";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
const RESET_MODES = new Set<GitResetMode>(["soft", "mixed", "hard", "keep"]);

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

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new GitWorkbenchError("INVALID_REQUEST", `${key} must be a string.`, { status: 400 });
  return value.trim() || undefined;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new GitWorkbenchError("INVALID_REQUEST", `${key} must be a boolean.`, { status: 400 });
  return value;
}

function assertExactKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(body).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new GitWorkbenchError("INVALID_REQUEST", `Unsupported operation field: ${unknown[0]}`, { status: 400 });
  }
}

function parseOperationRequest(value: unknown): GitWorkbenchOperationRequest {
  const body = recordBody(value);
  const action = requiredString(body, "action") as GitWorkbenchOperationRequest["action"];
  const cwd = requiredString(body, "cwd");
  const expectedRevision = requiredString(body, "expectedRevision");

  switch (action) {
    case "checkout-local":
      assertExactKeys(body, ["action", "cwd", "ref", "expectedRevision"]);
      return { action, cwd, ref: requiredString(body, "ref"), expectedRevision };
    case "checkout-remote":
      assertExactKeys(body, ["action", "cwd", "ref", "localName", "expectedRevision"]);
      return { action, cwd, ref: requiredString(body, "ref"), localName: optionalString(body, "localName"), expectedRevision };
    case "push":
      assertExactKeys(body, ["action", "cwd", "ref", "remote", "target", "setUpstream", "expectedRevision", "expectedRefTip"]);
      return {
        action,
        cwd,
        ref: requiredString(body, "ref"),
        remote: optionalString(body, "remote"),
        target: optionalString(body, "target"),
        setUpstream: optionalBoolean(body, "setUpstream"),
        expectedRevision,
        expectedRefTip: requiredString(body, "expectedRefTip"),
      };
    case "cherry-pick":
    case "revert":
    case "drop":
      assertExactKeys(body, ["action", "cwd", "hash", "expectedRevision", "expectedHead"]);
      return { action, cwd, hash: requiredString(body, "hash"), expectedRevision, expectedHead: requiredString(body, "expectedHead") };
    case "reset": {
      assertExactKeys(body, ["action", "cwd", "hash", "mode", "confirmTarget", "expectedRevision", "expectedHead"]);
      const mode = requiredString(body, "mode") as GitResetMode;
      if (!RESET_MODES.has(mode)) throw new GitWorkbenchError("INVALID_REQUEST", "Invalid reset mode.", { status: 400 });
      return {
        action,
        cwd,
        hash: requiredString(body, "hash"),
        mode,
        confirmTarget: optionalString(body, "confirmTarget"),
        expectedRevision,
        expectedHead: requiredString(body, "expectedHead"),
      };
    }
    case "reword":
      assertExactKeys(body, ["action", "cwd", "hash", "message", "expectedRevision", "expectedHead"]);
      return {
        action,
        cwd,
        hash: requiredString(body, "hash"),
        message: requiredString(body, "message"),
        expectedRevision,
        expectedHead: requiredString(body, "expectedHead"),
      };
    case "create-branch":
      assertExactKeys(body, ["action", "cwd", "hash", "name", "checkout", "expectedRevision", "expectedHead"]);
      return {
        action,
        cwd,
        hash: requiredString(body, "hash"),
        name: requiredString(body, "name"),
        checkout: optionalBoolean(body, "checkout"),
        expectedRevision,
        expectedHead: optionalString(body, "expectedHead"),
      };
    case "create-tag":
      assertExactKeys(body, ["action", "cwd", "hash", "name", "expectedRevision"]);
      return { action, cwd, hash: requiredString(body, "hash"), name: requiredString(body, "name"), expectedRevision };
    default:
      throw new GitWorkbenchError("INVALID_REQUEST", "Unsupported Git operation.", { status: 400 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const contentLength = Number.parseInt(req.headers.get("content-length") ?? "0", 10);
    if (contentLength > MAX_BODY_BYTES) {
      throw new GitWorkbenchError("INVALID_REQUEST", "Request body is too large.", { status: 413 });
    }
    const body = await req.json().catch(() => {
      throw new GitWorkbenchError("INVALID_REQUEST", "Request body must be valid JSON.", { status: 400 });
    });
    return NextResponse.json(await executeGitWorkbenchOperation(parseOperationRequest(body)));
  } catch (error) {
    const mapped = gitErrorResponse(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}
