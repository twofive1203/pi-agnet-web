import type { Locale, MessageTree } from "../types";
import { appEn, appZh } from "./app";
import { chatEn, chatZh } from "./chat";
import { commonEn, commonZh } from "./common";
import { gitEn, gitZh } from "./git";
import { panelsEn, panelsZh } from "./panels";
import { settingsEn, settingsZh } from "./settings";
import { sidebarEn, sidebarZh } from "./sidebar";
import { trellisEn, trellisZh } from "./trellis";
import { workflowEn, workflowZh } from "./workflow";

export const zhMessages = {
  common: commonZh,
  app: appZh,
  sidebar: sidebarZh,
  chat: chatZh,
  git: gitZh,
  panels: panelsZh,
  trellis: trellisZh,
  workflow: workflowZh,
  settings: settingsZh,
} as const satisfies MessageTree;

export const enMessages = {
  common: commonEn,
  app: appEn,
  sidebar: sidebarEn,
  chat: chatEn,
  git: gitEn,
  panels: panelsEn,
  trellis: trellisEn,
  workflow: workflowEn,
  settings: settingsEn,
} as const satisfies MessageTree;

export const messagesByLocale: Record<Locale, MessageTree> = {
  zh: zhMessages,
  en: enMessages,
};
