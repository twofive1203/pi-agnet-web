import { NextResponse } from "next/server";
import {
  applyWebToolsConfig,
  readWebToolsConfigSnapshot,
  WebToolsConfigError,
  type WebToolsProviderId,
  type WebToolsSecretOperation,
  type WebToolsValueOperation,
} from "@/lib/web-tools-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(error: unknown): NextResponse {
  if (error instanceof WebToolsConfigError) {
    return NextResponse.json(
      { error: error.message, code: error.code, fieldPath: error.fieldPath },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error), code: "IO_ERROR" },
    { status: 500 },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOperation(value: unknown, field: string): WebToolsSecretOperation {
  if (!isRecord(value)) {
    throw new WebToolsConfigError("VALIDATION_ERROR", `${field} operation is required`, 400, field);
  }
  const unknownField = Object.keys(value).find((key) => key !== "mode" && key !== "value");
  if (unknownField) {
    throw new WebToolsConfigError("VALIDATION_ERROR", `${field} contains an unsupported field`, 400, `${field}.${unknownField}`);
  }
  if (value.mode === "preserve" || value.mode === "clear") return { mode: value.mode };
  if (value.mode === "replace" && typeof value.value === "string") {
    return { mode: "replace", value: value.value };
  }
  throw new WebToolsConfigError("VALIDATION_ERROR", `${field} operation is invalid`, 400, field);
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(readWebToolsConfigSnapshot());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json().catch(() => null) as unknown;
    if (!isRecord(body)) {
      throw new WebToolsConfigError("VALIDATION_ERROR", "Request body must be a JSON object", 400);
    }
    if ("content" in body || "raw" in body || "text" in body || "path" in body) {
      throw new WebToolsConfigError(
        "VALIDATION_ERROR",
        "Raw file replacement and arbitrary paths are not allowed.",
        400,
      );
    }
    const unknownField = Object.keys(body).find(
      (key) => !["expectedRevision", "provider", "credentialProvider", "apiKey", "baseUrl"].includes(key),
    );
    if (unknownField) {
      throw new WebToolsConfigError("VALIDATION_ERROR", "Request contains an unsupported field", 400, unknownField);
    }
    if (typeof body.expectedRevision !== "string" || !body.expectedRevision) {
      throw new WebToolsConfigError("VALIDATION_ERROR", "expectedRevision is required", 400, "expectedRevision");
    }
    if (typeof body.provider !== "string") {
      throw new WebToolsConfigError("VALIDATION_ERROR", "provider is required", 400, "provider");
    }
    if (body.credentialProvider !== undefined && typeof body.credentialProvider !== "string") {
      throw new WebToolsConfigError(
        "VALIDATION_ERROR",
        "credentialProvider must be a string",
        400,
        "credentialProvider",
      );
    }

    const snapshot = applyWebToolsConfig({
      expectedRevision: body.expectedRevision,
      provider: body.provider as WebToolsProviderId,
      ...(body.credentialProvider === undefined
        ? {}
        : { credentialProvider: body.credentialProvider as WebToolsProviderId }),
      apiKey: parseOperation(body.apiKey, "apiKey"),
      ...(body.baseUrl === undefined
        ? {}
        : { baseUrl: parseOperation(body.baseUrl, "baseUrl") as WebToolsValueOperation }),
    });

    return NextResponse.json({
      success: true,
      ...snapshot,
      reloadRequired: false,
      appliesTo: "subsequent-web-tool-calls",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
