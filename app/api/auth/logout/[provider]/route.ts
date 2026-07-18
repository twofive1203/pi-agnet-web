import {
  createDefaultModelRuntime,
  isOAuthProvider,
  removeStoredCredential,
} from "@/lib/pi-auth";
import { reloadRpcAuthState } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const runtime = await createDefaultModelRuntime();
  if (!isOAuthProvider(runtime, provider)) {
    return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }
  await removeStoredCredential(provider);
  reloadRpcAuthState();
  return Response.json({ ok: true });
}
