/**
 * Desktop notification selection + thin host adapter (U7).
 *
 * Pure policy first: transition-id dedupe, baseline suppression, settings gates.
 * Actual OS notifications are injected — never required for smoke tests.
 */

import type {
  TaskObserverPresentationState,
  TaskObserverSnapshot,
  TaskObserverTransition,
} from "../../lib/task-observer-types";
import { indexActivitiesByTransitionId } from "./activity-store";
import {
  pushTransitionLru,
  type DesktopNotificationCompletionPolicy,
  type DesktopPetSettings,
} from "./settings-store";

export type NotifiablePresentation = "needs_input" | "blocked" | "ready";

export type DesktopNotificationCandidate = {
  transitionId: string;
  activityId: string;
  taskKey: string;
  title: string;
  projectName: string;
  presentation: NotifiablePresentation;
  /** Relative allowlisted deep link only. */
  deepLink: string;
  body: string;
};

export type NotificationPolicyInput = {
  settings: DesktopPetSettings;
  /** When true, seed notified LRU from current transitions and emit nothing (R25). */
  resetBaseline: boolean;
  /** Used for completion policy "background-only". */
  appInBackground: boolean;
  snapshot: TaskObserverSnapshot | null;
  /**
   * Optional explicit transitions to evaluate. Defaults to snapshot.recentTransitions.
   * On baseline, still seeds from these ids.
   */
  transitions?: readonly TaskObserverTransition[];
};

export type NotificationPolicyResult = {
  toNotify: DesktopNotificationCandidate[];
  /** Updated notifiedTransitionIds LRU (always advanced on baseline + emits). */
  notifiedTransitionIds: string[];
  /** Whether settings.notifiedTransitionIds should be persisted. */
  changed: boolean;
};

const NOTIFIABLE = new Set<string>(["needs_input", "blocked", "ready"]);

export function isNotifiablePresentation(
  value: TaskObserverPresentationState | string,
): value is NotifiablePresentation {
  return NOTIFIABLE.has(value);
}

export function notificationBodyFor(presentation: NotifiablePresentation): string {
  switch (presentation) {
    case "needs_input":
      return "任务需要输入";
    case "blocked":
      return "任务受阻";
    case "ready":
      return "任务已完成";
    default: {
      const _exhaustive: never = presentation;
      return _exhaustive;
    }
  }
}

function completionAllows(
  policy: DesktopNotificationCompletionPolicy,
  appInBackground: boolean,
): boolean {
  if (policy === "never") return false;
  if (policy === "always") return true;
  return appInBackground;
}

function presentationAllowed(
  presentation: NotifiablePresentation,
  settings: DesktopPetSettings,
  appInBackground: boolean,
): boolean {
  if (presentation === "needs_input") return settings.notification.needsInput;
  if (presentation === "blocked") return settings.notification.blocked;
  return completionAllows(settings.notification.completion, appInBackground);
}

/**
 * Select which transitions should raise a system notification.
 * Initial/reset/instance baseline emits none and seeds the notified LRU (R24–R26).
 */
export function selectNotifications(input: NotificationPolicyInput): NotificationPolicyResult {
  const transitions = input.transitions ?? input.snapshot?.recentTransitions ?? [];
  const notified = new Set(input.settings.notifiedTransitionIds);
  let nextNotified = input.settings.notifiedTransitionIds.slice();
  let changed = false;

  if (input.resetBaseline) {
    for (const transition of transitions) {
      const id = transition.transitionId.trim();
      if (!id || notified.has(id)) continue;
      nextNotified = pushTransitionLru(nextNotified, id);
      notified.add(id);
      changed = true;
    }
    // Also baseline activity lastTransitionIds so live rows do not immediately toast.
    if (input.snapshot) {
      for (const project of input.snapshot.projects) {
        for (const activity of project.activities) {
          const id = activity.lastTransitionId.trim();
          if (!id || notified.has(id)) continue;
          nextNotified = pushTransitionLru(nextNotified, id);
          notified.add(id);
          changed = true;
        }
      }
    }
    return { toNotify: [], notifiedTransitionIds: nextNotified, changed };
  }

  const byTransition = indexActivitiesByTransitionId(input.snapshot);
  const toNotify: DesktopNotificationCandidate[] = [];
  const seenEmit = new Set<string>();

  for (const transition of transitions) {
    const id = transition.transitionId.trim();
    if (!id || notified.has(id) || seenEmit.has(id)) continue;
    if (!isNotifiablePresentation(transition.presentation)) continue;
    if (!presentationAllowed(transition.presentation, input.settings, input.appInBackground)) {
      // Still record as seen only when we intentionally suppress by policy? No —
      // policy off means "don't notify", but replay should not notify later if user
      // enables the toggle mid-session for the same historical transition.
      // Seed as notified so enabling later does not flood history.
      nextNotified = pushTransitionLru(nextNotified, id);
      notified.add(id);
      changed = true;
      continue;
    }

    const activity = byTransition.get(id);
    const title = activity?.title?.trim() || transition.taskKey;
    const projectName = activity?.projectName?.trim() || transition.projectKey;
    const deepLink = activity?.deepLink?.trim() || "";

    toNotify.push({
      transitionId: id,
      activityId: transition.activityId,
      taskKey: transition.taskKey,
      title,
      projectName,
      presentation: transition.presentation,
      deepLink,
      body: notificationBodyFor(transition.presentation),
    });
    seenEmit.add(id);
    nextNotified = pushTransitionLru(nextNotified, id);
    notified.add(id);
    changed = true;
  }

  return { toNotify, notifiedTransitionIds: nextNotified, changed };
}

export function applyNotifiedIds(
  settings: DesktopPetSettings,
  notifiedTransitionIds: string[],
): DesktopPetSettings {
  return { ...settings, notifiedTransitionIds };
}

/** Injectable host for OS notifications (Electron Notification). */
export type DesktopNotificationHost = {
  isSupported(): boolean;
  show(candidate: DesktopNotificationCandidate): void;
};

/**
 * Controller that applies pure policy then shows OS notifications when supported.
 * Activity tray remains fully usable when notifications are unsupported/denied (R26).
 */
export class DesktopNotificationController {
  private host: DesktopNotificationHost;
  private appInBackground = true;

  constructor(host?: DesktopNotificationHost) {
    this.host = host ?? {
      isSupported: () => false,
      show: () => undefined,
    };
  }

  setHost(host: DesktopNotificationHost): void {
    this.host = host;
  }

  setAppInBackground(value: boolean): void {
    this.appInBackground = value;
  }

  getAppInBackground(): boolean {
    return this.appInBackground;
  }

  /**
   * Evaluate snapshot transitions and optionally show notifications.
   * Returns settings patch for notified LRU persistence.
   */
  handleSnapshot(input: {
    settings: DesktopPetSettings;
    snapshot: TaskObserverSnapshot | null;
    resetBaseline: boolean;
  }): { settings: DesktopPetSettings; emitted: DesktopNotificationCandidate[] } {
    const result = selectNotifications({
      settings: input.settings,
      snapshot: input.snapshot,
      resetBaseline: input.resetBaseline,
      appInBackground: this.appInBackground,
    });

    if (this.host.isSupported()) {
      for (const candidate of result.toNotify) {
        try {
          this.host.show(candidate);
        } catch {
          // Tray remains the source of truth when OS notify fails.
        }
      }
    }

    const settings = result.changed
      ? applyNotifiedIds(input.settings, result.notifiedTransitionIds)
      : input.settings;
    return { settings, emitted: result.toNotify };
  }
}
