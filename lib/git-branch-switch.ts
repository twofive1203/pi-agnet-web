import {
  GIT_WRITE_BUFFER,
  GIT_WRITE_TIMEOUT_MS,
  GitWorkbenchError,
  runGit,
  type GitRepositoryIdentity,
} from "@/lib/git-executor";

const CHECKOUT_OVERWRITE_PATTERN = /would be overwritten by (?:checkout|switch)/i;

export type SafeGitSwitchTarget =
  | { kind: "existing"; name: string }
  | { kind: "create"; name: string; startPoint: string }
  | { kind: "create-tracking"; name: string; startPoint: string };

export function isGitCheckoutOverwriteRefusal(text: string): boolean {
  return CHECKOUT_OVERWRITE_PATTERN.test(text);
}

function switchArgs(target: SafeGitSwitchTarget): string[] {
  switch (target.kind) {
    case "existing":
      return ["switch", "--no-overwrite-ignore", "--", target.name];
    case "create":
      return ["switch", "--no-overwrite-ignore", "-c", target.name, "--", target.startPoint];
    case "create-tracking":
      return ["switch", "--no-overwrite-ignore", "--track", "-c", target.name, "--", target.startPoint];
  }
}

function diagnosticText(error: GitWorkbenchError): string {
  return `${error.stderr ?? ""}\n${error.stdout ?? ""}\n${error.details ?? ""}`;
}

/**
 * Ordinary checkout that keeps non-conflicting local changes and refuses real
 * overwrite risk, including ignored files Git would otherwise replace.
 */
export async function runSafeGitSwitch(
  repo: GitRepositoryIdentity,
  target: SafeGitSwitchTarget,
): Promise<void> {
  try {
    await runGit(repo.cwd, switchArgs(target), {
      timeoutMs: GIT_WRITE_TIMEOUT_MS,
      maxBuffer: GIT_WRITE_BUFFER,
      env: {
        ...process.env,
        // Classify overwrite refusals against English Git diagnostics.
        LANG: "C",
        LC_ALL: "C",
        LANGUAGE: "C",
      },
    });
  } catch (error) {
    if (!(error instanceof GitWorkbenchError)) throw error;
    if (error.code !== "GIT_FAILED") throw error;
    if (!isGitCheckoutOverwriteRefusal(diagnosticText(error))) throw error;
    throw new GitWorkbenchError(
      "CHECKOUT_CONFLICT",
      "Checkout would overwrite local changes. The current branch and files were left unchanged.",
      {
        status: 409,
        details: error.details,
        stdout: error.stdout,
        stderr: error.stderr,
      },
    );
  }
}
