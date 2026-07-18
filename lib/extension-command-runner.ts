import { createAgentSession, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { ExtensionWebUiBridge } from "@/lib/extension-web-ui";

export type ExtensionCommandNoticeLevel = "info" | "warning" | "error";

export interface ExtensionCommandNotice {
  level: ExtensionCommandNoticeLevel;
  message: string;
}

export type ExtensionCommandFailure = "command_unavailable" | "execution_failed" | "empty_output" | "aborted" | "timed_out";

export interface ExtensionCommandResult {
  command: string;
  executed: boolean;
  notices: ExtensionCommandNotice[];
  queriedAt: number;
  failure?: ExtensionCommandFailure;
  error?: string;
}

interface RunExtensionCommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

type CommandOutcome = "completed" | "failed" | "aborted" | "timed_out";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

function isNoticeLevel(value: unknown): value is ExtensionCommandNoticeLevel {
  return value === "info" || value === "warning" || value === "error";
}

function interruptedResult(command: string, outcome: "aborted" | "timed_out", notices: ExtensionCommandNotice[]): ExtensionCommandResult {
  return {
    command,
    executed: false,
    notices,
    queriedAt: Date.now(),
    failure: outcome,
    error: outcome === "timed_out"
      ? `Extension command /${command} timed out. Check the provider network connection and retry.`
      : `Extension command /${command} was cancelled.`,
  };
}

/**
 * Runs one registered extension command in an ephemeral cwd-bound SDK session.
 * The caller is responsible for restricting which command names may reach here.
 */
export async function runExtensionCommand(
  cwd: string,
  commandName: string,
  options: RunExtensionCommandOptions = {},
): Promise<ExtensionCommandResult> {
  const notices: ExtensionCommandNotice[] = [];
  if (options.signal?.aborted) return interruptedResult(commandName, "aborted", notices);
  let commandFailed = false;
  let commandRunning = false;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let bridge: ExtensionWebUiBridge | undefined;

  try {
    const result = await createAgentSession({
      cwd,
      agentDir: getAgentDir(),
      sessionManager: SessionManager.inMemory(cwd),
    });
    session = result.session;

    bridge = new ExtensionWebUiBridge((event) => {
      if (commandRunning && event.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string") {
        notices.push({
          level: isNoticeLevel(event.notifyType) ? event.notifyType : "info",
          message: event.message,
        });
      }
      if (commandRunning && event.type === "extension_error" && event.event === "ui") commandFailed = true;
    });

    await session.bindExtensions?.({
      uiContext: bridge.createContext() as never,
      mode: "rpc",
      commandContextActions: {
        waitForIdle: async () => { await session?.agent.waitForIdle?.(); },
        newSession: async () => ({ cancelled: true }),
        fork: async () => ({ cancelled: true }),
        navigateTree: async () => ({ cancelled: true }),
        switchSession: async () => ({ cancelled: true }),
        reload: async () => {},
      },
      onError: (error: { event: string }) => {
        if (error.event === "command") commandFailed = true;
      },
    });

    const command = session.extensionRunner.getCommand(commandName);
    if (!command) {
      return {
        command: commandName,
        executed: false,
        notices,
        queriedAt: Date.now(),
        failure: "command_unavailable",
        error: `Extension command /${commandName} is unavailable. Check that the provider package is installed for this workspace.`,
      };
    }

    commandRunning = true;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const commandPromise: Promise<CommandOutcome> = command
      .handler("", session.extensionRunner.createCommandContext())
      .then(() => "completed" as const, () => "failed" as const);
    const timeoutPromise = new Promise<CommandOutcome>((resolve) => {
      timeoutId = setTimeout(() => resolve("timed_out"), options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    });
    const abortPromise = new Promise<CommandOutcome>((resolve) => {
      if (!options.signal) return;
      abortListener = () => resolve("aborted");
      if (options.signal.aborted) abortListener();
      else options.signal.addEventListener("abort", abortListener, { once: true });
    });

    const outcome = await Promise.race([commandPromise, timeoutPromise, abortPromise]);
    commandRunning = false;
    if (timeoutId) clearTimeout(timeoutId);
    if (abortListener) options.signal?.removeEventListener("abort", abortListener);

    if (outcome === "aborted" || outcome === "timed_out") {
      await session.abort().catch(() => {});
      return interruptedResult(commandName, outcome, notices);
    }
    if (outcome === "failed") commandFailed = true;

    if (commandFailed) {
      return {
        command: commandName,
        executed: false,
        notices,
        queriedAt: Date.now(),
        failure: "execution_failed",
        error: `Extension command /${commandName} failed. Re-login and retry, or run it in Pi for more details.`,
      };
    }

    if (notices.length === 0) {
      return {
        command: commandName,
        executed: false,
        notices,
        queriedAt: Date.now(),
        failure: "empty_output",
        error: `Extension command /${commandName} completed without usage output.`,
      };
    }

    return {
      command: commandName,
      executed: true,
      notices,
      queriedAt: Date.now(),
    };
  } catch {
    return {
      command: commandName,
      executed: false,
      notices,
      queriedAt: Date.now(),
      failure: "execution_failed",
      error: `Extension command /${commandName} could not be executed. Check the package installation and try again.`,
    };
  } finally {
    bridge?.rejectAll();
    session?.dispose();
  }
}
