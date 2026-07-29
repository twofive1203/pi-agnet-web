import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  consumeApprovalChallenge,
  createApprovalChallenge,
  confirmApprovalChallenge,
  setUiApprovalContext,
  consumeUiApprovalContext,
  hashProposedConfig,
  peekApprovalChallenge,
} from "../lib/automation-approval";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const agentDir = mkdtempSync(path.join(tmpdir(), "auto-appr-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

try {
  const control = "id.token-value";

  // Production path: create does NOT return secret; confirm required before consume.
  const challenge = createApprovalChallenge({
    action: "activate",
    taskId: "t1",
    revision: "r1",
    policyHash: "ph",
    cwd: "/tmp/x",
    summary: ["Authority: activate t1", "cwd=/tmp/x"],
    controlSessionRaw: control,
  });
  assert(!("secret" in challenge && (challenge as { secret?: string }).secret), "create must not return secret");
  assert(challenge.requiresConfirmation === true, "requires confirmation");
  assert(peekApprovalChallenge(challenge.challengeId)?.confirmedAt == null, "not confirmed yet");

  // Consume without confirm fails
  let failed = false;
  try {
    consumeApprovalChallenge({
      challengeId: challenge.challengeId,
      secret: "guess",
      action: "activate",
      taskId: "t1",
      revision: "r1",
      policyHash: "ph",
      cwd: "/tmp/x",
      controlSessionRaw: control,
    });
  } catch {
    failed = true;
  }
  assert(failed, "consume without confirm fails");

  const confirmed = confirmApprovalChallenge({
    challengeId: challenge.challengeId,
    controlSessionRaw: control,
  });
  assert(confirmed.secret, "secret delivered on confirm");
  assert(peekApprovalChallenge(challenge.challengeId)?.confirmedAt != null, "confirmed");

  // wrong secret
  failed = false;
  try {
    consumeApprovalChallenge({
      challengeId: challenge.challengeId,
      secret: "wrong",
      action: "activate",
      taskId: "t1",
      revision: "r1",
      policyHash: "ph",
      cwd: "/tmp/x",
      controlSessionRaw: control,
    });
  } catch {
    failed = true;
  }
  assert(failed, "bad secret fails");

  consumeApprovalChallenge({
    challengeId: challenge.challengeId,
    secret: confirmed.secret,
    action: "activate",
    taskId: "t1",
    revision: "r1",
    policyHash: "ph",
    cwd: "/tmp/x",
    controlSessionRaw: control,
  });

  // replay
  failed = false;
  try {
    consumeApprovalChallenge({
      challengeId: challenge.challengeId,
      secret: confirmed.secret,
      action: "activate",
      taskId: "t1",
      revision: "r1",
      policyHash: "ph",
      cwd: "/tmp/x",
      controlSessionRaw: control,
    });
  } catch (e) {
    failed = (e as { code?: string }).code === "approval_replayed";
  }
  assert(failed, "replay fails");

  // model confirmed true is irrelevant — UI context required
  assert(!consumeUiApprovalContext("activate", { taskId: "t1" }), "no ui context");
  setUiApprovalContext({ action: "activate", taskId: "t1" });
  assert(consumeUiApprovalContext("activate", { taskId: "t1" }), "ui context ok");
  assert(!consumeUiApprovalContext("activate", { taskId: "t1" }), "ui context one-shot");

  // Multi-slot: two concurrent proofs must not clobber each other
  setUiApprovalContext({ action: "run_now", taskId: "a" });
  setUiApprovalContext({ action: "archive", taskId: "b" });
  assert(consumeUiApprovalContext("archive", { taskId: "b" }), "slot b");
  assert(consumeUiApprovalContext("run_now", { taskId: "a" }), "slot a");

  // Export approval binds cwd + policyHash + revision (same as create)
  const exp = createApprovalChallenge({
    action: "export_run",
    taskId: "t1",
    runId: "r1",
    revision: "rev-export",
    policyHash: "ph-export",
    cwd: "/canonical/cwd",
    summary: ["export"],
    controlSessionRaw: control,
  });
  const expSecret = confirmApprovalChallenge({
    challengeId: exp.challengeId,
    controlSessionRaw: control,
  }).secret;
  failed = false;
  try {
    consumeApprovalChallenge({
      challengeId: exp.challengeId,
      secret: expSecret,
      action: "export_run",
      taskId: "t1",
      runId: "r1",
      revision: "rev-export",
      policyHash: "ph-export",
      cwd: "/wrong/cwd",
      controlSessionRaw: control,
    });
  } catch {
    failed = true;
  }
  assert(failed, "export cwd mismatch fails");

  // Recreate for successful consume with full binding
  const exp2 = createApprovalChallenge({
    action: "export_run",
    taskId: "t1",
    runId: "r1",
    revision: "rev-export",
    policyHash: "ph-export",
    cwd: "/canonical/cwd",
    summary: ["export"],
    controlSessionRaw: control,
  });
  const exp2Secret = confirmApprovalChallenge({
    challengeId: exp2.challengeId,
    controlSessionRaw: control,
  }).secret;
  consumeApprovalChallenge({
    challengeId: exp2.challengeId,
    secret: exp2Secret,
    action: "export", // alias
    taskId: "t1",
    runId: "r1",
    revision: "rev-export",
    policyHash: "ph-export",
    cwd: "/canonical/cwd",
    controlSessionRaw: control,
  });

  // cancel/promote/delete same binding
  for (const action of ["cancel_run", "promote", "delete_artifacts"] as const) {
    const c = createApprovalChallenge({
      action,
      taskId: "t1",
      runId: "run-x",
      revision: "rev-1",
      policyHash: "ph-1",
      cwd: "/c",
      summary: [action],
      controlSessionRaw: control,
    });
    const s = confirmApprovalChallenge({ challengeId: c.challengeId, controlSessionRaw: control }).secret;
    consumeApprovalChallenge({
      challengeId: c.challengeId,
      secret: s,
      action,
      taskId: "t1",
      runId: "run-x",
      revision: "rev-1",
      policyHash: "ph-1",
      cwd: "/c",
      controlSessionRaw: control,
    });
  }

  // update_sensitive binds proposed config hash, not existing state
  const proposed = { name: "new", prompt: "p2" };
  const ph = hashProposedConfig(proposed);
  const upd = createApprovalChallenge({
    action: "update_sensitive",
    taskId: "t1",
    revision: "r9",
    policyHash: "newph",
    cwd: "/c",
    proposedConfigHash: ph,
    summary: ["proposed"],
    controlSessionRaw: control,
  });
  const updSecret = confirmApprovalChallenge({
    challengeId: upd.challengeId,
    controlSessionRaw: control,
  }).secret;
  failed = false;
  try {
    consumeApprovalChallenge({
      challengeId: upd.challengeId,
      secret: updSecret,
      action: "update_sensitive",
      taskId: "t1",
      revision: "r9",
      policyHash: "newph",
      cwd: "/c",
      proposedConfigHash: hashProposedConfig({ name: "old" }),
      controlSessionRaw: control,
    });
  } catch {
    failed = true;
  }
  assert(failed, "proposed config mismatch fails");

  const upd2 = createApprovalChallenge({
    action: "update_sensitive",
    taskId: "t1",
    revision: "r9",
    policyHash: "newph",
    cwd: "/c",
    proposedConfigHash: ph,
    summary: ["proposed"],
    controlSessionRaw: control,
  });
  const upd2Secret = confirmApprovalChallenge({
    challengeId: upd2.challengeId,
    controlSessionRaw: control,
  }).secret;
  consumeApprovalChallenge({
    challengeId: upd2.challengeId,
    secret: upd2Secret,
    action: "update_sensitive",
    taskId: "t1",
    revision: "r9",
    policyHash: "newph",
    cwd: "/c",
    proposedConfigHash: ph,
    controlSessionRaw: control,
  });

  console.log("smoke-automation-approval: ok");
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}
