/**
 * Thin helpers for Automation HTTP route handlers.
 */

import { NextResponse } from "next/server";
import {
  assertAutomationLocalAccess,
  assertAutomationMutationAccess,
  assertAutomationReadAccess,
  issueAutomationControlSession,
  readControlSessionFromRequest,
} from "./automation-local-access";
import { AutomationServiceError } from "./automation-service";

export function jsonOk(data: unknown, init?: { status?: number; headers?: HeadersInit }) {
  return NextResponse.json(data, { status: init?.status ?? 200, headers: init?.headers });
}

export function jsonError(error: unknown) {
  if (error instanceof AutomationServiceError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        blockedReason: error.blockedReason,
      },
      { status: error.status },
    );
  }
  if (error && typeof error === "object" && "status" in error && "message" in error) {
    const e = error as { status?: number; message: string; code?: string };
    return NextResponse.json(
      { error: e.message, code: e.code ?? "error" },
      { status: e.status ?? 400 },
    );
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error), code: "error" },
    { status: 500 },
  );
}

export function withAutomationRead(req: Request): void {
  assertAutomationReadAccess(req);
}

export function withAutomationMutation(req: Request): void {
  assertAutomationMutationAccess(req);
}

export function withAutomationLocal(req: Request): void {
  assertAutomationLocalAccess(req);
}

export function controlSessionRaw(req: Request): string {
  return readControlSessionFromRequest(req) ?? "";
}

export function ensureControlSessionResponse(): NextResponse {
  const issued = issueAutomationControlSession();
  return NextResponse.json(
    { ok: true, controlSession: true, expiresAt: issued.expiresAt },
    {
      status: 200,
      headers: {
        "Set-Cookie": issued.cookie,
      },
    },
  );
}

export async function readJsonBody<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new AutomationServiceError("Invalid JSON body", { status: 400, code: "validation" });
  }
}
