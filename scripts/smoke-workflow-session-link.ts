#!/usr/bin/env npx tsx
/**
 * Focused smoke checks for session-scoped SnFlow task resolution.
 *
 * Covers:
 * - pointer.sessionId match shows task in matching session
 * - pointer.sessionId mismatch shows nothing
 * - CLI pointer (no sessionId) with no transcript evidence shows nothing
 * - Transcript evidence finds the task when CLI pointer has no sessionId
 * - Blank/new session with no evidence shows nothing
 * - Archived tasks are not surfaced
 * - Project isolation (project A/B)
 * - Single-character legal task ids
 *
 * Run: npx tsx scripts/smoke-workflow-session-link.ts
 */

import { createHash } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createWorkflowTask,
  getWorkflowTaskDetail,
  archiveWorkflowTask,
  updateWorkflowTaskProjection,
  completeWorkflowTask,
} from "../lib/workflow-store";
import { resolveWorkflowTaskForSession } from "../lib/workflow-session-link";
import type { SessionEntry } from "../lib/types";

let failures = 0;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failures++;
  }
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    console.error(`FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failures++;
  }
}

function makeSessionEntry(text: string): SessionEntry {
  return {
    type: "message" as const,
    id: `entry-${createHash("sha256").update(text).digest("hex").slice(0, 8)}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text },
      ],
      model: "test-model",
      provider: "test-provider",
    },
  };
}

