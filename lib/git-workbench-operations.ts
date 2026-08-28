import { access } from "node:fs/promises";
import path from "node:path";
import type {
  GitCommitCapability,
  GitResetMode,
  GitWorkbenchOperationRequest,
  GitWorkbenchOperationResponse,
  GitWorkbenchOverview,
  GitWorkbenchRef,
} from "@/lib/types";
import { runSafeGitSwitch } from "@/lib/git-branch-switch";
import {
  GIT_WRITE_BUFFER,
  GIT_WRITE_TIMEOUT_MS,
  GitWorkbenchError,
  readGitOperationState,
  resolveGitRepository,
  runGit,
  withGitMutationLock,
  type GitRepositoryIdentity,
} from "@/lib/git-executor";
import {
  isGitCommandSuccessful,
  normalizeGitCommit,
  readCommitCapabilities,
  readGitWorkbenchOverview,
} from "@/lib/git-workbench";

const RESET_MODES = new Set<GitResetMode>(["soft", "mixed", "hard", "keep"]);

function ensureExpectedRevision(overview: GitWorkbenchOverview, expectedRevision: string): void {
  if (!expectedRevision || overview.revision !== expectedRevision) {
    throw new GitWorkbenchError("STALE_REVISION", "Repository refs changed. Refresh before running this operation.", { status: 409 });
  }
}

function ensureExpectedHead(overview: GitWorkbenchOverview, expectedHead: string | undefined): string {
  if (!overview.head || !expectedHead || overview.head !== expectedHead) {
    throw new GitWorkbenchError("STALE_HEAD", "The current HEAD changed. Refresh before running this operation.", { status: 409 });
  }
  return overview.head;
}

function ensureExpectedRef(ref: GitWorkbenchRef, expectedTip: string): void {
  if (!expectedTip || ref.target !== expectedTip) {
    throw new GitWorkbenchError("STALE_REF", "The selected branch changed. Refresh before running this operation.", { status: 409 });
  }
}

function ensureNoOperation(overview: GitWorkbenchOverview): void {
  if (overview.operationState) {
    throw new GitWorkbenchError("OPERATION_IN_PROGRESS", `A Git ${overview.operationState} operation is already in progress.`, {
      status: 409,
      details: overview.operationState,
    });
  }
}

function ensureNoUnmerged(overview: GitWorkbenchOverview): void {
  if (overview.hasUnmerged) {
    throw new GitWorkbenchError("UNMERGED_INDEX", "The index has unmerged entries.", { status: 409 });
  }
}

function ensureCapability(capability: GitCommitCapability | undefined): void {
  if (!capability?.allowed) {
    throw new GitWorkbenchError("UNSAFE_OPERATION", "The selected commit is outside the safe range for this operation.", {
      status: 409,
      details: capability?.reason ?? "capability unavailable",
    });
  }
}

async function gitWrite(
  repo: GitRepositoryIdentity,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; network?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  return runGit(repo.cwd, args, {
    timeoutMs: GIT_WRITE_TIMEOUT_MS,
    maxBuffer: GIT_WRITE_BUFFER,
    env: options.env,
    network: options.network,
  });
}

async function normalizedCommitWithCapabilities(
  repo: GitRepositoryIdentity,
  overview: GitWorkbenchOverview,
  hashInput: string,
) {
  const normalized = await normalizeGitCommit(repo.cwd, hashInput);
  const parentsOutput = await runGit(repo.cwd, ["show", "-s", "--format=%P", normalized.hash]);
  const parents = parentsOutput.stdout.trim().split(/\s+/).filter(Boolean);
  const capabilities = await readCommitCapabilities(repo, overview, normalized.hash, parents);
  return { hash: normalized.hash, parents, capabilities };
}

