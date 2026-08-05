import { NextRequest, NextResponse } from "next/server";
import { browseCwdDirectory, CwdBrowseError } from "@/lib/cwd-browse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/cwd/browse?path=
 * List child directories on the WebUI server machine for the project path picker.
 * Empty/missing path returns top-level roots (Home + drives or `/`).
 * Directories only; does not read file contents. Selecting a project still goes
 * through POST /api/cwd/validate before the UI switches cwd.
 */
export async function GET(req: NextRequest) {
  try {
    const pathParam = req.nextUrl.searchParams.get("path");
    const result = browseCwdDirectory(pathParam);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CwdBrowseError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
