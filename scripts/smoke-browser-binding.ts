/**
 * Deterministic smoke checks for browser binding protocol/state/pairing/redaction/security.
 * Run: npx tsx scripts/smoke-browser-binding.ts
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import {
  BrowserControlError,
  BROWSER_PROTOCOL_VERSION,
  BROWSER_RESPONSE_BUDGETS,
  MAX_ENVELOPE_AGE_MS,
  MAX_SCREENSHOT_BASE64_CHARS,
  createEnvelope,
  browserResponseBudget,
  parseEnvelope,
  serializedBrowserResponseBytes,
  toBindingView,
  validateBrowserSnapshotParams,
  validateBrowserWaitParams,
} from "../lib/browser-protocol";
import {
  acceptBinding,
  canTransition,
  closeBinding,
  createBindingStore,
  createPendingRequest,
  crossOriginNavigation,
  enableDebug,
  getPrimaryBindingId,
  listSessionBindings,
  resolveTargetBinding,
  resumeBinding,
  revokeBinding,
  revokeSessionBindings,
  sameOriginNavigation,
  setPrimaryBinding,
  suspendBinding,
} from "../lib/browser-binding-state";
import {
  exchangePairingCode,
  issueConnectToken,
  issuePairingCode,
  normalizePairingCode,
  setBrowserBridgeEnabled,
  verifyConnectHandshake,
  verifyInstallationSecret,
} from "../lib/browser-pairing";
import {
  isSensitiveControl,
  networkSummarySafe,
  redactUrl,
  sanitizeConsoleText,
  sanitizeConsoleValue,
  summarizeAuditParams,
} from "../lib/browser-redaction";
import {
  evaluateActionPolicy,
  isDestructiveControl,
  isDownloadLike,
  isFileInput,
  isPasswordOrPaymentField,
  isPermissionTrigger,
} from "../lib/browser-action-policy";
import { ensureBrowserBridgeStarted, getBrowserBridge, stopBrowserBridge } from "../lib/browser-bridge";
import { getBrowserBindingManager } from "../lib/browser-binding-manager";
import { listBrowserAudit, recordBrowserAudit, resetBrowserAuditForTests } from "../lib/browser-audit";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function connectAuthedClient(port: number, agentDir: string): Promise<{
  ws: WebSocket;
  clientId: string;
  installationSecret: string;
  waitFor: (predicate: (msg: Record<string, unknown>) => boolean, ms?: number) => Promise<Record<string, unknown>>;
  send: (msg: unknown) => void;
  close: () => void;
}> {
  setBrowserBridgeEnabled(true, agentDir);
  const offer = issuePairingCode({ agentDir, port, ttlMs: 60_000 });
  const exchanged = exchangePairingCode({
    pairingCode: offer.pairingCode,
    agentDir,
    extensionOrigin: "chrome-extension://test-extension-id",
  });
  const token = issueConnectToken({
    clientId: exchanged.clientId,
    installationSecret: exchanged.installationSecret,
    agentDir,
  });
  const handshakeResponse = createHash("sha256")
    .update(`snail-pi-browser-v1:${token.nonce}:${token.connectToken}`)
    .digest("hex");

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { Origin: "chrome-extension://test-extension-id" },
  });

  const inbox: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (msg: Record<string, unknown>) => boolean;
    resolve: (msg: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  const push = (msg: Record<string, unknown>) => {
    for (let i = 0; i < waiters.length; i += 1) {
      const w = waiters[i]!;
      if (w.predicate(msg)) {
        clearTimeout(w.timer);
        waiters.splice(i, 1);
        w.resolve(msg);
        return;
      }
    }
    inbox.push(msg);
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 5000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on("error", reject);
  });

  ws.on("message", (data) => {
    try {
      push(JSON.parse(String(data)) as Record<string, unknown>);
    } catch {
      // ignore
    }
  });

  ws.send(JSON.stringify({
    type: "auth",
    protocolVersion: 1,
    clientId: exchanged.clientId,
    connectToken: token.connectToken,
    nonce: token.nonce,
    response: handshakeResponse,
  }));

  const waitFor = (predicate: (msg: Record<string, unknown>) => boolean, ms = 5000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const idx = inbox.findIndex(predicate);
      if (idx >= 0) {
        const [msg] = inbox.splice(idx, 1);
        resolve(msg!);
        return;
      }
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error("waitFor timeout"));
      }, ms);
      waiters.push({ predicate, resolve, reject, timer });
    });

  await waitFor((m) => m.type === "auth_ok");

  return {
    ws,
    clientId: exchanged.clientId,
    installationSecret: exchanged.installationSecret,
    waitFor,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => {
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}

async function main(): Promise<void> {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-browser-smoke-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  let failed = 0;
  function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
      .then(fn)
      .then(() => console.log(`ok - ${name}`))
      .catch((error) => {
        failed += 1;
        console.error(`fail - ${name}:`, error instanceof Error ? error.message : error);
      });
  }

  await check("protocol envelope version", () => {
    const env = createEnvelope("ping", "c1", "r1", { t: 1 });
    assert(env.protocolVersion === BROWSER_PROTOCOL_VERSION, "version");
    const parsed = parseEnvelope(env);
    assert(parsed.kind === "ping", "kind");
    try {
      parseEnvelope({ ...env, protocolVersion: 99 });
      assert(false, "should reject version");
    } catch (error) {
      assert(error instanceof BrowserControlError && error.code === "PROTOCOL_MISMATCH", "mismatch");
    }
  });

  await check("response budgets are explicit and command-scoped", () => {
    assert(browserResponseBudget("page.act") === BROWSER_RESPONSE_BUDGETS.compact, "action compact budget");
    assert(browserResponseBudget("page.snapshot") === BROWSER_RESPONSE_BUDGETS.snapshot, "snapshot budget");
    assert(browserResponseBudget("page.console") === BROWSER_RESPONSE_BUDGETS.diagnostics, "diagnostics budget");
    assert(browserResponseBudget("page.screenshot") === null, "screenshot uses image budget");
    assert(serializedBrowserResponseBytes({ ok: true }) < BROWSER_RESPONSE_BUDGETS.compact, "small response within budget");
    validateBrowserSnapshotParams({ mode: "interactive", maxTextChars: 100 });
    validateBrowserWaitParams({ condition: "clickable", value: "#submit" });
    try {
      validateBrowserWaitParams({ condition: "not-supported", value: "x" });
      assert(false, "invalid wait condition must fail validation");
    } catch (error) {
      assert(error instanceof BrowserControlError && error.code === "INVALID_WAIT_CONDITION", "invalid wait validation code");
    }
  });

  await check("binding state machine and ownership", () => {
    const store = createBindingStore();
    createPendingRequest(store, {
      pendingRequestId: "p1",
      sessionId: "s1",
      sessionLabel: "S1",
      requestedCapabilities: ["dom"],
      ttlMs: 60_000,
    });
    const b1 = acceptBinding(store, {
      bindingId: "b1",
      pendingRequestId: "p1",
      clientId: "ext1",
      tabId: 10,
      documentId: "d1",
      origin: "https://a.example",
      title: "A",
      url: "https://a.example/",
    });
    assert(b1.state === "active_dom", "active");
    assert(getPrimaryBindingId(store, "s1") === "b1", "primary first");

    createPendingRequest(store, {
      pendingRequestId: "p2",
      sessionId: "s2",
      sessionLabel: "S2",
      requestedCapabilities: ["dom"],
      ttlMs: 60_000,
    });
    try {
      acceptBinding(store, {
        bindingId: "b2",
        pendingRequestId: "p2",
        clientId: "ext1",
        tabId: 10,
        documentId: "d2",
        origin: "https://a.example",
        title: "A2",
        url: "https://a.example/2",
      });
      assert(false, "should block second session on same tab");
    } catch (error) {
      assert(error instanceof BrowserControlError && error.code === "TAB_ALREADY_BOUND", "conflict");
    }
    assert(store.pendingById.has("p2"), "tab conflict preserves pending request");

    createPendingRequest(store, {
      pendingRequestId: "p3",
      sessionId: "s1",
      sessionLabel: "S1",
      requestedCapabilities: ["dom"],
      ttlMs: 60_000,
    });
    const b3 = acceptBinding(store, {
      bindingId: "b3",
      pendingRequestId: "p3",
      clientId: "ext1",
      tabId: 11,
      documentId: "d3",
      origin: "https://b.example",
      title: "B",
      url: "https://b.example/",
    });
    assert(listSessionBindings(store, "s1").length === 2, "multi tab");
    setPrimaryBinding(store, "s1", b3.bindingId);
    assert(getPrimaryBindingId(store, "s1") === "b3", "set primary");

    sameOriginNavigation(store, "b1", {
      documentId: "d1b",
      origin: "https://a.example",
      title: "A'",
      url: "https://a.example/path",
    });
    const suspended = crossOriginNavigation(store, "b1", {
      documentId: "d1c",
      origin: "https://other.example",
      title: "O",
      url: "https://other.example/",
    });
    assert(suspended.state === "suspended", "cross origin suspend");
    assert(canTransition("active_dom", "suspended"), "transition allowed");

    // Passive same-origin navigation after suspension must NOT auto-resume.
    const stillSuspended = sameOriginNavigation(store, "b1", {
      documentId: "d1d",
      origin: "https://other.example",
      title: "O2",
      url: "https://other.example/path",
    });
    assert(stillSuspended.state === "suspended", "same-origin while suspended stays suspended");
    assert(stillSuspended.documentId === "d1d", "metadata still updates while suspended");

    // Explicit resume is required.
    const resumed = resumeBinding(store, "b1", {
      documentId: "d1e",
      origin: "https://other.example",
      title: "O3",
      url: "https://other.example/confirmed",
    });
    assert(resumed.state === "active_dom", "explicit resume restores active_dom");

    enableDebug(store, "b3");
    const target = resolveTargetBinding(store, "s1");
    assert(target.bindingId === "b3", "resolve primary");
    assert(target.capabilities.includes("debug_readonly"), "debug cap");

    const view = toBindingView(target, "b3");
    assert(view.primary === true, "view primary");
    assert(!("tabId" in view), "no tabId in view");
    const redactedView = toBindingView({
      ...target,
      title: "x".repeat(400),
      url: "https://a.example/?access_token=secret-value",
    }, "b3");
    assert(!redactedView.url.includes("secret-value"), "binding view redacts URL credentials");
    assert(redactedView.title.length <= 200, "binding view bounds title");

    suspendBinding(store, "b3", "cross_origin", {
      origin: "https://other.example",
      title: "Other",
      url: "https://other.example/",
      documentId: "d3-suspended",
    });
    setPrimaryBinding(store, "s1", "b3");
    revokeBinding(store, "b3");
    assert(getPrimaryBindingId(store, "s1") === "b1", "primary fallback prefers active binding over suspended");

    revokeSessionBindings(store, "s1");
    assert(listSessionBindings(store, "s1").length === 0, "session clear");
    void suspendBinding;
  });

  await check("closed binding tombstone has typed recovery", () => {
    const store = createBindingStore();
    createPendingRequest(store, {
      pendingRequestId: "p-closed",
      sessionId: "closed-session",
      sessionLabel: "Closed",
      requestedCapabilities: ["dom"],
      ttlMs: 60_000,
    });
    acceptBinding(store, {
      bindingId: "b-closed",
      pendingRequestId: "p-closed",
      clientId: "ext-closed",
      tabId: 88,
      documentId: "doc-closed",
      origin: "https://closed.example",
      title: "Closed",
      url: "https://closed.example/",
    });
    const closed = closeBinding(store, "b-closed");
    assert(closed.state === "closed", "closed state retained");
    try {
      resolveTargetBinding(store, "closed-session", "b-closed");
      assert(false, "closed binding must not resolve");
    } catch (error) {
      assert(error instanceof BrowserControlError && error.code === "TAB_CLOSED", "closed binding recovery code");
    }
  });

  await check("redaction of console/network/audit secrets", () => {
    const url = redactUrl("https://api.example/x?access_token=secret&q=1");
    assert(/(\[redacted\]|%5Bredacted%5D)/i.test(url), "token redacted");
    assert(!url.includes("secret"), "no secret");
    assert(isSensitiveControl({ type: "password" }), "password");
    assert(isSensitiveControl({ name: "card_number" }), "card");
    const net = networkSummarySafe({
      url: "https://x.test?api_key=abc",
      method: "POST",
      status: 500,
      resourceType: "fetch",
      failed: true,
    });
    assert(/(\[redacted\]|%5Bredacted%5D)/i.test(String(net.url)), "net url");
    const consoleText = sanitizeConsoleText("authorization: Bearer super-secret-token cookie: a=b api_key=xyz");
    assert(consoleText.includes("[redacted]"), "console redacted");
    assert(!consoleText.includes("super-secret-token"), "no bearer");
    assert(!consoleText.includes("api_key=xyz"), "no api key value");
    // Plain token forms and query credentials in free text / stacks.
    const plainToken = sanitizeConsoleText("failed token=super-plain-secret api_key=abc123");
    assert(!plainToken.includes("super-plain-secret"), "plain token= redacted");
    assert(!plainToken.includes("abc123"), "plain api_key= redacted");
    const stackish = sanitizeConsoleText(
      "Error at https://cdn.example/app.js?token=stack-secret-value:12\npassword=hunter2",
    );
    assert(!stackish.includes("stack-secret-value"), "stack URL token redacted");
    assert(!stackish.includes("hunter2"), "stack password redacted");
    const nested = sanitizeConsoleValue({
      authorization: "secret",
      nested: { token: "abc", ok: true },
      msg: "Bearer abc.def",
    });
    assert((nested as { authorization: string }).authorization === "[redacted]", "nested auth");
    const audit = summarizeAuditParams({
      text: "typed password value should never be stored",
      value: "select-option",
      action: "type",
      url: "https://x.test?token=abc",
      limit: 3,
    });
    assert(String(audit?.text).startsWith("[redacted:"), "audit text redacted");
    assert(String(audit?.value).startsWith("[redacted:"), "audit value redacted");
    assert(!JSON.stringify(audit).includes("typed password"), "no typed text");
    assert(MAX_SCREENSHOT_BASE64_CHARS < 512 * 1024, "screenshot under frame");
    assert(MAX_ENVELOPE_AGE_MS > 0, "envelope age");
  });

  await check("action safety policy blocks download/password/destructive/permission", () => {
    assert(isFileInput({ action: "click", tagName: "input", type: "file" }), "file");
    assert(isPasswordOrPaymentField({ action: "type", type: "password" }), "pwd");
    assert(isPasswordOrPaymentField({ action: "type", name: "card_number" }), "card field");
    assert(isDownloadLike({ action: "click", tagName: "a", href: "https://x.test/file.pdf", download: true }), "download attr");
    assert(isDownloadLike({ action: "click", tagName: "a", href: "https://x.test/a.zip" }), "download ext");
    assert(isPermissionTrigger({ action: "click", role: "button", text: "Allow camera access" }), "permission");
    assert(isDestructiveControl({ action: "click", text: "Delete account" }), "destructive");

    const blocked = [
      evaluateActionPolicy({ action: "click", tagName: "input", type: "file" }),
      evaluateActionPolicy({ action: "type", tagName: "input", type: "password" }),
      evaluateActionPolicy({ action: "click", tagName: "a", href: "https://cdn.test/app.exe", text: "Download" }),
      evaluateActionPolicy({ action: "click", role: "button", text: "Delete forever" }),
      evaluateActionPolicy({ action: "click", role: "button", text: "Enable notifications" }),
    ];
    for (const d of blocked) assert(!d.allowed, (!d.allowed && d.reason) || "blocked");

    const allowed = evaluateActionPolicy({
      action: "click",
      tagName: "button",
      role: "button",
      text: "Save draft",
    });
    const semanticAllowed = [
      evaluateActionPolicy({ action: "fill", tagName: "input", type: "text", name: "email" }),
      evaluateActionPolicy({ action: "clear", tagName: "textarea", name: "comment" }),
      evaluateActionPolicy({ action: "press", tagName: "input", type: "text", key: "Enter", modifiers: ["Control"] }),
      evaluateActionPolicy({ action: "check", tagName: "input", type: "checkbox", text: "Subscribe" }),
      evaluateActionPolicy({ action: "hover", tagName: "button", role: "button", text: "Open menu" }),
    ];
    assert(semanticAllowed.every((decision) => decision.allowed), "safe semantic actions allowed");
    assert(!evaluateActionPolicy({ action: "hover", tagName: "button", role: "button", text: "Delete account" }).allowed, "destructive hover blocked");
    assert(!evaluateActionPolicy({ action: "press", tagName: "input", type: "text", key: "F12" }).allowed, "arbitrary press key blocked");
  assert(!evaluateActionPolicy({ action: "fill", tagName: "input", type: "password", name: "password" }).allowed, "fill password blocked");
  assert(!evaluateActionPolicy({ action: "clear", tagName: "input", type: "file" }).allowed, "clear file input blocked");
    assert(allowed.allowed, "safe click allowed");
  });

  await check("pairing challenge and connect token", async () => {
    setBrowserBridgeEnabled(true, agentDir);
    const offer2 = issuePairingCode({ agentDir, ttlMs: 60_000, port: 62667 });
    assert(normalizePairingCode(offer2.pairingCode).length === 8, "code length");
    const exchanged = exchangePairingCode({
      pairingCode: offer2.pairingCode,
      agentDir,
      extensionOrigin: "chrome-extension://test",
    });
    assert(exchanged.clientId.startsWith("ext_"), "client id");
    assert(verifyInstallationSecret(exchanged.clientId, exchanged.installationSecret, agentDir), "secret verifies");

    const token = issueConnectToken({
      clientId: exchanged.clientId,
      installationSecret: exchanged.installationSecret,
      agentDir,
    });
    const handshakeResponse = createHash("sha256")
      .update(`snail-pi-browser-v1:${token.nonce}:${token.connectToken}`)
      .digest("hex");
    assert(verifyConnectHandshake({
      clientId: exchanged.clientId,
      connectToken: token.connectToken,
      nonce: token.nonce,
      response: handshakeResponse,
    }), "handshake ok");
    assert(!verifyConnectHandshake({
      clientId: exchanged.clientId,
      connectToken: token.connectToken,
      nonce: token.nonce,
      response: handshakeResponse,
    }), "handshake one-time");
  });

  await check("browser tools do not accept sessionId param", async () => {
    // Source-level check avoids loading pi-ai under tsx CJS (ESM-only package exports).
    const { readFileSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    const source = readFileSync(pathJoin(process.cwd(), "lib", "browser-tools.ts"), "utf8");
    for (const name of [
      "browser_tabs",
      "browser_snapshot",
      "browser_find",
      "browser_act",
      "browser_wait",
      "browser_screenshot",
      "browser_console",
      "browser_network",
    ]) {
      assert(source.includes(`name: "${name}"`), `tool ${name} defined`);
    }
    assert(source.includes('"fill"'), "semantic fill action schema");
    assert(source.includes('"semantic_actions_v1"'), "semantic feature gate");
    assert(source.includes("key"), "press key schema");
    assert(source.includes("modifiers"), "press modifiers schema");
    assert(source.includes("interactive"), "interactive snapshot schema");
    assert(source.includes("clickable"), "enhanced wait schema");
    // sessionId must come from ctx.sessionManager, never from model tool parameters schema.
    assert(source.includes("sessionIdFromCtx"), "injects session from ctx");
    assert(source.includes("sessionManager?.getSessionId"), "reads session from manager");
    // Tool schemas must not declare a model-supplied sessionId field.
    assert(!/sessionId\s*:\s*Type\./.test(source), "no sessionId Type field in schemas");
    assert(!/sessionId\s*:\s*Type\.Optional/.test(source), "no optional sessionId param");
  });

  await check("bridge auth, origin, stale envelope, authenticated accept", async () => {
    await stopBrowserBridge().catch(() => undefined);
    const port = 62000 + Math.floor(Math.random() * 1000);
    await ensureBrowserBridgeStarted(port);
    const bridge = getBrowserBridge();
    assert(bridge.getStatus().running, "running");
    assert(bridge.getStatus().host === "127.0.0.1", "loopback");

    // Bad auth should close.
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const timer = setTimeout(() => reject(new Error("timeout waiting close")), 5000);
      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "auth",
          protocolVersion: 1,
          clientId: "nope",
          connectToken: "bad",
          nonce: "n",
          response: "r",
        }));
      });
      ws.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on("error", () => {
        // ignore
      });
    });

    const client = await connectAuthedClient(port, agentDir);
    assert(bridge.getStatus().connectedClients.some((c) => c.clientId === client.clientId), "client listed");

    const manager = getBrowserBindingManager();
    manager.resetTemporaryState();
    manager.attachBridgeListeners();

    // HTTP accept must be rejected (forged clientId/tabId path closed).
    try {
      manager.acceptPendingFromExtension({
        pendingRequestId: "x",
        clientId: client.clientId,
        tabId: 1,
        documentId: "d",
        origin: "https://example.com",
        title: "t",
        url: "https://example.com/",
        authenticatedClient: false,
      });
      assert(false, "unauthenticated accept must fail");
    } catch (error) {
      assert(error instanceof BrowserControlError && error.code === "AUTH_FAILED", "auth failed code");
    }

    const pending = manager.createPendingBindingRequest({ sessionId: "session-real-1", sessionLabel: "demo" });

    // Authenticated WS accept — clientId taken from auth context, not forged body clientId.
    const acceptReqId = "req-accept-1";
    client.send({
      protocolVersion: 1,
      kind: "request",
      requestId: acceptReqId,
      clientId: client.clientId,
      timestamp: Date.now(),
      payload: {
        command: "binding.accept",
        params: {
          pendingRequestId: pending.pendingRequestId,
          // Deliberately wrong clientId in body — server must ignore it.
          clientId: "forged-client",
          tabId: 42,
          documentId: "doc-1",
          origin: "https://example.com",
          title: "Example",
          url: "https://example.com/",
        },
      },
    });
    const acceptResp = await client.waitFor((m) => m.kind === "response" && m.requestId === acceptReqId);
    const acceptPayload = acceptResp.payload as { ok?: boolean; result?: { binding?: { bindingId?: string; primary?: boolean }; sessionId?: string; tabId?: number } };
    assert(acceptPayload.ok === true, "accept ok");
    assert(acceptPayload.result?.binding?.bindingId?.startsWith("bind_"), "opaque binding id");
    assert(acceptPayload.result?.sessionId === "session-real-1", "real session");
    assert(acceptPayload.result?.tabId === 42, "tab internal to extension result only");
    assert(manager.listBindings("session-real-1").length === 1, "manager has binding");
    assert(!("tabId" in manager.listBindings("session-real-1")[0]!), "model view hides tabId");

    try {
      await manager.runToolCommand({
        sessionId: "session-real-1",
        command: "page.act",
        bindingId: acceptPayload.result?.binding?.bindingId,
        params: { action: "fill", elementRef: "el_legacy_1", text: "secret-value" },
        requiredCapability: "dom",
        requiredExtensionFeatures: ["element_diagnostics_v1", "post_action_state_v1", "semantic_actions_v1"],
      });
      assert(false, "legacy extension must fail before action dispatch");
    } catch (error) {
      assert(
        error instanceof BrowserControlError && error.code === "UNSUPPORTED_EXTENSION_CAPABILITY",
        "legacy extension gets typed upgrade error",
      );
    }
    assert(
      listBrowserAudit(50).some((entry) => entry.status === "error" && entry.code === "UNSUPPORTED_EXTENSION_CAPABILITY"),
      "unsupported semantic action is audited",
    );
    try {
      await manager.runToolCommand({
        sessionId: "session-real-1",
        command: "page.wait",
        bindingId: acceptPayload.result?.binding?.bindingId,
        params: { condition: "clickable", value: "#submit" },
        requiredCapability: "dom",
        requiredExtensionFeatures: ["wait_diagnostics_v1"],
      });
      assert(false, "legacy extension must fail enhanced wait before dispatch");
    } catch (error) {
      assert(error instanceof BrowserControlError && error.code === "UNSUPPORTED_EXTENSION_CAPABILITY", "legacy enhanced wait upgrade error");
    }

    // Cross-session tool routing still rejected by manager.
    try {
      await manager.runToolCommand({
        sessionId: "session-other",
        command: "page.snapshot",
        bindingId: acceptPayload.result?.binding?.bindingId,
      });
      assert(false, "cross-session must fail");
    } catch (error) {
      assert(error instanceof BrowserControlError, "typed error");
    }

    // Stale envelope rejected (no crash).
    client.send({
      protocolVersion: 1,
      kind: "request",
      requestId: "stale-1",
      clientId: client.clientId,
      timestamp: Date.now() - MAX_ENVELOPE_AGE_MS - 10_000,
      payload: { command: "binding.pending", params: {} },
    });
    // Give bridge a moment; should not create binding side effects.
    await new Promise((r) => setTimeout(r, 100));

    // Bridge stop clears temporary bindings.
    client.close();
    await stopBrowserBridge();
    assert(manager.listBindings("session-real-1").length === 0, "reset on bridge stop");
  });

  await check("audit never stores typed text and stays bounded", () => {
    resetBrowserAuditForTests();
    recordBrowserAudit({
      action: "tool.page.act",
      status: "ok",
      sessionId: "s",
      params: { action: "type", text: "super-secret-password", value: "hidden" },
    });
    const entries = listBrowserAudit(10);
    assert(entries.length >= 1, "has entry");
    const last = entries[entries.length - 1]!;
    assert(!JSON.stringify(last).includes("super-secret-password"), "no secret text");
    assert(String(last.params?.text || "").includes("redacted"), "text marker");
  });

  await check("audit rotation keeps at most one backup", async () => {
    const { writeFileSync, existsSync, readdirSync, mkdirSync, statSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    const { MAX_AUDIT_FILE_BYTES } = await import("../lib/browser-protocol");
    resetBrowserAuditForTests();
    const auditFile = pathJoin(agentDir, "browser-audit.jsonl");
    mkdirSync(agentDir, { recursive: true });
    // Seed oversized current file plus legacy timestamped backups.
    writeFileSync(auditFile, `${"x".repeat(MAX_AUDIT_FILE_BYTES + 100)}\n`, "utf8");
    writeFileSync(`${auditFile}.111.bak`, "old1\n", "utf8");
    writeFileSync(`${auditFile}.222.bak`, "old2\n", "utf8");
    recordBrowserAudit({
      action: "audit.rotate_probe",
      status: "ok",
      sessionId: "s-rotate",
      params: { action: "probe" },
    });
    const names = readdirSync(agentDir).filter((n) => n.startsWith("browser-audit.jsonl"));
    const bakNames = names.filter((n) => n.endsWith(".bak"));
    assert(bakNames.length <= 1, `at most one backup, got ${bakNames.join(",")}`);
    assert(existsSync(auditFile), "current audit file remains");
    assert(statSync(auditFile).size <= MAX_AUDIT_FILE_BYTES + 4096, "current file not unbounded");
    assert(!existsSync(`${auditFile}.111.bak`), "legacy timestamped backup 111 removed");
    assert(!existsSync(`${auditFile}.222.bak`), "legacy timestamped backup 222 removed");
  });

  await check("extension authorizeLocalBinding helper semantics", async () => {
    // Re-implement check against shared pure rules exported via dynamic evaluation of shared patterns.
    // The extension helper is JS-module; validate equivalent contract here.
    const state = {
      bindings: {
        bind_1: {
          bindingId: "bind_1",
          sessionId: "sess_a",
          tabId: 7,
          documentId: "doc_a",
          origin: "https://a.test",
          capabilities: ["dom"],
          state: "active_dom",
        },
      },
    };
    const { authorizeLocalBinding, sanitizeConsoleText: extSanitize } = await import("../extensions/chrome-tab-debug/shared.js") as {
      authorizeLocalBinding: (
        s: unknown,
        payload: Record<string, unknown>,
        params?: Record<string, unknown>,
        options?: { mode?: string },
      ) => { ok: boolean; code?: string };
      sanitizeConsoleText: (text: string) => string;
    };
    assert(authorizeLocalBinding(state, { bindingId: "bind_1", sessionId: "sess_a" }, {
      __tabId: 7,
      __documentId: "doc_a",
      __origin: "https://a.test",
    }).ok, "matching auth");
    assert(!authorizeLocalBinding(state, { bindingId: "bind_1", sessionId: "sess_b" }, {
      __tabId: 7,
      __documentId: "doc_a",
      __origin: "https://a.test",
    }).ok, "session mismatch");
    assert(!authorizeLocalBinding(state, { bindingId: "bind_1", sessionId: "sess_a" }, {
      __tabId: 99,
      __documentId: "doc_a",
      __origin: "https://a.test",
    }).ok, "tab mismatch");
    assert(!authorizeLocalBinding(state, { bindingId: "missing" }, {}).ok, "missing binding");
    // Missing routing identities must fail for page/debug commands.
    assert(!authorizeLocalBinding(state, { bindingId: "bind_1", sessionId: "sess_a" }, {}).ok, "missing identities");
    assert(!authorizeLocalBinding(state, { bindingId: "bind_1" }, {
      __tabId: 7,
      __documentId: "doc_a",
      __origin: "https://a.test",
    }).ok, "missing sessionId");
    // manage mode still requires session ownership before revoke/disable_debug side effects.
    assert(authorizeLocalBinding(state, { bindingId: "bind_1", sessionId: "sess_a" }, {}, { mode: "manage" }).ok, "manage ok");
    assert(!authorizeLocalBinding(state, { bindingId: "bind_1", sessionId: "sess_b" }, {}, { mode: "manage" }).ok, "manage session reject");
    const plain = extSanitize("token=plain-secret-value");
    assert(!plain.includes("plain-secret-value"), "ext plain token redacted");
  });

  await check("connect tokens survive isolated API and bridge module contexts", async () => {
    setBrowserBridgeEnabled(true, agentDir);
    const offer = issuePairingCode({ agentDir, ttlMs: 60_000 });
    const exchanged = exchangePairingCode({ pairingCode: offer.pairingCode, agentDir });
    const token = issueConnectToken({
      clientId: exchanged.clientId,
      installationSecret: exchanged.installationSecret,
      agentDir,
    });
    const handshakeResponse = createHash("sha256")
      .update(`snail-pi-browser-v1:${token.nonce}:${token.connectToken}`)
      .digest("hex");

    const isolatedModuleUrl = `${pathToFileURL(join(process.cwd(), "lib/browser-pairing.ts")).href}?isolated=${Date.now()}`;
    const isolated = await import(isolatedModuleUrl) as typeof import("../lib/browser-pairing");
    assert(isolated.verifyConnectHandshake({
      clientId: exchanged.clientId,
      connectToken: token.connectToken,
      nonce: token.nonce,
      response: handshakeResponse,
      agentDir,
    }), "file-backed token verifies from an isolated module context");
  });

  await check("bridge rejects missing Origin when pairedOrigin recorded", async () => {
    await stopBrowserBridge().catch(() => undefined);
    const port = 63000 + Math.floor(Math.random() * 1000);
    await ensureBrowserBridgeStarted(port);

    setBrowserBridgeEnabled(true, agentDir);
    const offer = issuePairingCode({ agentDir, port, ttlMs: 60_000 });
    const exchanged = exchangePairingCode({
      pairingCode: offer.pairingCode,
      agentDir,
      extensionOrigin: "chrome-extension://strict-origin-id",
    });
    const token = issueConnectToken({
      clientId: exchanged.clientId,
      installationSecret: exchanged.installationSecret,
      agentDir,
    });
    const handshakeResponse = createHash("sha256")
      .update(`snail-pi-browser-v1:${token.nonce}:${token.connectToken}`)
      .digest("hex");

    // Missing Origin must fail closed even with valid connect token.
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`); // no Origin header
      const timer = setTimeout(() => reject(new Error("timeout waiting close for missing origin")), 5000);
      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "auth",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          clientId: exchanged.clientId,
          connectToken: token.connectToken,
          nonce: token.nonce,
          response: handshakeResponse,
        }));
      });
      ws.on("close", (code) => {
        clearTimeout(timer);
        try {
          assert(code === 1008, `expected 1008 close, got ${code}`);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      ws.on("error", () => {
        // ignore
      });
    });

    // Wrong Origin must also fail.
    const token2 = issueConnectToken({
      clientId: exchanged.clientId,
      installationSecret: exchanged.installationSecret,
      agentDir,
    });
    const handshake2 = createHash("sha256")
      .update(`snail-pi-browser-v1:${token2.nonce}:${token2.connectToken}`)
      .digest("hex");
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { Origin: "chrome-extension://other-extension" },
      });
      const timer = setTimeout(() => reject(new Error("timeout waiting close for wrong origin")), 5000);
      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "auth",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          clientId: exchanged.clientId,
          connectToken: token2.connectToken,
          nonce: token2.nonce,
          response: handshake2,
        }));
      });
      ws.on("close", (code) => {
        clearTimeout(timer);
        try {
          assert(code === 1008, `expected 1008 close for mismatch, got ${code}`);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      ws.on("error", () => {
        // ignore
      });
    });

    await stopBrowserBridge();
  });

  await check("binding lifecycle events reject non-owning multi-client forgeries", async () => {
    await stopBrowserBridge().catch(() => undefined);
    const port = 64000 + Math.floor(Math.random() * 1000);
    await ensureBrowserBridgeStarted(port);

    const owner = await connectAuthedClient(port, agentDir);
    const attacker = await connectAuthedClient(port, agentDir);
    assert(owner.clientId !== attacker.clientId, "two distinct installations");

    const manager = getBrowserBindingManager();
    manager.resetTemporaryState();
    manager.attachBridgeListeners();

    const sessionId = "session-owner-lifecycle";
    const pending = manager.createPendingBindingRequest({ sessionId, sessionLabel: "owner" });
    const acceptReqId = "req-accept-owner-1";
    owner.send({
      protocolVersion: 1,
      kind: "request",
      requestId: acceptReqId,
      clientId: owner.clientId,
      timestamp: Date.now(),
      payload: {
        command: "binding.accept",
        params: {
          pendingRequestId: pending.pendingRequestId,
          tabId: 77,
          documentId: "doc-owner",
          origin: "https://owner.example",
          title: "Owner",
          url: "https://owner.example/",
        },
      },
    });
    const acceptResp = await owner.waitFor((m) => m.kind === "response" && m.requestId === acceptReqId);
    const acceptPayload = acceptResp.payload as { ok?: boolean; result?: { binding?: { bindingId?: string } } };
    assert(acceptPayload.ok === true, "owner accept ok");
    const bindingId = acceptPayload.result?.binding?.bindingId;
    assert(typeof bindingId === "string" && bindingId.length > 0, "binding id");

    const before = manager.listBindings(sessionId);
    assert(before.length === 1, "one binding before forgeries");
    assert(before[0]!.state === "active_dom" || before[0]!.state === "active_debug", "active before forgeries");

    const forgedEvents: Array<{ event: string; data?: Record<string, unknown>; sessionId?: string }> = [
      {
        event: "binding.resumed",
        sessionId,
        data: {
          documentId: "doc-forged",
          origin: "https://evil.example",
          url: "https://evil.example/",
          title: "Evil",
        },
      },
      {
        event: "binding.suspended",
        sessionId,
        data: { origin: "https://evil.example", title: "Evil", url: "https://evil.example/", documentId: "doc-x" },
      },
      {
        event: "binding.updated",
        sessionId,
        data: { documentId: "doc-forged-2", origin: "https://evil.example", url: "https://evil.example/x", title: "X" },
      },
      { event: "debugger_detached", sessionId, data: { reason: "replaced_with_devtools" } },
      { event: "binding.revoked", sessionId, data: {} },
      // Owner client but wrong sessionId must also be rejected.
      {
        event: "binding.revoked",
        sessionId: "session-other-forged",
        data: {},
      },
    ];

    for (let i = 0; i < forgedEvents.length; i += 1) {
      const forged = forgedEvents[i]!;
      const sender = forged.sessionId === "session-other-forged" ? owner : attacker;
      sender.send({
        protocolVersion: 1,
        kind: "event",
        requestId: `forge-evt-${i}`,
        clientId: sender.clientId,
        timestamp: Date.now(),
        payload: {
          event: forged.event,
          bindingId,
          sessionId: forged.sessionId,
          data: { bindingId, sessionId: forged.sessionId, ...(forged.data || {}) },
        },
      });
    }

    await new Promise((r) => setTimeout(r, 150));

    const afterForge = manager.listBindings(sessionId);
    assert(afterForge.length === 1, "forged multi-client events must not revoke binding");
    assert(afterForge[0]!.bindingId === bindingId, "same binding remains");
    assert(afterForge[0]!.origin === "https://owner.example", "origin unchanged by forgeries");
    assert(
      afterForge[0]!.state === "active_dom" || afterForge[0]!.state === "active_debug",
      `state must stay active after forgeries, got ${afterForge[0]!.state}`,
    );

    // Owning client + matching sessionId may still transition (suspend).
    owner.send({
      protocolVersion: 1,
      kind: "event",
      requestId: "owner-suspend-1",
      clientId: owner.clientId,
      timestamp: Date.now(),
      payload: {
        event: "binding.suspended",
        bindingId,
        sessionId,
        data: {
          bindingId,
          sessionId,
          origin: "https://other.example",
          title: "Other",
          url: "https://other.example/",
          documentId: "doc-other",
        },
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    const afterOwner = manager.listBindings(sessionId);
    assert(afterOwner.length === 1, "owner suspend keeps binding record");
    assert(afterOwner[0]!.state === "suspended", "owner suspend applies");

    owner.send({
      protocolVersion: 1,
      kind: "event",
      requestId: "owner-close-1",
      clientId: owner.clientId,
      timestamp: Date.now(),
      payload: {
        event: "binding.revoked",
        bindingId,
        sessionId,
        data: { bindingId, sessionId, reason: "tab_closed" },
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    const afterClose = manager.listBindings(sessionId);
    assert(afterClose[0]?.state === "closed", "tab close keeps bounded tombstone");
    try {
      await manager.runToolCommand({ sessionId, command: "page.snapshot", bindingId });
      assert(false, "closed tab command must fail");
    } catch (error) {
      assert(error instanceof BrowserControlError && error.code === "TAB_CLOSED", "closed tab command recovery");
    }

    owner.close();
    attacker.close();
    await stopBrowserBridge();
  });

  await check("pending bind requests stay session-scoped across multiple sessions", async () => {
    const manager = getBrowserBindingManager();
    manager.resetTemporaryState();
    const p1 = manager.createPendingBindingRequest({ sessionId: "sess-a", sessionLabel: "A" });
    const p2 = manager.createPendingBindingRequest({ sessionId: "sess-b", sessionLabel: "B" });
    const all = manager.listOpenPendingRequests();
    assert(all.length === 2, "two open pendings");
    assert(all.some((p) => p.pendingRequestId === p1.pendingRequestId), "has p1");
    assert(all.some((p) => p.pendingRequestId === p2.pendingRequestId), "has p2");
    // Unscoped single lookup is ambiguous with multiple sessions.
    assert(manager.getOpenPendingRequest() === null, "global single pending null when multi");
    assert(manager.getOpenPendingRequest("sess-a")?.pendingRequestId === p1.pendingRequestId, "scoped A");
    assert(manager.getOpenPendingRequest("sess-b")?.pendingRequestId === p2.pendingRequestId, "scoped B");
    // Replacing within one session keeps the other intact.
    const p1b = manager.createPendingBindingRequest({ sessionId: "sess-a", sessionLabel: "A2" });
    assert(manager.getOpenPendingRequest("sess-a")?.pendingRequestId === p1b.pendingRequestId, "A replaced");
    assert(manager.listOpenPendingRequests().length === 2, "still two sessions");
    assert(manager.getOpenPendingRequest("sess-b")?.pendingRequestId === p2.pendingRequestId, "B intact");
    manager.resetTemporaryState();
  });

  await check("browser-bridge.json writes are atomic and survive basic roundtrip", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    const { readBrowserBridgeState, writeBrowserBridgeState, setBrowserBridgeEnabled } = await import("../lib/browser-pairing");
    setBrowserBridgeEnabled(true, agentDir);
    const state = readBrowserBridgeState(agentDir);
    state.enabled = true;
    state.port = 62667;
    state.installations = [{
      clientId: "ext_atomic_test",
      secretVerifier: "salt:deadbeef",
      createdAt: Date.now(),
      label: "atomic",
    }];
    writeBrowserBridgeState(state, agentDir);
    const path = pathJoin(agentDir, "browser-bridge.json");
    assert(existsSync(path), "state file exists");
    const raw = readFileSync(path, "utf8");
    assert(raw.includes("ext_atomic_test"), "installation persisted");
    const reloaded = readBrowserBridgeState(agentDir);
    assert(reloaded.installations.some((i) => i.clientId === "ext_atomic_test"), "reload keeps installation");
    // No leftover temp files from atomic write.
    const { readdirSync } = await import("node:fs");
    const leftovers = readdirSync(agentDir).filter((n) => n.includes("browser-bridge.json.tmp"));
    assert(leftovers.length === 0, "no temp leftovers");
  });

  await check("generated extension action-policy matches lib source decisions", async () => {
    const { pathToFileURL: toUrl } = await import("node:url");
    const { join: pathJoin } = await import("node:path");
    const extPolicy = await import(toUrl(pathJoin(process.cwd(), "extensions/chrome-tab-debug/action-policy.js")).href + `?t=${Date.now()}`) as {
      evaluateActionPolicy: typeof evaluateActionPolicy;
    };
    const cases = [
      { action: "click", tagName: "input", type: "file" },
      { action: "type", tagName: "input", type: "password" },
      { action: "click", tagName: "a", href: "https://x.test/a.exe", text: "Download" },
      { action: "click", role: "button", text: "Save draft" },
    ] as const;
    for (const input of cases) {
      const a = evaluateActionPolicy(input);
      const b = extPolicy.evaluateActionPolicy(input);
      assert(a.allowed === b.allowed, `policy parity for ${JSON.stringify(input)}`);
    }
  });

  await check("BrowserBindingPanel revoke uses danger i18n confirm and cancel short-circuits", async () => {
    const { readFileSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    const panelPath = pathJoin(process.cwd(), "components", "BrowserBindingPanel.tsx");
    const source = readFileSync(panelPath, "utf8");
    assert(source.includes('t("panels.browser.revokeTitle")'), "revoke title i18n key");
    assert(source.includes('t("panels.browser.revokeAllTitle")'), "revoke-all title i18n key");
    assert(source.includes('t("panels.browser.revokeMessage")'), "revoke message i18n key");
    assert(source.includes('t("panels.browser.revokeAllMessage")'), "revoke-all message i18n key");
    assert(/tone:\s*["']danger["']/.test(source), "danger tone on revoke confirm");
    assert(/if\s*\(\s*!confirmed\s*\)\s*return/.test(source), "cancel short-circuits before revoke request");
    // Ensure hard-coded English revoke dialog copy is gone.
    assert(!source.includes("Revoke browser tab binding?"), "no hard-coded revoke message");
    assert(!source.includes("Revoke all browser tab bindings for this session?"), "no hard-coded revoke-all message");
    // Confirm keys resolve in both locales.
    const { messagesByLocale, translate } = await import("../lib/i18n");
    for (const locale of ["en", "zh"] as const) {
      const tree = messagesByLocale[locale];
      for (const key of [
        "panels.browser.revokeTitle",
        "panels.browser.revokeMessage",
        "panels.browser.revokeAllTitle",
        "panels.browser.revokeAllMessage",
      ]) {
        const text = translate(tree, messagesByLocale.en, key);
        assert(typeof text === "string" && text.length > 0 && text !== key, `${locale} ${key} resolves`);
      }
    }
  });

  rmSync(agentDir, { recursive: true, force: true });

  if (failed > 0) {
    console.error(`\n${failed} smoke check(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log("\nall browser binding smoke checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