async function refreshedResponse(
  action: GitWorkbenchOperationRequest["action"],
  cwd: string,
  selectedHash: string | null,
  outcome?: GitWorkbenchOperationResponse["outcome"],
): Promise<GitWorkbenchOperationResponse> {
  return {
    success: true,
    action,
    overview: await readGitWorkbenchOverview(cwd),
    selectedHash,
    outcome,
  };
}

function branchInAnotherWorktree(ref: GitWorkbenchRef, repo: GitRepositoryIdentity): boolean {
  return Boolean(ref.checkedOutPath && path.resolve(ref.checkedOutPath) !== path.resolve(repo.repoRoot));
}

async function validateBranchName(repo: GitRepositoryIdentity, name: string): Promise<void> {
  if (!name || name.trim() !== name || name.startsWith("-")) {
    throw new GitWorkbenchError("INVALID_REQUEST", "Invalid branch name.", { status: 400 });
  }
  try {
    await runGit(repo.cwd, ["check-ref-format", "--branch", name]);
  } catch {
    throw new GitWorkbenchError("INVALID_REQUEST", "Invalid branch name.", { status: 400, details: name });
  }
}

async function validateTagName(repo: GitRepositoryIdentity, name: string): Promise<void> {
  if (!name || name.trim() !== name || name.startsWith("-")) {
    throw new GitWorkbenchError("INVALID_REQUEST", "Invalid tag name.", { status: 400 });
  }
  try {
    await runGit(repo.cwd, ["check-ref-format", `refs/tags/${name}`]);
  } catch {
    throw new GitWorkbenchError("INVALID_REQUEST", "Invalid tag name.", { status: 400, details: name });
  }
}

function splitRemoteTrackingRef(ref: string): { remote: string; branch: string } | null {
  const prefix = "refs/remotes/";
  if (!ref.startsWith(prefix)) return null;
  const short = ref.slice(prefix.length);
  const slash = short.indexOf("/");
  if (slash <= 0 || slash === short.length - 1) return null;
  return { remote: short.slice(0, slash), branch: short.slice(slash + 1) };
}

function quoteEditorArgument(value: string): string {
  const slashNormalized = process.platform === "win32" ? value.replaceAll("\\", "/") : value;
  return `"${slashNormalized.replace(/["\\$`]/g, "\\$&")}"`;
}

async function resolveRebaseEditorPath(): Promise<string> {
  const candidates = [
    path.join(process.cwd(), "scripts", "git-rebase-editor.cjs"),
    path.resolve(path.dirname(process.argv[1] || process.cwd()), "..", "scripts", "git-rebase-editor.cjs"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next runtime layout.
    }
  }
  throw new GitWorkbenchError("GIT_FAILED", "The controlled Git history editor is unavailable.", {
    status: 500,
    details: candidates.join("\n"),
  });
}

async function abortAndReport(
  repo: GitRepositoryIdentity,
  abortArgs: readonly string[],
  expectedHead: string,
  originalError: unknown,
): Promise<never> {
  const beforeAbortState = await readGitOperationState(repo);
  if (!beforeAbortState) throw originalError;
  try {
    await gitWrite(repo, abortArgs);
  } catch (abortError) {
    throw new GitWorkbenchError("RECOVERY_REQUIRED", "Git could not automatically abort the conflicted operation. Inspect the repository before running another write.", {
      status: 409,
      recoveryRequired: true,
      details: abortError instanceof Error ? abortError.message : String(abortError),
    });
  }
  const [state, headOutput] = await Promise.all([
    readGitOperationState(repo),
    runGit(repo.cwd, ["rev-parse", "--verify", "HEAD"]).catch(() => ({ stdout: "", stderr: "" })),
  ]);
  if (state || headOutput.stdout.trim() !== expectedHead) {
    throw new GitWorkbenchError("RECOVERY_REQUIRED", "Git abort completed without restoring the expected repository state. Inspect the repository before running another write.", {
      status: 409,
      recoveryRequired: true,
      details: state ?? headOutput.stdout.trim(),
    });
  }
  throw new GitWorkbenchError("CONFLICT_ABORTED", "The operation conflicted and was automatically aborted. The repository was restored.", {
    status: 409,
    details: originalError instanceof GitWorkbenchError ? originalError.details : originalError instanceof Error ? originalError.message : String(originalError),
  });
}

