import { NextResponse } from "next/server";
import { sendIntercomMessage } from "@/lib/intercom-hub";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/intercom/send
 * Body: { to, text, cwd? }
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as { to?: unknown; text?: unknown; cwd?: unknown };
  const result = await sendIntercomMessage({
    to: typeof body.to === "string" ? body.to : "",
    text: typeof body.text === "string" ? body.text : "",
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
