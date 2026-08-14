/**
 * System tray menu model + controller hooks (U7).
 *
 * Tray always offers: Show pet, Disable click-through, Retry, Open WebUI, Quit (R13).
 * Quit never warns about interrupting tasks — the pet cannot stop them (AE10).
 */

import type { TaskObserverPresentationState } from "../../lib/task-observer-types";
import { petStateLabel } from "../renderer/pet-state";
import type { DesktopConnectionStatus } from "./connection-state";

export type TrayMenuAction =
  | "show-pet"
  | "disable-click-through"
  | "toggle-dnd"
  | "retry"
  | "open-webui"
  | "copy-start-command"
  | "quit";

export type TrayMenuItem = {
  id: TrayMenuAction | "status" | "separator";
  label: string;
  enabled: boolean;
  type: "normal" | "separator";
  /** Electron checkbox menu state (DND toggle). */
  checked?: boolean;
};

export type TrayMenuModelInput = {
  presentation: TaskObserverPresentationState;
  connectionStatus: DesktopConnectionStatus;
  clickThrough: boolean;
  dndEnabled: boolean;
  activeCount: number;
  attentionCount: number;
  canCopyStartCommand: boolean;
  startCommand: string;
};

export function buildTrayTooltip(input: {
  presentation: TaskObserverPresentationState;
  activeCount: number;
  attentionCount: number;
}): string {
  const label = petStateLabel(input.presentation);
  const parts = [`蜗牛派桌宠 · ${label}`];
  if (input.activeCount > 0) parts.push(`活动 ${input.activeCount}`);
  if (input.attentionCount > 0) parts.push(`需关注 ${input.attentionCount}`);
  return parts.join(" · ");
}

/**
 * Build a stable tray context menu model (pure).
 * Host maps ids to Electron Menu clicks.
 */
export function buildTrayMenuModel(input: TrayMenuModelInput): TrayMenuItem[] {
  const statusLabel = (() => {
    if (input.connectionStatus === "service-not-running") return "状态：蜗牛派服务未启动";
    if (input.connectionStatus === "incompatible") return "状态：服务不兼容";
    if (input.connectionStatus === "reconnecting") return "状态：重连中";
    if (input.connectionStatus === "probing") return "状态：探测中";
    return `状态：${petStateLabel(input.presentation)}`;
  })();

  const items: TrayMenuItem[] = [
    { id: "status", label: statusLabel, enabled: false, type: "normal" },
    { id: "separator", label: "", enabled: false, type: "separator" },
    { id: "show-pet", label: "显示桌宠", enabled: true, type: "normal" },
    {
      id: "disable-click-through",
      label: "取消鼠标穿透",
      enabled: input.clickThrough,
      type: "normal",
    },
    {
      id: "toggle-dnd",
      label: "勿扰模式",
      enabled: true,
      type: "normal",
      checked: input.dndEnabled,
    },
    { id: "separator", label: "", enabled: false, type: "separator" },
    { id: "retry", label: "重试连接", enabled: true, type: "normal" },
    { id: "open-webui", label: "打开 WebUI", enabled: true, type: "normal" },
  ];

  if (input.canCopyStartCommand) {
    items.push({
      id: "copy-start-command",
      label: `复制启动命令 (${input.startCommand})`,
      enabled: true,
      type: "normal",
    });
  }

  items.push(
    { id: "separator", label: "", enabled: false, type: "separator" },
    {
      id: "quit",
      label: "退出桌宠",
      enabled: true,
      type: "normal",
    },
  );

  return items;
}

export type TrayHost = {
  setToolTip(text: string): void;
  setMenu(items: TrayMenuItem[]): void;
  dispose(): void;
};

export type TrayActionHandlers = {
  onAction: (action: TrayMenuAction) => void;
};

/** Pure: map menu id to action (ignores status/separator). */
export function trayItemToAction(id: TrayMenuItem["id"]): TrayMenuAction | null {
  switch (id) {
    case "show-pet":
    case "disable-click-through":
    case "toggle-dnd":
    case "retry":
    case "open-webui":
    case "copy-start-command":
    case "quit":
      return id;
    default:
      return null;
  }
}

/**
 * Quit label contract: must not imply task interruption.
 */
export function assertQuitLabelSafe(label: string): void {
  const lower = label.toLowerCase();
  if (
    lower.includes("中断") ||
    lower.includes("interrupt") ||
    lower.includes("stop task") ||
    lower.includes("停止任务")
  ) {
    throw new Error("quit label must not warn about task interruption");
  }
}
