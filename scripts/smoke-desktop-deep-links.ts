/**
 * Smoke checks for desktop pet WebUI deep-link allowlist + one-time intents (U5).
 * Run: npx --yes tsx@4.23.1 scripts/smoke-desktop-deep-links.ts
 */
import assert from "node:assert/strict";

import {
  buildAgentDeepLink,
  buildAutomationDeepLink,
  buildDesktopDeepLink,
  buildQuickCommandDeepLink,
  buildSnflowDeepLink,
  DESKTOP_DEEP_LINK_UNAVAILABLE,
  isAllowlistedDesktopDeepLink,
  parseDesktopDeepLink,
  parseDesktopDeepLinkIntent,
  resolveDesktopDeepLink,
  stripDesktopDeepLinkIntentParams,
} from "../lib/desktop-deep-link";

function main() {
  console.log("smoke-desktop-deep-links: start");

  // --- Builders ---
  assert.equal(buildAgentDeepLink("sess-1"), "/?session=sess-1");
  assert.equal(
    buildSnflowDeepLink({ taskId: "task-a", sessionId: "host-1" }),
    "/?session=host-1&inspector=snflow&task=task-a",
  );
  assert.equal(buildSnflowDeepLink({ taskId: "task-a" }), "/?inspector=snflow&task=task-a");
  assert.equal(
    buildAutomationDeepLink({ taskId: "auto-t", runId: "run-9" }),
    "/?panel=automation&task=auto-t&run=run-9",
  );
  assert.equal(
    buildQuickCommandDeepLink({ runId: "qc-run-1" }),
    "/?panel=quick-commands&run=qc-run-1",
  );
  assert.equal(
    buildDesktopDeepLink({ kind: "agent", sessionId: "s1" }),
    buildAgentDeepLink("s1"),
  );

  // Encoding of reserved characters in ids
  const encoded = buildAgentDeepLink("sess:with-colon");
  assert.equal(encoded, "/?session=sess%3Awith-colon");
  const parsedEncoded = parseDesktopDeepLink(encoded);
  assert.equal(parsedEncoded.ok, true);
  if (parsedEncoded.ok) {
    assert.equal(parsedEncoded.target.kind, "agent");
    if (parsedEncoded.target.kind === "agent") {
      assert.equal(parsedEncoded.target.sessionId, "sess:with-colon");
    }
  }

  // --- Ordinary session restore remains compatible ---
  const agent = parseDesktopDeepLink("/?session=abc123");
  assert.equal(agent.ok, true);
  if (agent.ok) {
    assert.equal(agent.target.kind, "agent");
    assert.equal(agent.href, "/?session=abc123");
  }
  // Intent parser: bare session is not a panel intent
  const bareSessionIntent = parseDesktopDeepLinkIntent("?session=abc123");
  assert.equal(bareSessionIntent.ok, true);
  if (bareSessionIntent.ok) assert.equal(bareSessionIntent.intent, null);

  // --- SnFlow / Automation / Quick Command parse once ---
  const snflow = parseDesktopDeepLink("/?session=host-1&inspector=snflow&task=task-a");
  assert.equal(snflow.ok, true);
  if (snflow.ok) {
    assert.deepEqual(snflow.target, {
      kind: "snflow",
      sessionId: "host-1",
      taskId: "task-a",
    });
  }
  const snflowIntent = parseDesktopDeepLinkIntent({
    session: "host-1",
    inspector: "snflow",
    task: "task-a",
  });
  assert.equal(snflowIntent.ok, true);
  if (snflowIntent.ok) {
    assert.deepEqual(snflowIntent.intent, {
      kind: "snflow",
      sessionId: "host-1",
      taskId: "task-a",
    });
  }

  const auto = parseDesktopDeepLink("/?panel=automation&task=t1&run=r1");
  assert.equal(auto.ok, true);
  if (auto.ok) {
    assert.deepEqual(auto.target, { kind: "automation", taskId: "t1", runId: "r1" });
  }
  const autoIntent = parseDesktopDeepLinkIntent("panel=automation&task=t1&run=r1");
  assert.equal(autoIntent.ok, true);
  if (autoIntent.ok) {
    assert.deepEqual(autoIntent.intent, { kind: "automation", taskId: "t1", runId: "r1" });
  }

  const qc = parseDesktopDeepLink("/?panel=quick-commands&run=run-x");
  assert.equal(qc.ok, true);
  if (qc.ok) {
    assert.deepEqual(qc.target, { kind: "quick_command", runId: "run-x" });
  }
  const qcIntent = parseDesktopDeepLinkIntent({ panel: "quick-commands", run: "run-x" });
  assert.equal(qcIntent.ok, true);
  if (qcIntent.ok) {
    assert.deepEqual(qcIntent.intent, { kind: "quick_command", runId: "run-x" });
  }

  // --- Invalid URLs / query keys rejected ---
  const rejects: Array<[string, string]> = [
    ["https://evil.example/?session=x", "absolute"],
    ["http://127.0.0.1:62666/?session=x", "absolute"],
    ["//evil.example/?session=x", "protocol"],
    ["/?session=x&cwd=C:%5Csecret", "cwd"],
    ["/?session=x&path=/etc/passwd", "path"],
    ["/?session=x&token=secret", "token"],
    ["/?panel=evil&run=r", "panel"],
    ["/?inspector=files&task=t", "inspector"],
    ["/?panel=automation&task=t", "missing run"],
    ["/?panel=quick-commands", "missing run"],
    ["/?inspector=snflow", "missing task"],
    ["/file?path=x", "path"],
    ["/?session=../escape", "id"],
    ["/?session=a/b", "id"],
  ];
  for (const [href] of rejects) {
    const result = parseDesktopDeepLink(href);
    assert.equal(result.ok, false, `expected reject: ${href}`);
    assert.equal(isAllowlistedDesktopDeepLink(href), false, href);
  }

  // Intent-level rejects
  assert.equal(parseDesktopDeepLinkIntent("?panel=automation&task=only").ok, false);
  assert.equal(parseDesktopDeepLinkIntent("?task=orphan").ok, false);
  assert.equal(parseDesktopDeepLinkIntent("?cwd=/tmp").ok, false);

  // --- Strip intent keys; keep session (close panel not reopened by leftover query) ---
  const stripped = stripDesktopDeepLinkIntentParams(
    "?session=host-1&inspector=snflow&task=task-a",
  );
  assert.equal(stripped.sessionId, "host-1");
  assert.equal(stripped.search, "?session=host-1");
  const strippedAuto = stripDesktopDeepLinkIntentParams("?panel=automation&task=t&run=r");
  assert.equal(strippedAuto.sessionId, null);
  assert.equal(strippedAuto.search, "");
  // After strip, re-parse yields no panel intent
  const afterStrip = parseDesktopDeepLinkIntent(stripped.search);
  assert.equal(afterStrip.ok, true);
  if (afterStrip.ok) assert.equal(afterStrip.intent, null);

  // --- Resolve against verified loopback origin only ---
  const resolved = resolveDesktopDeepLink("http://127.0.0.1:62666", "/?session=s1");
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.url, "http://127.0.0.1:62666/?session=s1");
  }
  assert.equal(resolveDesktopDeepLink("http://localhost:62666", "/?session=s1").ok, false);
  assert.equal(resolveDesktopDeepLink("https://example.com", "/?session=s1").ok, false);
  assert.equal(resolveDesktopDeepLink("http://127.0.0.1:62666", "https://evil/").ok, false);

  // Unavailable reason codes are stable
  assert.equal(DESKTOP_DEEP_LINK_UNAVAILABLE.quick_command_run, "quick_command_run_unavailable");
  assert.equal(DESKTOP_DEEP_LINK_UNAVAILABLE.snflow_task, "snflow_task_unavailable");
  assert.equal(DESKTOP_DEEP_LINK_UNAVAILABLE.automation_run, "automation_run_unavailable");

  console.log("smoke-desktop-deep-links: ok");
}

main();
