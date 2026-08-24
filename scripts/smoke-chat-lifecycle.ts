/**
 * Browser-free main-chat integration smoke.
 *
 * Simulates: mock AgentSession events → AgentEventThrottler → prompt lifecycle
 * state machine (the contract behind hooks/useAgentSession.ts).
 *
 * Run: npx tsx scripts/smoke-chat-lifecycle.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentLifecycleDirective } from "../lib/agent-lifecycle";
import {
  agentMessageText,
  canSubmitQueuedMessage,
  normalizeFollowUpQueue,
  removedFollowUpItems,
} from "../lib/chat-follow-up-queue";
import {
  ChatPromptLifecycleHarness,
  applyChatPromptEvent,
  beginLocalPrompt,
  createInitialChatPromptLifecycleState,
  forceSettlePrompt,
  messageEnd,
  messageUpdate,
  toolEnd,
  toolStart,
} from "../lib/chat-prompt-lifecycle";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assertRunning(harness: ChatPromptLifecycleHarness, expected: boolean, label: string): void {
  assert.equal(harness.snapshot.agentRunning, expected, label);
}

function assertTypesIncludeInOrder(types: string[], expected: string[], label: string): void {
  let cursor = 0;
  for (const want of expected) {
    const idx = types.indexOf(want, cursor);
    assert.ok(idx >= 0, `${label}: missing ${want} after index ${cursor} in ${types.join(",")}`);
    cursor = idx + 1;
  }
}

/** 1) Happy path: start → stream → end → settled settles running. */
function checkHappyPath(): void {
  const harness = new ChatPromptLifecycleHarness({ throttleMs: 50 });
  harness.attachListener();
  harness.beginPrompt();
  assertRunning(harness, true, "local send marks running");
  assert.equal(harness.snapshot.phase, null, "pre-agent_start phase stays null for slash-command safety");

  harness.push({ type: "agent_start" });
  harness.push(messageUpdate("Hel"));
  harness.push(messageUpdate("Hello"));
  harness.push(messageEnd("Hello"));
  harness.push({ type: "agent_end" });
  // agent_end alone must NOT clear running
  assertRunning(harness, true, "agent_end keeps running");
  harness.push({ type: "agent_settled" });

  assertRunning(harness, false, "agent_settled clears running");
  assert.equal(harness.snapshot.phase, null, "settled clears phase");
  assert.equal(harness.snapshot.stream.isStreaming, false, "settled clears stream");
  assert.equal(harness.snapshot.completedAssistantCount, 1, "message_end counted");
  assert.equal(harness.snapshot.failure, null, "happy path has no failure");
  assertTypesIncludeInOrder(
    harness.deliveredTypes,
    ["agent_start", "message_update", "message_end", "agent_end", "agent_settled"],
    "happy path order",
  );
  // Latest streamed text flushed before message_end barrier
  const updates = harness.deliveredEvents.filter((e) => e.type === "message_update");
  assert.ok(updates.length >= 1, "at least one update delivered");
  const lastUpdate = updates[updates.length - 1];
  const text = (lastUpdate.message as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  assert.equal(text, "Hello", "barrier flushes latest text before message_end");
}

/** 2) Tool start/end must not leapfrog pending text (throttler barrier). */
function checkToolOrderingWithPendingText(): void {
  let now = 1_000;
  const harness = new ChatPromptLifecycleHarness({ throttleMs: 50, now: () => now });
  harness.attachListener();
  harness.beginPrompt();
  harness.push({ type: "agent_start" });
  harness.push(messageUpdate("before-tool-a"));
  now += 1;
  harness.push(messageUpdate("before-tool-b"));
  // Still inside throttle window — pending text must flush before tool_start.
  harness.push(toolStart("t1", "read"));
  assert.deepEqual(
    harness.deliveredTypes,
    ["agent_start", "message_update", "message_update", "tool_execution_start"],
    "pending text flushes before tool_start",
  );
  assert.equal(harness.snapshot.stream.assistantText, "before-tool-b", "latest text visible before tool");
  assert.equal(harness.snapshot.phase?.kind, "running_tools", "phase becomes running_tools");
  assert.deepEqual(
    harness.snapshot.phase?.kind === "running_tools" ? harness.snapshot.phase.tools : [],
    [{ id: "t1", name: "read" }],
  );

  // Without an intervening message_update, tool_end returns waiting_model (hook contract).
  harness.push(toolEnd("t1"));
  assert.equal(harness.snapshot.phase?.kind, "waiting_model", "tool end returns waiting_model");

  harness.push(messageUpdate("after-tool"));
  harness.push(messageEnd("after-tool"));
  harness.push({ type: "agent_end" });
  harness.push({ type: "agent_settled" });
  assertRunning(harness, false, "tool path settles");
  assertTypesIncludeInOrder(
    harness.deliveredTypes,
    [
      "tool_execution_start",
      "tool_execution_end",
      "message_update",
      "message_end",
      "agent_settled",
    ],
    "tool interleaved order",
  );

  // message_update clears phase (same as useAgentSession); subsequent tool_end is a no-op on phase.
  const mid = new ChatPromptLifecycleHarness({ throttleMs: 0 });
  mid.attachListener();
  mid.beginPrompt();
  mid.push({ type: "agent_start" });
  mid.push(toolStart("t2", "bash"));
  assert.equal(mid.snapshot.phase?.kind, "running_tools");
  mid.push(messageUpdate("stream-during-tools"));
  assert.equal(mid.snapshot.phase, null, "message_update clears tool phase like the hook");
  mid.push(toolEnd("t2"));
  assert.equal(mid.snapshot.phase, null, "tool_end does not invent phase after message_update cleared it");
  mid.push({ type: "agent_settled" });
  assertRunning(mid, false, "still settles after tool+stream mix");
}

/** 3) Retry: agent_end(willRetry) + auto_retry keep busy until settled. */
function checkRetryKeepsRunning(): void {
  const harness = new ChatPromptLifecycleHarness({
    throttleMs: 10,
    context: { provider: "openai", model: "gpt-test" },
  });
  harness.attachListener();
  harness.beginPrompt();
  harness.push({ type: "agent_start" });
  harness.push(messageUpdate("try-1"));
  harness.push(messageEnd("try-1", {
    stopReason: "error",
    errorMessage: "rate limited",
    provider: "openai",
    model: "gpt-test",
  }));
  assert.ok(harness.snapshot.pendingFailure, "assistant error stashes pending failure");
  harness.push({ type: "agent_end", willRetry: true });
  assertRunning(harness, true, "willRetry agent_end keeps running");

  harness.push({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    errorMessage: "rate limited",
  });
  assertRunning(harness, true, "auto_retry_start keeps running");
  assert.equal(harness.snapshot.failure, null, "retry start clears visible failure card");
  assert.equal(harness.snapshot.retryInfo?.attempt, 1, "retry info visible");

  // Successful retry turn
  harness.push({ type: "agent_start" });
  harness.push(messageUpdate("try-2-ok"));
  harness.push(messageEnd("try-2-ok"));
  harness.push({ type: "auto_retry_end", success: true, attempt: 1 });
  assert.equal(harness.snapshot.pendingFailure, null, "successful retry clears pending failure");
  assert.equal(harness.snapshot.retryInfo, null, "retry end clears retry info");
  harness.push({ type: "agent_end" });
  assertRunning(harness, true, "post-retry agent_end still not terminal");
  harness.push({ type: "agent_settled" });
  assertRunning(harness, false, "settled after successful retry");
  assert.equal(harness.snapshot.failure, null, "no failure after successful retry");
}

/** 4) Final retry failure + prompt_error settle correctly. */
function checkFinalFailureAndPromptError(): void {
  {
    const harness = new ChatPromptLifecycleHarness({
      context: { provider: "openai", model: "gpt-test" },
    });
    harness.attachListener();
    harness.beginPrompt();
    harness.push({ type: "agent_start" });
    harness.push(messageEnd("", {
      stopReason: "error",
      errorMessage: "quota exceeded",
      provider: "openai",
      model: "gpt-test",
    }));
    harness.push({ type: "agent_end", willRetry: true });
    harness.push({
      type: "auto_retry_start",
      attempt: 3,
      maxAttempts: 3,
      errorMessage: "quota exceeded",
    });
    harness.push({
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "quota exceeded",
    });
    assert.ok(harness.snapshot.failure, "final retry failure surfaces failure");
    assert.match(harness.snapshot.failure!.errorMessage, /quota exceeded/);
    assert.equal(harness.snapshot.failure!.retryAttempts, 3);
    // Still running until agent_settled (retry end does not settle alone)
    assertRunning(harness, true, "retry end alone does not settle running");
    harness.push({ type: "agent_settled" });
    assertRunning(harness, false, "settled after exhausted retries");
    assert.ok(harness.snapshot.failure, "failure retained after settled");
  }

  {
    const harness = new ChatPromptLifecycleHarness();
    harness.attachListener();
    harness.beginPrompt();
    harness.push({ type: "prompt_error", error: "Model not found: acme/missing" });
    assertRunning(harness, false, "prompt_error settles running");
    assert.ok(harness.snapshot.failure, "prompt_error sets failure");
    assert.match(harness.snapshot.failure!.errorMessage, /Model not found/);
    assert.equal(harness.snapshot.stream.isStreaming, false, "prompt_error clears stream");
  }
}

/** 5) Abort / destroy / buffered events must not leave sticky running. */
function checkAbortDestroyAndBuffer(): void {
  // Abort mid-stream
  {
    const harness = new ChatPromptLifecycleHarness({ throttleMs: 50 });
    harness.attachListener();
    harness.beginPrompt();
    harness.push({ type: "agent_start" });
    harness.push(messageUpdate("partial"));
    harness.abort("user aborted");
    assertRunning(harness, false, "abort clears running");
    assert.ok(harness.snapshot.failure, "abort records failure");
    // Late events after abort still apply only if not destroyed — abort doesn't destroy
    harness.push({ type: "agent_settled" });
    assertRunning(harness, false, "still settled after late agent_settled");
  }

  // Destroy drops pending throttle and forces settle
  {
    let now = 100;
    const harness = new ChatPromptLifecycleHarness({ throttleMs: 50, now: () => now });
    harness.attachListener();
    harness.beginPrompt();
    harness.push({ type: "agent_start" });
    harness.push(messageUpdate("a"));
    now += 1;
    harness.push(messageUpdate("ab")); // pending
    harness.destroy();
    assertRunning(harness, false, "destroy clears running");
    assert.equal(harness.snapshot.destroyed, true, "destroyed flag set");
    // Pending update must not deliver after destroy
    const typesBefore = harness.deliveredTypes.slice();
    harness.flush();
    assert.deepEqual(harness.deliveredTypes, typesBefore, "destroy drops pending throttle");
    harness.push({ type: "agent_start" });
    assert.deepEqual(harness.deliveredTypes, typesBefore, "destroyed harness ignores new events");
    assertRunning(harness, false, "destroyed stays not running");
  }

  // Buffer before listener attach, then replay
  {
    const harness = new ChatPromptLifecycleHarness();
    harness.beginPrompt();
    harness.push({ type: "agent_start" });
    harness.push(messageUpdate("buffered-hello"));
    harness.push(messageEnd("buffered-hello"));
    harness.push({ type: "agent_end" });
    harness.push({ type: "agent_settled" });
    assertRunning(harness, true, "events buffered before attach do not apply yet");
    assert.equal(harness.deliveredTypes.length, 0, "nothing delivered pre-attach");
    harness.attachListener();
    assertRunning(harness, false, "replay settles after attach");
    assertTypesIncludeInOrder(
      harness.deliveredTypes,
      ["agent_start", "message_update", "message_end", "agent_settled"],
      "buffered replay order",
    );
  }
}

/** 6) Slash-command path: prompt_settled without agent lifecycle settles; with lifecycle ignored. */
function checkPromptSettledRules(): void {
  {
    const harness = new ChatPromptLifecycleHarness();
    harness.attachListener();
    harness.beginPrompt();
    // Extension slash command finishes without agent_start
    harness.push({ type: "prompt_settled" });
    assertRunning(harness, false, "non-agent prompt_settled settles");
    assert.equal(harness.snapshot.promptHadAgentLifecycle, false);
  }
  {
    let state = beginLocalPrompt(createInitialChatPromptLifecycleState());
    state = applyChatPromptEvent(state, { type: "agent_start" });
    state = applyChatPromptEvent(state, { type: "prompt_settled" });
    assert.equal(state.agentRunning, true, "prompt_settled ignored after agent lifecycle");
    state = applyChatPromptEvent(state, { type: "agent_settled" });
    assert.equal(state.agentRunning, false, "agent_settled still settles");
  }
  assert.equal(getAgentLifecycleDirective("prompt_settled", true), "ignore");
  assert.equal(getAgentLifecycleDirective("prompt_settled", false), "settle");
  assert.equal(getAgentLifecycleDirective("agent_end", true), "keep-running");
}

/** 7) Compaction during a turn does not settle the prompt by itself. */
function checkCompactionDoesNotSettle(): void {
  const harness = new ChatPromptLifecycleHarness();
  harness.attachListener();
  harness.beginPrompt();
  harness.push({ type: "agent_start" });
  harness.push({ type: "auto_compaction_start" });
  assert.equal(harness.snapshot.isCompacting, true);
  assertRunning(harness, true, "compaction keeps running");
  harness.push({ type: "auto_compaction_end" });
  assert.equal(harness.snapshot.isCompacting, false);
  assertRunning(harness, true, "compaction end still running");
  harness.push({ type: "agent_settled" });
  assertRunning(harness, false, "settled after compaction path");
}

/** 8) Follow-up queue snapshots stay separate from the persisted chat timeline. */
function checkFollowUpQueueProjection(): void {
  assert.deepEqual(
    normalizeFollowUpQueue(["first", 2, null, "second"]),
    ["first", "second"],
    "queue snapshots keep string messages only",
  );
  assert.deepEqual(
    removedFollowUpItems(["same", "same", "last"], ["same"]),
    ["same", "last"],
    "queue removal preserves duplicate counts and delivery order",
  );
  assert.equal(
    agentMessageText({ role: "user", content: "plain", timestamp: 1 }),
    "plain",
    "plain user message text is readable",
  );
  assert.equal(
    agentMessageText({
      role: "user",
      content: [
        { type: "text", text: "queued" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
      ],
      timestamp: 1,
    }),
    "queued",
    "attachment messages correlate by their text content",
  );
  assert.equal(
    canSubmitQueuedMessage({ agentRunning: true, writeLocked: false, sessionId: null }),
    false,
    "new-session queue actions stay unavailable until the real session id exists",
  );
  assert.equal(
    canSubmitQueuedMessage({ agentRunning: true, writeLocked: false, sessionId: "session-ready" }),
    true,
    "running persisted sessions accept queued messages",
  );
  assert.equal(
    canSubmitQueuedMessage({ agentRunning: true, writeLocked: true, sessionId: "session-ready" }),
    false,
    "read-only tabs cannot submit queued messages",
  );
}

/** Source contract: useAgentSession must still settle on agent_settled, not bare agent_end. */
function checkHookSourceContract(): void {
  const source = readFileSync(join(ROOT, "hooks", "useAgentSession.ts"), "utf8");
  assert.match(source, /case "agent_settled":/, "hook handles agent_settled");
  assert.match(
    source,
    /only agent_settled is terminal for the prompt/,
    "hook documents agent_end non-terminal contract",
  );
  assert.match(source, /getAgentLifecycleDirective/, "hook uses shared lifecycle directive");
  assert.match(source, /case "auto_retry_start":/, "hook handles auto_retry_start");
  assert.match(source, /case "auto_retry_end":/, "hook handles auto_retry_end");
  assert.match(source, /case "prompt_error":/, "hook handles prompt_error");
  assert.match(source, /willRetry === true/, "hook keeps running on willRetry");
  assert.match(source, /case "queue_update":/, "hook consumes authoritative queue snapshots");
  assert.match(source, /pendingFollowUps, followUpError/, "hook exposes the separate follow-up queue state");

  const followUpBlock = source.match(/const handleFollowUp = useCallback\([\s\S]*?\n  }, \[\]\);/);
  assert.ok(followUpBlock, "hook defines follow-up submission");
  assert.ok(
    !followUpBlock![0].includes("setMessages"),
    "queue submission must not append an optimistic user message",
  );

  // agent_end case must not setAgentRunning(false)
  const agentEndBlock = source.match(/case "agent_end":([\s\S]*?)case "agent_settled":/);
  assert.ok(agentEndBlock, "agent_end block precedes agent_settled");
  assert.ok(
    !agentEndBlock![1].includes("setAgentRunning(false)"),
    "agent_end must not clear agentRunning",
  );

  const inputSource = readFileSync(join(ROOT, "components", "ChatInput.tsx"), "utf8");
  assert.match(
    inputSource,
    /if \(accepted !== false\) clearEditor\(\)/,
    "Composer clears queued input only after server acceptance",
  );

  const windowSource = readFileSync(join(ROOT, "components", "ChatWindow.tsx"), "utf8");
  assert.match(
    windowSource,
    /canSubmitQueuedMessage\(/,
    "ChatWindow gates queue actions on the real session id",
  );

  const rpc = readFileSync(join(ROOT, "lib", "rpc-manager.ts"), "utf8");
  assert.match(rpc, /AgentEventThrottler/, "rpc-manager throttles agent events");
  assert.match(rpc, /followUpMessages: \[\.\.\.this\.inner\.getFollowUpMessages\(\)\]/, "live state exposes reconnect queue snapshot");
  assert.match(rpc, /type: "prompt_settled"/, "rpc-manager emits prompt_settled for slash commands");
  assert.match(rpc, /type: "prompt_error"/, "rpc-manager emits prompt_error on prompt failure");
}

/** Pure unit edges for forceSettle / beginLocal. */
function checkPureHelpers(): void {
  let state = createInitialChatPromptLifecycleState();
  state = beginLocalPrompt(state);
  assert.equal(state.agentRunning, true);
  assert.equal(state.promptHadAgentLifecycle, false);
  state = forceSettlePrompt(state, {
    errorMessage: "boom",
    retryAttempts: 0,
    technicalDetails: "boom",
  });
  assert.equal(state.agentRunning, false);
  assert.equal(state.failure?.errorMessage, "boom");
}

function main(): void {
  checkHappyPath();
  checkToolOrderingWithPendingText();
  checkRetryKeepsRunning();
  checkFinalFailureAndPromptError();
  checkAbortDestroyAndBuffer();
  checkPromptSettledRules();
  checkCompactionDoesNotSettle();
  checkFollowUpQueueProjection();
  checkHookSourceContract();
  checkPureHelpers();
  console.log("chat lifecycle integration smoke checks passed");
}

main();