function main(): void {
  const projectA = mkdtempSync(path.join(tmpdir(), "wf-session-a-"));
  const projectB = mkdtempSync(path.join(tmpdir(), "wf-session-b-"));

  try {
    // Create a task in projectA with a known session id
    const sessionIdA = "session-a-1234";
    const taskA = createWorkflowTask(projectA, {
      title: "Session A Task",
      priority: "P1",
      sessionId: sessionIdA,
    });

    // At this point, current.json has pointer with sessionId = sessionIdA
    // Test 1: Matching sessionId resolves correctly
    const matchingResult = resolveWorkflowTaskForSession(projectA, sessionIdA, []);
    assert(matchingResult.task !== null, "matching sessionId finds task");
    assert(matchingResult.source === "pointer", "matching sessionId uses pointer source");
    assertEqual(matchingResult.task?.id, taskA.id, "matching sessionId returns correct task id");

    // Test 2: Non-matching sessionId with no evidence returns nothing
    const noMatchResult = resolveWorkflowTaskForSession(projectA, "session-other", []);
    assert(noMatchResult.task === null, "non-matching sessionId without evidence returns null");
    assertEqual(noMatchResult.reason, "no-evidence", "no evidence reason");

    // Test 3: CLI pointer (no sessionId) — simulate by creating a task without sessionId
    const taskCli = createWorkflowTask(projectB, {
      title: "CLI Created Task",
      priority: "P2",
    });

    const cliSessionId = "cli-session-5678";
    // No transcript evidence — should NOT show
    const cliNoEvidence = resolveWorkflowTaskForSession(projectB, cliSessionId, []);
    assert(cliNoEvidence.task === null, "CLI pointer with no transcript evidence returns null");
    assertEqual(cliNoEvidence.reason, "no-evidence", "no evidence reason for CLI pointer");

    // Test 4: CLI pointer with transcript evidence finds the task
    const evidenceEntry = makeSessionEntry(
      "Active SnFlow task: .pi/snflows/tasks/" + taskCli.id
    );
    const cliWithEvidence = resolveWorkflowTaskForSession(projectB, cliSessionId, [evidenceEntry]);
    assert(cliWithEvidence.task !== null, "CLI pointer with transcript evidence finds task");
    assert(cliWithEvidence.source === "transcript", "evidence uses transcript source");
    assertEqual(cliWithEvidence.task?.id, taskCli.id, "evidence returns CLI task id");

    // Test 5: Blank session (no entries, no matching pointer) shows nothing
    const blankResult = resolveWorkflowTaskForSession(projectA, "blank-session-9999", []);
    assert(blankResult.task === null, "blank session returns null");
    assertEqual(blankResult.reason, "no-evidence", "blank session reason is no-evidence");

    // Test 6: Archived task should not surface
    const archivedSessionId = "archive-sess-0000";
    const archivableTask = createWorkflowTask(projectA, {
      title: "Archivable Task",
      priority: "P3",
      sessionId: archivedSessionId,
    });

    // Force to ready_to_commit then complete + archive
    updateWorkflowTaskProjection(projectA, archivableTask.id, (curr) => ({
      ...curr,
      status: "ready_to_commit",
    }));
    const readyForArchive = getWorkflowTaskDetail(projectA, archivableTask.id);
    completeWorkflowTask(projectA, archivableTask.id, {
      expectedRevision: readyForArchive.revision,
    });
    const completedDetail = getWorkflowTaskDetail(projectA, archivableTask.id);
    archiveWorkflowTask(projectA, archivableTask.id, completedDetail.revision);

    // Now it should not surface even with matching sessionId
    const archivedResult = resolveWorkflowTaskForSession(projectA, archivedSessionId, []);
    assert(archivedResult.task === null, "archived task with matching sessionId returns null");
    assertEqual(archivedResult.reason, "no-evidence", "archived task reason is no-evidence");

    // Test 7: Session-scoped resolution doesn't cross projects
    const crossProjectResult = resolveWorkflowTaskForSession(projectB, sessionIdA, []);
    assert(crossProjectResult.task === null, "cross-project resolution returns null");
    assertEqual(crossProjectResult.reason, "no-evidence", "cross-project reason is no-evidence");

    // Test 8: Created task reference in transcript
    const createEntry = makeSessionEntry(
      "Created SnFlow task: " + taskA.id
    );
    // Use a different session id but with evidence
    const createResult = resolveWorkflowTaskForSession(projectA, "infer-session-7777", [createEntry]);
    assert(createResult.task !== null, "Created task reference in transcript finds task");
    assertEqual(createResult.task?.id, taskA.id, "Created task reference returns correct id");

    // Test 9: Path reference in transcript
    const pathEntry = makeSessionEntry(
      "Found in .pi/snflows/tasks/" + taskA.id + "/requirements.md"
    );
    const pathResult = resolveWorkflowTaskForSession(projectA, "path-session-8888", [pathEntry]);
    assert(pathResult.task !== null, "Path reference in transcript finds task");
    assertEqual(pathResult.task?.id, taskA.id, "Path reference returns correct id");

    // Test 10: Task doesn't exist in store — transcript evidence can't find it
    const missingEntry = makeSessionEntry(
      "Active SnFlow task: .pi/snflows/tasks/nonexistent-task-xyz"
    );
    const missingResult = resolveWorkflowTaskForSession(projectA, "missing-session-9999", [missingEntry]);
    assert(missingResult.task === null, "Missing task with evidence returns null");
    assertEqual(missingResult.reason, "task-not-found", "missing task reason is task-not-found");

    // Test 11: the resolver accepts every store-valid slug shape, including one character.
    const singleCharTask = createWorkflowTask(projectB, {
      id: "a",
      title: "Single character id",
      priority: "P3",
    });
    const singleCharEntry = makeSessionEntry("Active SnFlow task: .pi/snflows/tasks/a");
    const singleCharResult = resolveWorkflowTaskForSession(projectB, "single-char-session", [singleCharEntry]);
    assertEqual(singleCharResult.task?.id, singleCharTask.id, "single-character task id resolves");

    // Report summary
    if (failures === 0) {
      console.log("OK workflow-session-link smoke — all 11 checks passed");
    } else {
      console.error(`${failures} check(s) FAILED`);
      process.exitCode = 1;
    }
  } finally {
    // Cleanup temp directories
    try { rmSync(projectA, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(projectB, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

main();
