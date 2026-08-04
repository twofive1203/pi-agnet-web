export type BundledPiExtensionId =
  | "pi-subagents"
  | "rpiv-web-tools"
  | "pi-ask-user"
  | "pi-manage-todo-list";

export interface BundledPiExtensionDefinition {
  id: BundledPiExtensionId;
  packageName: string;
  version: string;
  displayName: string;
  description: string;
  defaultEnabled: true;
  extensionEntryPoints: readonly string[];
  skillPaths: readonly string[];
  promptPaths: readonly string[];
}

export const BUNDLED_PI_EXTENSIONS: readonly BundledPiExtensionDefinition[] = [
  {
    id: "pi-subagents",
    packageName: "pi-subagents",
    version: "0.40.0",
    displayName: "Pi Subagents",
    description: "Subagent delegation, chains, parallel runs, prompts, and bundled agent workflows.",
    defaultEnabled: true,
    extensionEntryPoints: ["index.ts"],
    skillPaths: ["skills"],
    promptPaths: ["prompts"],
  },
  {
    id: "rpiv-web-tools",
    packageName: "@juicesharp/rpiv-web-tools",
    version: "2.3.1",
    displayName: "Web Search & Fetch",
    description: "web_search and web_fetch with pluggable hosted and self-hosted providers.",
    defaultEnabled: true,
    extensionEntryPoints: ["index.ts"],
    skillPaths: [],
    promptPaths: [],
  },
  {
    id: "pi-ask-user",
    packageName: "pi-ask-user",
    version: "0.13.1",
    displayName: "Ask User",
    description: "Structured ask_user dialogs bridged to the WebUI.",
    defaultEnabled: true,
    extensionEntryPoints: ["index.ts"],
    skillPaths: ["skills"],
    promptPaths: [],
  },
  {
    id: "pi-manage-todo-list",
    packageName: "pi-manage-todo-list",
    version: "0.4.0",
    displayName: "Manage Todo List",
    description: "manage_todo_list plus the Todo widget shown by Snail Pi Web.",
    defaultEnabled: true,
    extensionEntryPoints: ["src/index.ts"],
    skillPaths: [],
    promptPaths: [],
  },
] as const;

export const DEFAULT_BUNDLED_PI_EXTENSION_ENABLEMENT: Record<BundledPiExtensionId, boolean> =
  Object.fromEntries(BUNDLED_PI_EXTENSIONS.map((extension) => [extension.id, extension.defaultEnabled])) as Record<
    BundledPiExtensionId,
    boolean
  >;
