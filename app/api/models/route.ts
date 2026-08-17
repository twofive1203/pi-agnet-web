import { loadModelMetadata, resolveModelMetadataCwd } from "@/lib/model-metadata";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const resolved = await resolveModelMetadataCwd(url.searchParams.get("cwd"));
  if (!resolved.ok) {
    return Response.json({ error: resolved.error }, { status: resolved.status });
  }

  const metadata = await loadModelMetadata(resolved.cwd, url.searchParams.get("refresh") === "1");
  return Response.json(metadata, { headers: { "Cache-Control": "no-store" } });
}
