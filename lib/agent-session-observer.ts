/**
 * Shared AgentSession event observer helpers (file-change sidecar, etc.).
 */

export type SessionObserver = {
  onEvent: (event: unknown) => void;
  dispose: () => Promise<void>;
};

/**
 * Attach edit/write file-change observation for a session.
 * Works for both interactive and automation hosts.
 */
export function createFileChangeObserver(input: {
  sessionId: string;
  cwd: string;
  sessionFile?: string;
}): SessionObserver {
  return {
    onEvent(event: unknown) {
      try {
        // Lazy import keeps runner unit smokes free of pi SDK package exports.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { recordSessionFileChangeEvent } = require("./session-file-changes") as typeof import("./session-file-changes");
        void recordSessionFileChangeEvent({
          sessionId: input.sessionId,
          cwd: input.cwd,
          sessionFile: input.sessionFile,
          event: event as never,
        }).catch(() => {
          // observer must not break runner
        });
      } catch {
        // observer must not break runner
      }
    },
    async dispose() {
      // Lazy import keeps runner unit smokes free of pi SDK package exports.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { flushSessionFileChanges } = require("./session-file-changes") as typeof import("./session-file-changes");
      await flushSessionFileChanges(input.sessionId);
    },
  };
}

export type SessionFileChangeEventResult = {
  changed: boolean;
  fileCount: number;
};
