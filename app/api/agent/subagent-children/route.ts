import { NextRequest, NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { getAgentDir } from "@/lib/session-reader";
import {
  createSubagentDetailFingerprint,
  parseSubagentDetail,
} from "@/lib/parse-subagent-children";
import {
  parseSubagentDetailDepth,
  resolveSubagentArtifactPath,
  SubagentDetailRequestError,
} from "@/lib/subagent-detail-route";

/** GET bounded, direct child details for one native-subagent session artifact. */
export async function GET(request: NextRequest) {
  const sessionFile = request.nextUrl.searchParams.get("sessionFile");
  if (!sessionFile) {
    return NextResponse.json({ error: "sessionFile query parameter is required" }, { status: 400 });
  }

  let depth: number;
  let resolvedPath: string;
  try {
    depth = parseSubagentDetailDepth(request.nextUrl.searchParams.get("depth"));
    resolvedPath = resolveSubagentArtifactPath(sessionFile, resolve(getAgentDir(), "sessions"));
  } catch (error) {
    if (error instanceof SubagentDetailRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Invalid subagent detail request" }, { status: 400 });
  }

  try {
    const fileStat = await stat(resolvedPath);
    const currentFingerprint = createSubagentDetailFingerprint(fileStat.size, fileStat.mtimeMs);
    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch === `"${currentFingerprint}"`) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: `"${currentFingerprint}"`, "Cache-Control": "private, no-cache" },
      });
    }

    const detail = await parseSubagentDetail(resolvedPath, depth);
    return NextResponse.json(detail, {
      headers: {
        ETag: `"${detail.fingerprint}"`,
        "Cache-Control": "private, no-cache",
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return NextResponse.json({ error: "Session file not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Failed to read subagent detail" }, { status: 500 });
  }
}
