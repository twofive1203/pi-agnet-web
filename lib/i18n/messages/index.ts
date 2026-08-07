import type { Locale, MessageTree } from "../types";
import { appEn, appZh } from "./app";
import { automationEn, automationZh } from "./automation";
import { chatEn, chatZh } from "./chat";
import { commonEn, commonZh } from "./common";
import { errorsEn, errorsZh } from "./errors";
import { gitEn, gitZh } from "./git";
import { panelsEn, panelsZh } from "./panels";
import { settingsEn, settingsZh } from "./settings";
import { sidebarEn, sidebarZh } from "./sidebar";
import { workflowEn, workflowZh } from "./workflow";

export const zhMessages = {
  common: commonZh,
  app: appZh,
  sidebar: sidebarZh,
  chat: chatZh,
  git: gitZh,
  panels: panelsZh,
  workflow: workflowZh,
  settings: settingsZh,
  automation: automationZh,
  errors: errorsZh,
} as const satisfies MessageTree;

export const enMessages = {
  common: commonEn,
  app: appEn,
  sidebar: sidebarEn,
  chat: chatEn,
  git: gitEn,
  panels: panelsEn,
  workflow: workflowEn,
  settings: settingsEn,
  automation: automationEn,
  errors: errorsEn,
} as const satisfies MessageTree;

export const messagesByLocale: Record<Locale, MessageTree> = {
  zh: zhMessages,
  en: enMessages,
};
