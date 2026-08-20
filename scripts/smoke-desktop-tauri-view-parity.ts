/**
 * Cross-host activity-view / transition fixture smoke (Phase B).
 * Run: npx --yes tsx@4.23.1 scripts/smoke-desktop-tauri-view-parity.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  assertRendererViewSafe,
  buildActivityView,
} from "../desktop/main/activity-store";
import {
  createInitialConnectionState,
  type DesktopConnectionState,
} from "../desktop/main/connection-state";
import { selectNotifications } from "../desktop/main/notification-controller";
import { createDefaultDesktopSettings, normalizeDesktopSettings } from "../desktop/main/settings-store";
import { selectSoundCues } from "../desktop/main/sound-policy";
import {
  assertFixtureFileHasNoSecrets,
  readDesktopPetHostFixture,
  type ActivityViewFixtureFile,
  type TransitionFixtureFile,
} from "./desktop-pet-host-fixtures";

function connectionFrom(raw: Record<string, unknown>): DesktopConnectionState {
  const base = createInitialConnectionState({
    port: typeof raw.port === "number" ? raw.port : 62666,
    now: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  });
  return {
    ...base,
    ...(raw as Partial<DesktopConnectionState>),
    origin: typeof raw.origin === "string" ? raw.origin : base.origin,
    startCommand: typeof raw.startCommand === "string" ? raw.startCommand : base.startCommand,
  } as DesktopConnectionState;
}

function summarizeView(view: ReturnType<typeof buildActivityView>) {
  return {
    presentation: view.presentation,
    connectionStatus: view.connectionStatus,
    connectionReasonCode: view.connectionReasonCode,
    origin: view.origin,
    port: view.port,
    startCommand: view.startCommand,
    canCopyStartCommand: view.canCopyStartCommand,
    hasAccessKey: view.hasAccessKey,
    needsAccessKey: view.needsAccessKey,
    stale: view.stale,
    trayOpen: view.trayOpen,
    selectedActivityId: view.selectedActivityId,
    selectedPetKey: view.selectedPetKey,
    reset: view.reset,
    instanceId: view.instanceId,
    projectKeys: view.projects.map((project) => project.projectKey),
    activityRows: view.projects.flatMap((project) =>
      project.activities.map((row) => ({
        activityId: row.activityId,
        presentation: row.presentation,
        unread: row.unread,
        projectKey: project.projectKey,
      })),
    ),
    attentionCount: view.attentionCount,
    activeCount: view.activeCount,
    quickSessionAvailable: view.quickSessionAvailable,
    diagnosticCodes: view.diagnostics.map((item) => item.code),
  };
}

console.log("smoke-desktop-tauri-view-parity: start");

assertFixtureFileHasNoSecrets("activity-view-cases.json");
assertFixtureFileHasNoSecrets("transition-cases.json");

const viewFixtures = readDesktopPetHostFixture<ActivityViewFixtureFile>("activity-view-cases.json");
for (const testCase of viewFixtures.cases) {
  const settings = normalizeDesktopSettings({
    ...createDefaultDesktopSettings(),
    ...(testCase.settings ?? {}),
  });
  const view = buildActivityView({
    snapshot: (testCase.snapshot as never) ?? null,
    connection: connectionFrom(testCase.connection),
    settings,
    now: testCase.now,
    stale: testCase.stale,
    reset: testCase.reset,
    hasAccessKey: testCase.hasAccessKey,
  });
  assertRendererViewSafe(view);
  assert.deepEqual(summarizeView(view), testCase.expected, `view fixture ${testCase.id}`);
}

for (const testCase of viewFixtures.safetyCases) {
  const payload = { ...testCase.payload };
  if (testCase.injectKey) {
    (payload as Record<string, unknown>)[testCase.injectKey] = "leak";
  }
  if (testCase.expectThrow) {
    assert.throws(() => assertRendererViewSafe(payload), `safety ${testCase.id}`);
  } else {
    assert.doesNotThrow(() => assertRendererViewSafe(payload), `safety ${testCase.id}`);
  }
}

const transitionFixtures = readDesktopPetHostFixture<TransitionFixtureFile>("transition-cases.json");
for (const testCase of transitionFixtures.cases) {
  const settings = normalizeDesktopSettings({
    ...createDefaultDesktopSettings(),
    ...testCase.settings,
  });
  const snapshot = testCase.snapshot as never;
  const notifications = selectNotifications({
    settings,
    snapshot,
    resetBaseline: testCase.resetBaseline,
    appInBackground: testCase.appInBackground,
  });
  const sounds = selectSoundCues({
    settings,
    snapshot,
    resetBaseline: testCase.resetBaseline,
    now: testCase.now,
  });
  assert.deepEqual(
    {
      notifyPresentations: notifications.toNotify.map((item) => item.presentation),
      notifyTransitionIds: notifications.toNotify.map((item) => item.transitionId),
      soundCues: sounds.cues,
      notifiedTransitionIds: notifications.notifiedTransitionIds,
      soundedTransitionIds: sounds.soundedTransitionIds,
    },
    testCase.expected,
    `transition fixture ${testCase.id}`,
  );
}

const bridge = readFileSync(path.join(process.cwd(), "desktop-tauri", "src", "tauri-bridge.ts"), "utf8");
assert.match(bridge, /window\.snailPet/);
assert.match(bridge, /onStateChanged/);
assert.match(bridge, /Object\.freeze/);
assert.doesNotMatch(bridge, /__TAURI_INTERNALS__|__TAURI__/);
assert.match(bridge, /setAccessKey/);
assert.doesNotMatch(bridge, /observerToken|firstMessage/);
assert.doesNotMatch(bridge, /__TAURI_INTERNALS__/);

const buildScript = readFileSync(path.join(process.cwd(), "scripts", "build-desktop-tauri.mjs"), "utf8");
assert.match(buildScript, /desktop\/renderer/);
assert.match(buildScript, /tauri-bridge/);
assert.match(buildScript, /pet-app/);

const rustView = path.join(process.cwd(), "desktop-tauri", "src-tauri", "src", "activity_view.rs");
const rustObserver = path.join(process.cwd(), "desktop-tauri", "src-tauri", "src", "observer_client.rs");
assert.equal(existsSync(rustView), true);
assert.equal(existsSync(rustObserver), true);
assert.doesNotMatch(readFileSync(rustObserver, "utf8"), /std::process::Command|servicePid/);

console.log("smoke-desktop-tauri-view-parity: ok");
