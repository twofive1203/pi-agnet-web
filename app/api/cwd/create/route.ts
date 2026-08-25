import { NextResponse } from "next/server";
import { createCwdDirectory, CwdBrowseError } from "@/lib/cwd-browse";

export const runtime = "nodejs";

/** POST /api/cwd/create  body: { parent: string, name: string } */
export async function POST(req: Request) {
  try {
    const body = await req.json() as { parent?: unknown; name?: unknown };
    const created = createCwdDirectory(body.parent, body.name);
    return NextResponse.json({ success: true, ...created }, { status: 201 });
  } catch (error) {
    if (error instanceof CwdBrowseError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
