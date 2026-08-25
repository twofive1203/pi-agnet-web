/**
 * Smoke checks for display-transcript projection and turn-aware pagination.
 * Run: npm run test:session-transcript
 *
 * Model context (Pi buildSessionContext) stays compaction-aware. The display
 * transcript must keep every current-branch message and never treat a
 * compaction summary as a user row.
 *
 * Dynamic imports keep this script off tsx's CJS loader for the ESM-only SDK.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, SessionEntry } from "../lib/types";
import {
  TRANSCRIPT_BRANCH_SUMMARY_CUSTOM_TYPE,
  TRANSCRIPT_COMPACTION_CUSTOM_TYPE,
} from "../lib/types";
import { getSessionBillingStats } from "../lib/session-billing-stats";
import { readSessionHeaderLine } from "../lib/session-reader-header";

const TS = "2026-08-24T12:00:00.000Z";
const TS_MS = Date.parse(TS);

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

function userMessage(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TS,
    message: { role: "user", content: text, timestamp: TS_MS },
  };
}

function assistantMessage(
  id: string,
  parentId: string | null,
  text: string,
  content?: AssistantMessage["content"],
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TS,
    message: {
      role: "assistant",
      content: content ?? [{ type: "text", text }],
      model: "test-model",
      provider: "test",
      timestamp: TS_MS,
    },
  };
}

function toolResultMessage(id: string, parentId: string | null, toolCallId: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TS,
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "bash",
      content: [{ type: "text", text }],
      timestamp: TS_MS,
    },
  };
}

function compactionEntry(
  id: string,
  parentId: string | null,
  firstKeptEntryId: string,
  summary: string,
): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: TS,
    summary,
    firstKeptEntryId,
    tokensBefore: 9_000,
  };
}

function idsOf(messages: AgentMessage[], entryIds: string[]): string[] {
  assert.equal(messages.length, entryIds.length, "messages and entryIds must stay parallel");
  return entryIds;
}

function roleSequence(messages: AgentMessage[]): string[] {
  return messages.map((message) => {
    if (message.role === "custom") return `custom:${message.customType}`;
    return message.role;
  });
}

function userTexts(messages: AgentMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
}

function linearTurns(count: number, prefix = "t"): SessionEntry[] {
  const entries: SessionEntry[] = [];
  let parent: string | null = null;
  for (let i = 1; i <= count; i++) {
    const userId = `${prefix}-u${i}`;
    const asstId = `${prefix}-a${i}`;
    entries.push(userMessage(userId, parent, `user ${i}`));
    entries.push(assistantMessage(asstId, userId, `assistant ${i}`));
    parent = asstId;
  }
  return entries;
}

async function main(): Promise<void> {
  const { buildSessionContext: piBuildSessionContext } = await import("@earendil-works/pi-coding-agent");
  const {
    TranscriptCursorError,
    buildSessionTranscriptPage,
    clampTranscriptPageLimit,
    httpStatusForTranscriptError,
    paginateSessionTranscript,
    parseTranscriptSearchParams,
    projectSessionTranscript,
    TRANSCRIPT_DEFAULT_PAGE_LIMIT,
    TRANSCRIPT_MAX_PAGE_LIMIT,
  } = await import("../lib/session-transcript");

  // --- U1.1 linear session: every message projects, entryIds stay aligned ---
  {
    const entries = linearTurns(3);
    const page = buildSessionTranscriptPage(entries);
    assert.deepEqual(roleSequence(page.messages), [
      "user", "assistant", "user", "assistant", "user", "assistant",
    ]);
    assert.deepEqual(idsOf(page.messages, page.entryIds), [
      "t-u1", "t-a1", "t-u2", "t-a2", "t-u3", "t-a3",
    ]);
    assert.equal(page.messageCount, 6);
    assert.equal(page.firstMessage, "user 1");
    assert.equal(page.hasMoreBefore, false);
    assert.equal(page.nextBeforeEntryId, null);
    assert.equal(page.leafId, "t-a3");
  }

  // --- U1.2 single compaction: older messages remain; marker once; model context omits them ---
  {
    const entries: SessionEntry[] = [
      userMessage("u1", null, "before compact 1"),
      assistantMessage("a1", "u1", "before answer 1"),
      userMessage("u2", "a1", "before compact 2"),
      assistantMessage("a2", "u2", "before answer 2"),
      compactionEntry("c1", "a2", "u2", "kept recent turns"),
      userMessage("u3", "c1", "after compact"),
      assistantMessage("a3", "u3", "after answer"),
    ];

    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const model = piBuildSessionContext(entries as never, "a3", byId as never);
    const modelRoles = (model.messages as Array<{ role?: string; content?: unknown; summary?: unknown }>);
    assert.ok(
      modelRoles.some((message) => message.role === "compactionSummary"),
      "Pi model context still injects a compactionSummary for the LLM",
    );
    assert.equal(
      modelRoles.filter((message) => message.role === "user" || message.role === "assistant").length < 6,
      true,
      "model context must omit pre-compaction history",
    );
    assert.equal(
      modelRoles.some((message) => message.role === "user" && message.content === "before compact 1"),
      false,
    );

    const projection = projectSessionTranscript(entries, "a3");
    assert.deepEqual(roleSequence(projection.rows.map((row) => row.message)), [
      "user", "assistant", "user", "assistant", `custom:${TRANSCRIPT_COMPACTION_CUSTOM_TYPE}`, "user", "assistant",
    ]);
    assert.deepEqual(projection.rows.map((row) => row.entryId), [
      "u1", "a1", "u2", "a2", "c1", "u3", "a3",
    ]);
    const marker = projection.rows.find((row) => row.entryId === "c1")?.message;
    assert.ok(marker && marker.role === "custom");
    assert.equal(marker.customType, TRANSCRIPT_COMPACTION_CUSTOM_TYPE);
    assert.equal(marker.display, false);
    assert.equal(marker.content, "kept recent turns");
    assert.equal(projection.rows.filter((row) => row.message.role === "custom").length, 1);
    assert.equal(projection.messageCount, 6);
    assert.equal(projection.firstMessage, "before compact 1");

    const recent = paginateSessionTranscript(projection, { limit: 3 });
    assert.equal(recent.hasMoreBefore, true);
    assert.ok(recent.nextBeforeEntryId);
    assert.equal(userTexts(recent.messages).includes("before compact 1"), false);
    assert.ok(userTexts(recent.messages).includes("after compact"));

    const older = paginateSessionTranscript(projection, {
      beforeEntryId: recent.nextBeforeEntryId,
      limit: 20,
    });
    assert.ok(userTexts(older.messages).includes("before compact 1"));
    assert.equal(userTexts(older.messages).includes("after compact"), false);
    assert.equal(
      older.messages.filter((message) => message.role === "custom" && message.customType === TRANSCRIPT_COMPACTION_CUSTOM_TYPE).length
        + recent.messages.filter((message) => message.role === "custom" && message.customType === TRANSCRIPT_COMPACTION_CUSTOM_TYPE).length,
      1,
      "compaction marker appears on exactly one page",
    );
  }

  // --- U1.3 multiple compactons: each marker once, no missing/duplicate originals ---
  {
    const entries: SessionEntry[] = [
      userMessage("u1", null, "one"),
      assistantMessage("a1", "u1", "a-one"),
      compactionEntry("c1", "a1", "u1", "sum-1"),
      userMessage("u2", "c1", "two"),
      assistantMessage("a2", "u2", "a-two"),
      compactionEntry("c2", "a2", "u2", "sum-2"),
      userMessage("u3", "c2", "three"),
      assistantMessage("a3", "u3", "a-three"),
    ];
    const projection = projectSessionTranscript(entries);
    const customTypes = projection.rows
      .filter((row) => row.message.role === "custom")
      .map((row) => [row.entryId, row.message.role === "custom" ? row.message.content : ""]);
    assert.deepEqual(customTypes, [
      ["c1", "sum-1"],
      ["c2", "sum-2"],
    ]);
    assert.deepEqual(
      projection.rows.filter((row) => row.message.role !== "custom").map((row) => row.entryId),
      ["u1", "a1", "u2", "a2", "u3", "a3"],
    );
    assert.equal(projection.messageCount, 6);
  }

  // --- U1.4 branches stay isolated ---
  {
    const entries: SessionEntry[] = [
      userMessage("root", null, "shared"),
      assistantMessage("leaf-a", "root", "branch a"),
      assistantMessage("leaf-b", "root", "branch b"),
    ];
    const pageA = buildSessionTranscriptPage(entries, { leafId: "leaf-a" });
    const pageB = buildSessionTranscriptPage(entries, { leafId: "leaf-b" });
    assert.deepEqual(pageA.entryIds, ["root", "leaf-a"]);
    assert.deepEqual(pageB.entryIds, ["root", "leaf-b"]);
    assert.equal(pageA.messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("branch b")), false);
    assert.equal(pageB.messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("branch a")), false);
  }

  // --- U1.5 custom_message + visual evidence stay on current display policy ---
  {
    const entries: SessionEntry[] = [
      userMessage("u1", null, "plain\n\n<pi-web-visual-evidence trust=\"untrusted\" provider=\"p\" model=\"m\">\nsecret pixels\n</pi-web-visual-evidence>"),
      {
        type: "custom_message",
        id: "cm1",
        parentId: "u1",
        timestamp: TS,
        customType: "extension.note",
        content: "shown note",
        display: true,
        details: { source: "ext" },
      },
      {
        type: "custom_message",
        id: "cm2",
        parentId: "cm1",
        timestamp: TS,
        customType: "extension.hidden",
        content: "hidden note",
        display: false,
      },
      {
        type: "branch_summary",
        id: "bs1",
        parentId: "cm2",
        timestamp: TS,
        fromId: "cm2",
        summary: "abandoned side branch",
      },
      assistantMessage("a1", "bs1", "ok"),
    ];
    const projection = projectSessionTranscript(entries);
    const user = projection.rows[0]?.message;
    assert.ok(user && user.role === "user");
    assert.equal(user.content, "plain");
    const shown = projection.rows.find((row) => row.entryId === "cm1")?.message;
    assert.ok(shown && shown.role === "custom");
    assert.equal(shown.customType, "extension.note");
    assert.equal(shown.display, true);
    assert.equal(shown.content, "shown note");
    const hidden = projection.rows.find((row) => row.entryId === "cm2")?.message;
    assert.ok(hidden && hidden.role === "custom");
    assert.equal(hidden.display, false);
    const branch = projection.rows.find((row) => row.entryId === "bs1")?.message;
    assert.ok(branch && branch.role === "custom");
    assert.equal(branch.customType, TRANSCRIPT_BRANCH_SUMMARY_CUSTOM_TYPE);
    assert.equal(branch.display, false);
    assert.equal(branch.content, "abandoned side branch");
    assert.equal(projection.firstMessage, "plain");
    assert.equal(projection.messageCount, 2, "custom/branch markers are not raw message entries");
  }

  // --- U1.6 turn boundary: toolCall + toolResult stay on the same page ---
  {
    const entries: SessionEntry[] = [
      ...linearTurns(4, "early"),
      userMessage("tool-u", "early-a4", "run tool"),
      assistantMessage("tool-a", "tool-u", "calling", [
        { type: "text", text: "calling" },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } } as never,
      ]),
      toolResultMessage("tool-r", "tool-a", "call-1", "ok"),
      assistantMessage("tool-a2", "tool-r", "done"),
    ];
    const projection = projectSessionTranscript(entries);
    const page = paginateSessionTranscript(projection, { limit: 3 });
    const assistant = page.messages.find((message) => message.role === "assistant");
    assert.ok(assistant && assistant.role === "assistant");
    const toolCall = assistant.content.find((block) => block.type === "toolCall");
    assert.ok(toolCall && toolCall.type === "toolCall");
    assert.equal(toolCall.toolCallId, "call-1");
    assert.equal(toolCall.toolName, "bash");
    assert.deepEqual(toolCall.input, { command: "ls" });
    assert.ok(page.messages.some((message) => message.role === "toolResult" && message.toolCallId === "call-1"));
    assert.ok(page.entryIds.includes("tool-a"));
    assert.ok(page.entryIds.includes("tool-r"));
    assert.ok(page.entryIds.includes("tool-a2"));
    assert.equal(page.entryIds.includes("tool-u"), true);
  }

  // --- U1.7 cursors: contiguous pages, illegal leaf/cursor fail closed ---
  {
    const entries = linearTurns(8);
    const projection = projectSessionTranscript(entries);
    const first = paginateSessionTranscript(projection, { limit: 4 });
    assert.equal(first.messages.length, 4);
    assert.equal(first.hasMoreBefore, true);
    assert.equal(first.nextBeforeEntryId, "t-u7");
    const second = paginateSessionTranscript(projection, { beforeEntryId: first.nextBeforeEntryId, limit: 4 });
    assert.deepEqual(second.entryIds, ["t-u5", "t-a5", "t-u6", "t-a6"]);
    const third = paginateSessionTranscript(projection, { beforeEntryId: second.nextBeforeEntryId, limit: 4 });
    assert.deepEqual(third.entryIds, ["t-u3", "t-a3", "t-u4", "t-a4"]);
    const fourth = paginateSessionTranscript(projection, { beforeEntryId: third.nextBeforeEntryId, limit: 4 });
    assert.deepEqual(fourth.entryIds, ["t-u1", "t-a1", "t-u2", "t-a2"]);
    assert.equal(fourth.hasMoreBefore, false);
    const seen = [...fourth.entryIds, ...third.entryIds, ...second.entryIds, ...first.entryIds];
    assert.deepEqual(seen, projection.rows.map((row) => row.entryId));
    assert.equal(new Set(seen).size, seen.length);

    assert.throws(
      () => buildSessionTranscriptPage(entries, { leafId: "missing-leaf" }),
      (error: unknown) => error instanceof TranscriptCursorError && error.code === "unknown_leaf",
    );
    assert.throws(
      () => paginateSessionTranscript(projection, { beforeEntryId: "missing-cursor" }),
      (error: unknown) => error instanceof TranscriptCursorError && error.code === "unknown_cursor",
    );
    assert.throws(
      () => paginateSessionTranscript(projection, { beforeEntryId: "t-a8" }),
      (error: unknown) => error instanceof TranscriptCursorError && error.code === "cursor_not_page_boundary",
    );
    const otherBranch: SessionEntry[] = [
      ...entries,
      assistantMessage("sibling", "t-u1", "other"),
    ];
    const main = projectSessionTranscript(otherBranch, "t-a8");
    assert.throws(
      () => paginateSessionTranscript(main, { beforeEntryId: "sibling" }),
      (error: unknown) => error instanceof TranscriptCursorError && error.code === "cursor_not_on_leaf",
    );
  }

  // --- U1.8 oversized turn returns whole turn, no infinite loop ---
  {
    const entries: SessionEntry[] = [
      userMessage("small-u", null, "small"),
      assistantMessage("small-a", "small-u", "small-a"),
      userMessage("big-u", "small-a", "big"),
    ];
    let parent = "big-u";
    for (let i = 1; i <= 12; i++) {
      const id = `big-a${i}`;
      entries.push(assistantMessage(id, parent, `chunk ${i}`));
      parent = id;
    }
    const page = buildSessionTranscriptPage(entries, { limit: 4 });
    assert.ok(page.messages.length >= 13, "oversized turn must not be sliced");
    assert.equal(page.entryIds[0], "big-u");
    assert.ok(page.entryIds.includes("big-a12"));
    assert.equal(page.hasMoreBefore, true);
    const older = buildSessionTranscriptPage(entries, { beforeEntryId: page.nextBeforeEntryId, limit: 4 });
    assert.deepEqual(older.entryIds, ["small-u", "small-a"]);
  }

  // --- U1.9 metadata ignores synthetic markers ---
  {
    const entries: SessionEntry[] = [
      {
        type: "model_change",
        id: "mc1",
        parentId: null,
        timestamp: TS,
        provider: "test",
        modelId: "kept-model",
      },
      {
        type: "thinking_level_change",
        id: "tl1",
        parentId: "mc1",
        timestamp: TS,
        thinkingLevel: "high",
      },
      userMessage("u1", "tl1", "real first"),
      assistantMessage("a1", "u1", "ok"),
      compactionEntry("c1", "a1", "u1", "do not use as firstMessage"),
      {
        type: "session_info",
        id: "si1",
        parentId: "c1",
        timestamp: TS,
        name: "named",
      },
      {
        type: "label",
        id: "lb1",
        parentId: "si1",
        timestamp: TS,
        targetId: "u1",
        label: "note",
      },
      {
        type: "custom",
        id: "cu1",
        parentId: "lb1",
        timestamp: TS,
        customType: "state-only",
        data: { ignored: true },
      },
    ];
    const projection = projectSessionTranscript(entries);
    assert.equal(projection.firstMessage, "real first");
    assert.equal(projection.messageCount, 2);
    assert.deepEqual(projection.contextState, {
      thinkingLevel: "high",
      model: { provider: "test", modelId: "test-model" },
    });
    assert.equal(projection.rows.some((row) => row.entryId === "mc1" || row.entryId === "si1" || row.entryId === "cu1"), false);
  }

  assert.equal(clampTranscriptPageLimit(undefined), TRANSCRIPT_DEFAULT_PAGE_LIMIT);
  assert.equal(clampTranscriptPageLimit(0), TRANSCRIPT_DEFAULT_PAGE_LIMIT);
  assert.equal(clampTranscriptPageLimit(999), TRANSCRIPT_MAX_PAGE_LIMIT);
  assert.equal(TRANSCRIPT_DEFAULT_PAGE_LIMIT, 100);
  assert.equal(TRANSCRIPT_MAX_PAGE_LIMIT, 200);

  // --- U2 query / error contract ---
  {
    const parsed = parseTranscriptSearchParams(new URLSearchParams("leafId=leaf-1&beforeEntryId=u3&limit=12"));
    assert.deepEqual(parsed, { leafId: "leaf-1", beforeEntryId: "u3", limit: 12 });
    assert.deepEqual(parseTranscriptSearchParams(new URLSearchParams("limit=nope")), { limit: undefined });
    assert.deepEqual(httpStatusForTranscriptError(new TranscriptCursorError("unknown_leaf")), {
      status: 400,
      error: "unknown_leaf",
    });
    assert.deepEqual(httpStatusForTranscriptError(new TranscriptCursorError("cursor_not_on_leaf")), {
      status: 400,
      error: "cursor_not_on_leaf",
    });
    assert.equal(httpStatusForTranscriptError(new Error("boom")).status, 500);
  }

  // --- U2 SessionManager fixture: chat page + walk to first message + live/disk parity ---
  {
    const root = mkdtempSync(join(tmpdir(), "pi-web-transcript-"));
    try {
      const sessionId = "11111111-1111-4111-8111-111111111111";
      const filePath = join(root, `2026-08-24T00-00-00-000Z_${sessionId}.jsonl`);
      const fixtureEntries: SessionEntry[] = [
        userMessage("u1", null, "first real user"),
        assistantMessage("a1", "u1", "old answer"),
        userMessage("u2", "a1", "kept user"),
        assistantMessage("a2", "u2", "kept answer"),
        compactionEntry("c1", "a2", "u2", "compacted earlier turns"),
        userMessage("u3", "c1", "after compact"),
        assistantMessage("a3", "u3", "after answer"),
      ];
      const header = {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: TS,
        cwd: root,
      };
      writeFileSync(
        filePath,
        [header, ...fixtureEntries].map((line) => JSON.stringify(line)).join("\n") + "\n",
      );
      assert.equal(readSessionHeaderLine(filePath)?.id, sessionId);
      writeFileSync(join(root, "broken.jsonl"), "not-json\n");
      assert.equal(readSessionHeaderLine(join(root, "broken.jsonl")), null);
      writeFileSync(
        join(root, "mismatch.jsonl"),
        `${JSON.stringify({ type: "session", id: "other-id", timestamp: TS, cwd: root })}\n`,
      );
      assert.notEqual(readSessionHeaderLine(join(root, "mismatch.jsonl"))?.id, sessionId);

      const { SessionManager } = await import("@earendil-works/pi-coding-agent");
      const diskManager = SessionManager.open(filePath);
      const liveManager = SessionManager.open(filePath);
      const diskEntries = diskManager.getEntries() as unknown as SessionEntry[];
      const liveEntries = liveManager.getEntries() as unknown as SessionEntry[];
      const diskPage = buildSessionTranscriptPage(diskEntries, { leafId: diskManager.getLeafId(), limit: 3 });
      const livePage = buildSessionTranscriptPage(liveEntries, { leafId: liveManager.getLeafId(), limit: 3 });
      assert.deepEqual(livePage, diskPage);
      assert.equal(diskPage.hasMoreBefore, true);
      assert.ok(diskPage.messages.some((message) => message.role === "custom" && message.customType === TRANSCRIPT_COMPACTION_CUSTOM_TYPE)
        || diskPage.messages.some((message) => message.role === "user" && message.content === "after compact"));
      assert.equal(diskPage.messageCount, 6);
      assert.equal(diskPage.firstMessage, "first real user");

      const collected: string[] = [...diskPage.entryIds];
      let cursor = diskPage.nextBeforeEntryId;
      let guard = 0;
      while (cursor && guard < 20) {
        const older = buildSessionTranscriptPage(diskEntries, {
          leafId: diskManager.getLeafId(),
          beforeEntryId: cursor,
          limit: 3,
        });
        collected.unshift(...older.entryIds);
        cursor = older.nextBeforeEntryId;
        guard += 1;
      }
      assert.equal(collected[0], "u1");
      assert.ok(collected.includes("c1"));
      assert.equal(new Set(collected).size, collected.length);

      const stats = getSessionBillingStats(diskEntries);
      assert.deepEqual(stats.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      assert.equal(stats.cost, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- U3 client merge / isolation / scroll restore ---
  {
    const {
      isStaleTranscriptResponse,
      mergeTranscriptTail,
      prependTranscriptPage,
      replaceTranscriptPage,
      restoreScrollAfterPrepend,
    } = await import("../lib/session-transcript-client");

    const older = buildSessionTranscriptPage(linearTurns(6), { beforeEntryId: "t-u5", limit: 4 });
    const recent = buildSessionTranscriptPage(linearTurns(6), { limit: 4 });
    const replaced = replaceTranscriptPage(recent);
    const prepended = prependTranscriptPage(replaced, older);
    assert.deepEqual(prepended.entryIds, ["t-u3", "t-a3", "t-u4", "t-a4", "t-u5", "t-a5", "t-u6", "t-a6"]);
    const prependedAgain = prependTranscriptPage(prepended, older);
    assert.deepEqual(prependedAgain.entryIds, prepended.entryIds);

    const withOptimistic: typeof prepended = {
      ...prepended,
      messages: [...prepended.messages, { role: "user", content: "user 7", timestamp: TS_MS }],
      entryIds: [...prepended.entryIds, ""],
    };
    const refreshed = buildSessionTranscriptPage([
      ...linearTurns(6),
      userMessage("t-u7", "t-a6", "user 7"),
      assistantMessage("t-a7", "t-u7", "assistant 7"),
    ], { limit: 4 });
    const merged = mergeTranscriptTail(withOptimistic, refreshed);
    assert.deepEqual(merged.entryIds, ["t-u3", "t-a3", "t-u4", "t-a4", "t-u5", "t-a5", "t-u6", "t-a6", "t-u7", "t-a7"]);
    assert.equal(merged.messages.filter((message) => message.role === "user" && message.content === "user 7").length, 1);

    const compactedLatest = buildSessionTranscriptPage([
      userMessage("u1", null, "one"),
      assistantMessage("a1", "u1", "a-one"),
      userMessage("u2", "a1", "two"),
      assistantMessage("a2", "u2", "a-two"),
      compactionEntry("c1", "a2", "u2", "sum"),
      userMessage("u3", "c1", "three"),
      assistantMessage("a3", "u3", "a-three"),
    ], { limit: 20 });
    const afterCompact = mergeTranscriptTail(replaceTranscriptPage({
      messages: [
        { role: "user", content: "one", timestamp: TS_MS },
        { role: "assistant", content: [{ type: "text", text: "a-one" }], model: "test-model", provider: "test", timestamp: TS_MS },
      ],
      entryIds: ["u1", "a1"],
      leafId: "a1",
      hasMoreBefore: false,
      nextBeforeEntryId: null,
      messageCount: 2,
      firstMessage: "one",
    }), compactedLatest);
    assert.ok(afterCompact.entryIds.includes("u1"));
    assert.equal(afterCompact.entryIds.filter((id) => id === "c1").length, 1);
    assert.ok(afterCompact.entryIds.includes("u3"));

    assert.equal(isStaleTranscriptResponse({
      requestSessionId: "a",
      currentSessionId: "b",
      requestLeafId: "l",
      currentLeafId: "l",
      requestSeq: 1,
      currentSeq: 1,
    }), true);
    assert.equal(isStaleTranscriptResponse({
      requestSessionId: "a",
      currentSessionId: "a",
      requestLeafId: "old",
      currentLeafId: "new",
      requestSeq: 2,
      currentSeq: 2,
    }), true);
    assert.equal(isStaleTranscriptResponse({
      requestSessionId: "a",
      currentSessionId: "a",
      requestLeafId: "l",
      currentLeafId: "l",
      requestSeq: 1,
      currentSeq: 2,
    }), true);
    assert.equal(isStaleTranscriptResponse({
      requestSessionId: "a",
      currentSessionId: "a",
      requestLeafId: "l",
      currentLeafId: "l",
      requestSeq: 3,
      currentSeq: 3,
    }), false);
    assert.equal(restoreScrollAfterPrepend({ scrollHeight: 800, scrollTop: 120 }, 1400), 720);
  }

  console.log("Session transcript smoke checks passed.");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
