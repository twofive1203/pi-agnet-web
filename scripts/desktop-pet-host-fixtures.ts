/**
 * Shared desktop-pet host fixtures consumed by Electron TS and Tauri Rust.
 * Fixture files must not contain real tokens, prompts, cwd, or user directories.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export const DESKTOP_PET_HOST_FIXTURE_DIR = path.join(
  process.cwd(),
  "scripts",
  "fixtures",
  "desktop-pet-host",
);

export function readDesktopPetHostFixture<T>(fileName: string): T {
  const absolutePath = path.join(DESKTOP_PET_HOST_FIXTURE_DIR, fileName);
  return JSON.parse(readFileSync(absolutePath, "utf8")) as T;
}

export function assertFixtureFileHasNoSecrets(fileName: string, extraForbidden: string[] = []): void {
  const raw = readFileSync(path.join(DESKTOP_PET_HOST_FIXTURE_DIR, fileName), "utf8");
  const forbidden = [
    '"token":',
    '"observerToken":',
    '"accessKey":',
    '"firstMessage":',
    '"servicePid":',
    "C:\\Users",
    "/Users/",
    ...extraForbidden,
  ];
  for (const key of forbidden) {
    if (raw.includes(key)) {
      throw new Error(`${fileName} must not contain secret/path marker: ${key}`);
    }
  }
}

export type ConnectionFixtureFile = {
  schemaVersion: number;
  constants: {
    product: string;
    observerProtocolVersion: number;
    quickSessionCapability: string;
    defaultPort: number;
    defaultOrigin: string;
    startCommand: string;
  };
  forbiddenWebViewKeys: string[];
  reducerCases: Array<{
    id: string;
    port: number;
    now: number;
    steps: Array<
      | { kind: "event"; at: number; event: Record<string, unknown> }
      | { kind: "acknowledge"; at: number }
    >;
    expected: Record<string, unknown>;
  }>;
  healthCases: Array<{
    id: string;
    httpStatus: number;
    payload: unknown;
    expected: Record<string, unknown> | null;
  }>;
  protocolCases: Array<{
    id: string;
    httpStatus: number;
    payload: unknown;
    expected: Record<string, unknown>;
  }>;
  sessionCases: Array<{
    id: string;
    httpStatus: number;
    payload: Record<string, unknown>;
    sessionSecret?: string;
    expected: Record<string, unknown>;
  }>;
  sseCases: Array<{
    id: string;
    raw: string;
    expected: { kind: string; reset?: boolean; code?: string; includes?: string };
  }>;
  classifyCases: Array<{
    id: string;
    message: string;
    expected: { type: string };
  }>;
  urlAllowlist: {
    accepted: string[];
    rejected: string[];
  };
};

export type ActivityViewFixtureFile = {
  schemaVersion: number;
  forbiddenWebViewKeys: string[];
  cases: Array<{
    id: string;
    now: number;
    connection: Record<string, unknown>;
    settings?: Record<string, unknown>;
    snapshot?: Record<string, unknown> | null;
    stale?: boolean;
    reset?: boolean;
    hasAccessKey?: boolean;
    expected: {
      presentation: string;
      connectionStatus: string;
      connectionReasonCode: string | null;
      origin: string;
      port: number;
      startCommand: string;
      canCopyStartCommand: boolean;
      hasAccessKey: boolean;
      needsAccessKey: boolean;
      stale: boolean;
      trayOpen: boolean;
      selectedActivityId: string | null;
      selectedPetKey: string;
      reset: boolean;
      instanceId: string | null;
      projectKeys: string[];
      activityRows: Array<{
        activityId: string;
        presentation: string;
        unread: boolean;
        projectKey: string;
      }>;
      attentionCount: number;
      activeCount: number;
      quickSessionAvailable: boolean;
      diagnosticCodes: string[];
    };
  }>;
  safetyCases: Array<{
    id: string;
    payload: Record<string, unknown>;
    injectKey?: string;
    expectThrow: boolean;
  }>;
};

export type TransitionFixtureFile = {
  schemaVersion: number;
  cases: Array<{
    id: string;
    now: number;
    resetBaseline: boolean;
    appInBackground: boolean;
    settings: Record<string, unknown>;
    snapshot: Record<string, unknown>;
    expected: {
      notifyPresentations: string[];
      notifyTransitionIds: string[];
      soundCues: string[];
      notifiedTransitionIds: string[];
      soundedTransitionIds: string[];
    };
  }>;
  sequences?: Array<{
    id: string;
    settings: Record<string, unknown>;
    steps: Array<{
      now: number;
      appInBackground: boolean;
      snapshot: Record<string, unknown>;
      expected: {
        notifyTransitionIds: string[];
        soundCues: string[];
      };
    }>;
    expectedNotifiedTransitionIds: string[];
    expectedSoundedTransitionIds: string[];
  }>;
};

export function publicConnectionState(state: {
  status: string;
  origin: string;
  port: number;
  startCommand: string;
  instanceId: string | null;
  reasonCode: string | null;
  detail: string | null;
  attempt: number;
  resetNotificationBaseline: boolean;
  quickSessionAvailable: boolean;
}): Record<string, unknown> {
  return {
    status: state.status,
    origin: state.origin,
    port: state.port,
    startCommand: state.startCommand,
    instanceId: state.instanceId,
    reasonCode: state.reasonCode,
    detail: state.detail,
    attempt: state.attempt,
    resetNotificationBaseline: state.resetNotificationBaseline,
    quickSessionAvailable: state.quickSessionAvailable,
  };
}
