import { NextRequest, NextResponse } from "next/server";
import { getAllowedRoots, isPathAllowed } from "@/lib/allowed-roots";
import { searchWorkspaceFiles } from "@/lib/workspace-file-search";

export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd");
    const prefix = request.nextUrl.searchParams.get("prefix") ?? "";

    if (!cwd) {
      return NextResponse.json({ error: "Missing cwd parameter" }, { status: 400 });
    }

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    return NextResponse.json(await searchWorkspaceFiles(cwd, prefix, { signal: request.signal }));
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return NextResponse.json({ error: "Search cancelled" }, { status: 499 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
