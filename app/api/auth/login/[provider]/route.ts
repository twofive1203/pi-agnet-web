import {
  InMemoryCredentialStore,
  ModelRuntime,
  isOAuthCredential,
  isOAuthProvider,
  type AuthInteraction,
} from "@/lib/pi-auth";
import { isAccountSwitchingSupported, saveOAuthAccountCredential, syncActiveOAuthAccountCredential } from "@/lib/oauth-accounts";
import { reloadRpcAuthState } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// In-memory registry: loginToken -> resolve/reject for the manualCodeInput promise
declare global {
  var __piLoginCallbacks: Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }> | undefined;
}

function getCallbackRegistry() {
  if (!globalThis.__piLoginCallbacks) globalThis.__piLoginCallbacks = new Map();
  return globalThis.__piLoginCallbacks;
}

// POST /api/auth/login/[provider] — frontend sends redirect URL or auth code
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const { token, code } = (await req.json()) as { token?: string; code?: string };

  if (!token || !code) {
    return Response.json({ error: "token and code required" }, { status: 400 });
  }

  const registry = getCallbackRegistry();
  const callbacks = registry.get(token);
  if (!callbacks) {
    return Response.json({ error: "No pending login for token" }, { status: 404 });
  }
  // Verify token belongs to this provider (token format: "<provider>-<ts>-<random>")
  if (!token.startsWith(`${provider}-`)) {
    return Response.json({ error: "Token does not match provider" }, { status: 400 });
  }

  callbacks.resolve(code);
  registry.delete(token);
  return Response.json({ ok: true, provider });
}

// GET /api/auth/login/[provider] — SSE stream for OAuth flow
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const accountMode = new URL(req.url).searchParams.get("accountMode");
  const addAccountMode = accountMode === "add";

  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, data: unknown) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  // AbortController propagates client disconnect into ModelRuntime.login()
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream({
    async start(controller) {
      if (accountMode && accountMode !== "add") {
        send(controller, { type: "error", message: `Unsupported account mode: ${accountMode}` });
        controller.close();
        return;
      }
      if (addAccountMode && !isAccountSwitchingSupported(provider)) {
        send(controller, { type: "error", message: `Account add mode is not supported for ${provider}` });
        controller.close();
        return;
      }

      const credentials = addAccountMode ? new InMemoryCredentialStore() : undefined;
      const runtime = await ModelRuntime.create(credentials ? { credentials } : undefined);
      if (!isOAuthProvider(runtime, provider)) {
        send(controller, { type: "error", message: `Unknown provider: ${provider}` });
        controller.close();
        return;
      }

      const registry = getCallbackRegistry();
      const activeTokens = new Set<string>();
      let pendingManualRequest: { token: string; promise: Promise<string> } | undefined;

      const createClientInputRequest = () => {
        const token = `${provider}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        activeTokens.add(token);

        const promise = new Promise<string>((resolve, reject) => {
          registry.set(token, {
            resolve: (value) => {
              activeTokens.delete(token);
              registry.delete(token);
              resolve(value);
            },
            reject: (error) => {
              activeTokens.delete(token);
              registry.delete(token);
              reject(error);
            },
          });
        });

        return { token, promise };
      };

      const getManualInputRequest = () => {
        if (!pendingManualRequest) {
          pendingManualRequest = createClientInputRequest();
          pendingManualRequest.promise
            .finally(() => {
              pendingManualRequest = undefined;
            })
            .catch(() => {});
        }
        return pendingManualRequest;
      };

      // Cleanup: remove pending token and abort any waiting promise
      const cleanup = () => {
        for (const token of activeTokens) {
          registry.get(token)?.reject(new Error("Login cancelled"));
          registry.delete(token);
        }
        activeTokens.clear();
      };

      // Also cancel on client disconnect
      abort.signal.addEventListener("abort", cleanup);

      const interaction: AuthInteraction = {
        signal: abort.signal,
        async prompt(prompt) {
          if (prompt.type === "select") {
            const request = createClientInputRequest();
            send(controller, {
              type: "select_request",
              message: prompt.message,
              options: prompt.options,
              token: request.token,
            });
            const value = await request.promise;
            return value || undefined as unknown as string;
          }

          const request = getManualInputRequest();
          if (prompt.type === "manual_code") {
            // Keep legacy event names for the frontend OAuth UI.
            send(controller, {
              type: "auth",
              url: "",
              instructions: prompt.message,
              token: request.token,
            });
          } else {
            send(controller, {
              type: "prompt_request",
              message: prompt.message,
              placeholder: prompt.placeholder ?? null,
              token: request.token,
            });
          }
          return request.promise;
        },
        notify(event) {
          if (event.type === "auth_url") {
            const request = getManualInputRequest();
            send(controller, {
              type: "auth",
              url: event.url,
              instructions: event.instructions ?? null,
              token: request.token,
            });
            return;
          }
          if (event.type === "device_code") {
            send(controller, {
              type: "device_code",
              userCode: event.userCode,
              verificationUri: event.verificationUri,
              intervalSeconds: event.intervalSeconds ?? null,
              expiresInSeconds: event.expiresInSeconds ?? null,
            });
            return;
          }
          if (event.type === "progress" || event.type === "info") {
            send(controller, { type: "progress", message: event.message });
          }
        },
      };

      try {
        const credential = await runtime.login(provider, "oauth", interaction);

        if (addAccountMode) {
          if (!isOAuthCredential(credential)) {
            throw new Error("Expected OAuth credential from login");
          }
          const account = await saveOAuthAccountCredential(provider, credential);
          send(controller, { type: "success", account, message: "Account saved successfully." });
        } else {
          if (isAccountSwitchingSupported(provider)) {
            await syncActiveOAuthAccountCredential(provider).catch(() => {});
          }
          reloadRpcAuthState();
          send(controller, { type: "success" });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== "Login cancelled") {
          send(controller, { type: "error", message: msg });
        } else {
          send(controller, { type: "cancelled" });
        }
      } finally {
        cleanup();
        controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