function mapPushError(error: unknown): never {
  if (error instanceof GitWorkbenchError && error.code === "PUSH_OUTCOME_UNKNOWN") throw error;
  const detail = error instanceof GitWorkbenchError ? `${error.details ?? ""}\n${error.stderr ?? ""}` : String(error);
  const lower = detail.toLowerCase();
  if (/pre-push hook|hook declined/.test(lower)) {
    throw new GitWorkbenchError("PUSH_HOOK_FAILED", "The repository pre-push hook rejected the push.", { status: 409, details: detail });
  }
  if (/authentication failed|permission denied|could not read username|publickey|access denied/.test(lower)) {
    throw new GitWorkbenchError("PUSH_AUTH_FAILED", "Git remote authentication failed.", { status: 502, details: detail });
  }
  if (/non-fast-forward|\[rejected\]|fetch first|stale info|updates were rejected|failed to push some refs/.test(lower)) {
    throw new GitWorkbenchError("PUSH_REJECTED", "The remote rejected this non-fast-forward push. Refresh or integrate remote changes; force push is not available.", {
      status: 409,
      details: detail,
    });
  }
  throw error;
}

export async function executeGitWorkbenchOperation(
  request: GitWorkbenchOperationRequest,
): Promise<GitWorkbenchOperationResponse> {
  const repo = await resolveGitRepository(request.cwd);
  return withGitMutationLock(repo, async () => {
    const overview = await readGitWorkbenchOverview(repo.cwd);
    ensureExpectedRevision(overview, request.expectedRevision);
    ensureNoOperation(overview);

    switch (request.action) {
      case "checkout-local": {
        ensureNoUnmerged(overview);
        const selected = overview.localBranches.find((ref) => ref.ref === request.ref);
        if (!selected) throw new GitWorkbenchError("REF_NOT_FOUND", "Local branch not found.", { status: 404 });
        if (selected.current) return refreshedResponse(request.action, repo.cwd, selected.target, "up-to-date");
        if (branchInAnotherWorktree(selected, repo)) {
          throw new GitWorkbenchError("BRANCH_IN_USE", "The branch is checked out in another linked worktree.", { status: 409, details: selected.checkedOutPath ?? undefined });
        }
        await runSafeGitSwitch(repo, { kind: "existing", name: selected.name });
        return refreshedResponse(request.action, repo.cwd, selected.target, "updated");
      }

      case "checkout-remote": {
        ensureNoUnmerged(overview);
        const remoteRef = overview.remoteBranches.find((ref) => ref.ref === request.ref);
        if (!remoteRef) throw new GitWorkbenchError("REF_NOT_FOUND", "Remote-tracking branch not found.", { status: 404 });
        const split = splitRemoteTrackingRef(remoteRef.ref);
        if (!split) throw new GitWorkbenchError("INVALID_REQUEST", "Invalid remote-tracking ref.", { status: 400 });
        const localName = request.localName?.trim() || split.branch;
        await validateBranchName(repo, localName);
        const local = overview.localBranches.find((ref) => ref.name === localName);
        if (local) {
          if (local.upstreamRef !== remoteRef.ref) {
            throw new GitWorkbenchError("UNSAFE_OPERATION", "A same-named local branch exists with a different tracking relationship.", { status: 409, details: local.ref });
          }
          if (branchInAnotherWorktree(local, repo)) {
            throw new GitWorkbenchError("BRANCH_IN_USE", "The local tracking branch is checked out in another linked worktree.", { status: 409, details: local.checkedOutPath ?? undefined });
          }
          if (!local.current) await runSafeGitSwitch(repo, { kind: "existing", name: local.name });
          return refreshedResponse(request.action, repo.cwd, local.target, local.current ? "up-to-date" : "updated");
        }
        await runSafeGitSwitch(repo, { kind: "create-tracking", name: localName, startPoint: remoteRef.ref });
        return refreshedResponse(request.action, repo.cwd, remoteRef.target, "created");
      }

      case "push": {
        const local = overview.localBranches.find((ref) => ref.ref === request.ref);
        if (!local) throw new GitWorkbenchError("REF_NOT_FOUND", "Local branch not found.", { status: 404 });
        ensureExpectedRef(local, request.expectedRefTip);
        let remote = request.remote?.trim() ?? "";
        let target = request.target?.trim() ?? "";
        if (local.upstreamRef) {
          const split = splitRemoteTrackingRef(local.upstreamRef);
          if (split) {
            remote = split.remote;
            target = split.branch;
          }
        }
        if (remote.startsWith("-") || !overview.remotes.includes(remote)) {
          throw new GitWorkbenchError("INVALID_REQUEST", "Selected Git remote is not configured.", { status: 400 });
        }
        await validateBranchName(repo, target);
        const args = ["push", "--porcelain"];
        if (request.setUpstream || !local.upstreamRef) args.push("--set-upstream");
        args.push(remote, `${local.ref}:refs/heads/${target}`);
        try {
          const output = await gitWrite(repo, args, { network: true });
          const text = `${output.stdout}\n${output.stderr}`;
          const outcome = /\[up to date\]|up-to-date/i.test(text) ? "up-to-date" : /\[new branch\]/i.test(text) ? "created" : "updated";
          return refreshedResponse(request.action, repo.cwd, local.target, outcome);
        } catch (error) {
          mapPushError(error);
        }
      }

      case "cherry-pick": {
        const expectedHead = ensureExpectedHead(overview, request.expectedHead);
        const selected = await normalizedCommitWithCapabilities(repo, overview, request.hash);
        ensureCapability(selected.capabilities.cherryPick);
        try {
          await gitWrite(repo, ["cherry-pick", selected.hash]);
        } catch (error) {
          return abortAndReport(repo, ["cherry-pick", "--abort"], expectedHead, error);
        }
        const nextHead = (await runGit(repo.cwd, ["rev-parse", "HEAD"])).stdout.trim();
        return refreshedResponse(request.action, repo.cwd, nextHead, "created");
      }

      case "revert": {
        const expectedHead = ensureExpectedHead(overview, request.expectedHead);
        const selected = await normalizedCommitWithCapabilities(repo, overview, request.hash);
        ensureCapability(selected.capabilities.revert);
        try {
          await gitWrite(repo, ["revert", "--no-edit", selected.hash]);
        } catch (error) {
          return abortAndReport(repo, ["revert", "--abort"], expectedHead, error);
        }
        const nextHead = (await runGit(repo.cwd, ["rev-parse", "HEAD"])).stdout.trim();
        return refreshedResponse(request.action, repo.cwd, nextHead, "created");
      }

      case "reset": {
        ensureExpectedHead(overview, request.expectedHead);
        const selected = await normalizedCommitWithCapabilities(repo, overview, request.hash);
        ensureCapability(selected.capabilities.reset);
        if (!RESET_MODES.has(request.mode)) throw new GitWorkbenchError("INVALID_REQUEST", "Invalid reset mode.", { status: 400 });
        if (request.mode === "hard" && request.confirmTarget !== selected.hash && request.confirmTarget !== selected.hash.slice(0, 8)) {
          throw new GitWorkbenchError("INVALID_REQUEST", "Hard reset confirmation does not match the target commit.", { status: 400 });
        }
        await gitWrite(repo, ["reset", `--${request.mode}`, selected.hash]);
        return refreshedResponse(request.action, repo.cwd, selected.hash, "updated");
      }

      case "reword": {
        const expectedHead = ensureExpectedHead(overview, request.expectedHead);
        const message = request.message.trim();
        if (!message || message.length > 16_000) throw new GitWorkbenchError("INVALID_REQUEST", "Commit message must be between 1 and 16000 characters.", { status: 400 });
        const selected = await normalizedCommitWithCapabilities(repo, overview, request.hash);
        ensureCapability(selected.capabilities.reword);
        if (selected.hash === expectedHead) {
          await gitWrite(repo, ["commit", "--amend", "-m", message]);
        } else {
          const editorPath = await resolveRebaseEditorPath();
          const editorCommand = `${quoteEditorArgument(process.execPath)} ${quoteEditorArgument(editorPath)}`;
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            GIT_SEQUENCE_EDITOR: `${editorCommand} sequence`,
            GIT_EDITOR: `${editorCommand} message`,
            PI_GIT_REWRITE_ACTION: "reword",
            PI_GIT_REWRITE_TARGET: selected.hash,
            PI_GIT_REWRITE_MESSAGE_BASE64: Buffer.from(message, "utf8").toString("base64"),
          };
          try {
            await gitWrite(repo, ["rebase", "-i", `${selected.hash}^`], { env });
          } catch (error) {
            return abortAndReport(repo, ["rebase", "--abort"], expectedHead, error);
          }
        }
        const nextHead = (await runGit(repo.cwd, ["rev-parse", "HEAD"])).stdout.trim();
        return refreshedResponse(request.action, repo.cwd, nextHead, "updated");
      }

      case "drop": {
        const expectedHead = ensureExpectedHead(overview, request.expectedHead);
        const selected = await normalizedCommitWithCapabilities(repo, overview, request.hash);
        ensureCapability(selected.capabilities.drop);
        const parent = selected.parents[0];
        if (!parent) throw new GitWorkbenchError("UNSAFE_OPERATION", "Root commits cannot be dropped.", { status: 409 });
        try {
          await gitWrite(repo, ["rebase", "--onto", parent, selected.hash]);
        } catch (error) {
          return abortAndReport(repo, ["rebase", "--abort"], expectedHead, error);
        }
        const nextHead = (await runGit(repo.cwd, ["rev-parse", "HEAD"])).stdout.trim();
        return refreshedResponse(request.action, repo.cwd, nextHead, "updated");
      }

      case "create-branch": {
        const selected = await normalizedCommitWithCapabilities(repo, overview, request.hash);
        ensureCapability(selected.capabilities.newBranch);
        await validateBranchName(repo, request.name);
        if (overview.localBranches.some((ref) => ref.name === request.name)) {
          throw new GitWorkbenchError("INVALID_REQUEST", "A local branch with this name already exists.", { status: 409 });
        }
        if (request.checkout) {
          ensureExpectedHead(overview, request.expectedHead);
          ensureNoUnmerged(overview);
          await runSafeGitSwitch(repo, { kind: "create", name: request.name, startPoint: selected.hash });
        } else {
          await gitWrite(repo, ["branch", request.name, selected.hash]);
        }
        return refreshedResponse(request.action, repo.cwd, selected.hash, "created");
      }

      case "create-tag": {
        const selected = await normalizedCommitWithCapabilities(repo, overview, request.hash);
        ensureCapability(selected.capabilities.newTag);
        await validateTagName(repo, request.name);
        if (overview.tags.some((ref) => ref.name === request.name)) {
          throw new GitWorkbenchError("INVALID_REQUEST", "A tag with this name already exists.", { status: 409 });
        }
        await gitWrite(repo, ["tag", request.name, selected.hash]);
        return refreshedResponse(request.action, repo.cwd, selected.hash, "created");
      }
    }
  });
}

export async function canResolveGitRef(cwd: string, ref: string): Promise<boolean> {
  const repo = await resolveGitRepository(cwd);
  return isGitCommandSuccessful(repo, ["show-ref", "--verify", "--quiet", ref]);
}
