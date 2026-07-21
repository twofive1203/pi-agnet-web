import { NextRequest, NextResponse } from "next/server";
import { getAllowedRoots, isPathAllowed } from "@/lib/allowed-roots";
import { readPiWebConfig } from "@/lib/pi-web-config";
import {
  createWorkflowTask,
  listWorkflowTasks,
  WorkflowSecurityError,
  WorkflowStoreError,
} from "@/lib/workflow-store";
import { extractWorkflowSeedFromSession } from "@/lib/workflow-session-seed";
import { isWorkflowPriority } from "@/lib/workflow-types";
import { workflowTaskToChatContext } from "@/lib/workflow-chat-context";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(request: NextRequest) {
  try {
    const config = readPiWebConfig();
    if (!config.workflow.enabled) {
      return NextResponse.json({ error: "SnFlow panel is disabled" }, { status: 403 });
    }

    const cwd = request.nextUrl.searchParams.get("cwd");
    if (!cwd) {
      return NextResponse.json({ error: "Missing cwd parameter" }, { status: 400 });
    }

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const includeArchived = request.nextUrl.searchParams.get("includeArchived") === "true";
    return NextResponse.json(listWorkflowTasks(cwd, includeArchived));
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const config = readPiWebConfig();
    if (!config.workflow.enabled) {
      return NextResponse.json({ error: "SnFlow panel is disabled" }, { status: 403 });
    }

    const cwd = request.nextUrl.searchParams.get("cwd");
    if (!cwd) {
      return NextResponse.json({ error: "Missing cwd parameter" }, { status: 400 });
    }

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const body = (await request.json()) as unknown;
    if (!isRecord(body)) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (body.priority !== undefined && !isWorkflowPriority(body.priority)) {
      return NextResponse.json({ error: "Invalid priority" }, { status: 400 });
    }

    let title = typeof body.title === "string" ? body.title.trim() : "";
    let seedText = typeof body.seedText === "string" ? body.seedText : undefined;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : undefined;

    // Trellis-like: create from chat session without making the user type a title.
    if (sessionId && (!title || !seedText)) {
      const seed = await extractWorkflowSeedFromSession(sessionId);
      if (!seed) {
        return NextResponse.json(
          { error: "Session has no user messages to seed a SnFlow task" },
          { status: 400 },
        );
      }
      if (!title) title = seed.title;
      if (!seedText) seedText = seed.seedText;
    }

    if (!title) {
      return NextResponse.json(
        { error: "title is required (or provide sessionId to seed from chat)" },
        { status: 400 },
      );
    }

    const task = createWorkflowTask(cwd, {
      title,
      description: typeof body.description === "string" ? body.description : undefined,
      priority: isWorkflowPriority(body.priority) ? body.priority : undefined,
      id: typeof body.id === "string" ? body.id : undefined,
      requirements: typeof body.requirements === "string" ? body.requirements : undefined,
      design: typeof body.design === "string" ? body.design : undefined,
      plan: typeof body.plan === "string" ? body.plan : undefined,
      seedText,
      sessionId,
      markReady: body.markReady === true,
    });

    return NextResponse.json(
      {
        task,
        chatContext: workflowTaskToChatContext(task),
      },
      { status: 201 },
    );
  } catch (error) {
    return storeErrorResponse(error);
  }
}

function storeErrorResponse(error: unknown): NextResponse {
  if (error instanceof WorkflowStoreError) {
    const status = error instanceof WorkflowSecurityError ? 400 : error.status;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: message }, { status: 500 });
}
