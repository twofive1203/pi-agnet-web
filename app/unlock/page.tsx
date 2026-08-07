import { I18nProvider } from "@/components/I18nProvider";
import { ServerUnlockForm } from "@/components/ServerUnlockForm";
import { headers } from "next/headers";
import {
  isServerAccessAuthEnabled,
  resolveEffectiveProtocol,
  shouldWarnPlainHttp,
} from "@/lib/server-access-policy";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function UnlockPage() {
  // Local mode has no unlock flow.
  if (!isServerAccessAuthEnabled()) {
    redirect("/");
  }

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  const protoHeader = h.get("x-forwarded-proto");
  // Build a request-like object for protocol helpers.
  const urlProto =
    protoHeader?.split(",")[0]?.trim().toLowerCase() === "https" ? "https" : "http";
  // Prefer request URL protocol; helpers still gate forwarded trust via env.
  const synthetic = new Request(`${urlProto}://${host}/unlock`, {
    headers: {
      "x-forwarded-proto": protoHeader ?? "",
      host,
    },
  });

  // When trust proxy is off, ignore forged forwarded proto by using http base
  // unless the connection itself is https (rare for Node direct).
  const direct = new Request(`http://${host}/unlock`, {
    headers: {
      host,
      ...(protoHeader ? { "x-forwarded-proto": protoHeader } : {}),
    },
  });
  const showHttpWarning = shouldWarnPlainHttp(direct);
  void resolveEffectiveProtocol(synthetic);

  return (
    <I18nProvider>
      <ServerUnlockForm showHttpWarning={showHttpWarning} />
    </I18nProvider>
  );
}
