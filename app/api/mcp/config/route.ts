import { NextRequest, NextResponse } from "next/server";
import {
  applyMcpConfigOperations,
  isWritableTargetId,
  loadMcpConfigSnapshot,
  McpConfigError,
  parseMcpScopeQuery,
  type McpConfigOperation,
  type McpWritableTargetId,
} from "@/lib/mcp-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(error: unknown): NextResponse {
  if (error instanceof McpConfigError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        fieldPath: error.fieldPath,
      },
      { status: error.status },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: message, code: "IO_ERROR" }, { status: 500 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const scopeRaw = url.searchParams.get("scope");
    const parsedScope = parseMcpScopeQuery(scopeRaw);
    if (parsedScope.invalid) {
      throw new McpConfigError("INVALID_SCOPE", "scope must be user or project", 400, "scope");
    }
    const scopeParam = parsedScope.scope;
    const targetParam = url.searchParams.get("target");
    const cwd = url.searchParams.get("cwd");

    const targetId = targetParam && isWritableTargetId(targetParam) ? targetParam : null;
    if (targetParam && !targetId) {
      throw new McpConfigError("INVALID_TARGET", `Unknown target: ${targetParam}`, 400, "target");
    }

    const snapshot = await loadMcpConfigSnapshot({
      scope: scopeParam,
      targetId,
      cwd,
    });

    return NextResponse.json({
      scope: snapshot.scope,
      targetId: snapshot.targetId,
      cwd: snapshot.cwd,
      adapter: snapshot.adapter,
      sources: snapshot.sources,
      selected: snapshot.selected,
      reloadRequiredHint: snapshot.reloadRequiredHint,
      // Explicit: this page does not report live session connection state.
      runtimeConnection: "unknown",
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOperations(raw: unknown): McpConfigOperation[] {
  if (!Array.isArray(raw)) {
    throw new McpConfigError("VALIDATION_ERROR", "operations must be an array", 400, "operations");
  }
  // Pass through; domain layer validates strictly without echoing secret values.
  return raw as McpConfigOperation[];
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as unknown;
    if (!isRecord(body)) {
      throw new McpConfigError("VALIDATION_ERROR", "Request body must be a JSON object", 400);
    }

    const targetId = body.targetId;
    if (!isWritableTargetId(targetId)) {
      throw new McpConfigError("INVALID_TARGET", "targetId must be a fixed writable MCP target", 400, "targetId");
    }

    const expectedRevision = body.expectedRevision;
    if (typeof expectedRevision !== "string" || !expectedRevision.trim()) {
      throw new McpConfigError("VALIDATION_ERROR", "expectedRevision is required", 400, "expectedRevision");
    }

    // Reject full-file replacement payloads.
    if ("content" in body || "raw" in body || "text" in body || "path" in body) {
      throw new McpConfigError(
        "VALIDATION_ERROR",
        "Arbitrary path/raw file replacement is not allowed; use operations only",
        400,
      );
    }

    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    const operations = normalizeOperations(body.operations);

    const result = await applyMcpConfigOperations({
      targetId: targetId as McpWritableTargetId,
      cwd,
      expectedRevision,
      operations,
    });

    return NextResponse.json({
      success: true,
      targetId: result.selected.targetId,
      selected: result.selected,
      sources: result.sources,
      adapter: result.adapter,
      reloadRequired: true as const,
      reloadRequiredHint:
        "New sessions load saved MCP config automatically. The current session needs /reload.",
      runtimeConnection: "unknown",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
