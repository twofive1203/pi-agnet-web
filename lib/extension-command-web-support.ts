/**
 * Classify Pi extension slash commands for Web UI discoverability.
 * Pure TUI overlays that cannot work in snail-pi-web are marked cli-only.
 */

export type ExtensionCommandWebSupport = "full" | "partial" | "cli-only";

export type ExtensionCommandWebMeta = {
  support: ExtensionCommandWebSupport;
  reason: string;
};

/** Exact command names that are TUI-only in the Web UI. */
const CLI_ONLY_EXACT = new Set([
  "slopchop",
  "diff",
  "paste",
  "extension-settings",
  "btw",
  "btw:tangent",
  "btw:new",
  "btw:clear",
  "btw:inject",
  "btw:summarize",
  "btw:model",
  "btw:thinking",
  "spawn",
  "attach",
  "dismiss",
  "intercom",
  "usage",
]);

/** Prefixes (command name starts with) that are TUI-only. */
const CLI_ONLY_PREFIXES = ["btw:"];

/** Commands that partially work (status/widget/notify/dialogs) but lose TUI chrome. */
const PARTIAL_EXACT = new Set([
  "plan",
  "plannotator",
  "ralph",
  "ralph-stop",
  "autoresearch",
  "powerbar",
]);

const REASONS: Record<ExtensionCommandWebSupport, string> = {
  "cli-only": "Requires Pi TUI overlay; use the desktop/CLI Pi client.",
  partial: "Core flow may work in Web; TUI-only chrome is degraded.",
  full: "Supported in the Web UI.",
};

/**
 * Resolve Web support metadata for one slash command name (without leading slash).
 */
export function getExtensionCommandWebSupport(commandName: string): ExtensionCommandWebMeta {
  const name = commandName.trim().replace(/^\//, "");
  if (!name) return { support: "full", reason: REASONS.full };

  if (CLI_ONLY_EXACT.has(name) || CLI_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return { support: "cli-only", reason: REASONS["cli-only"] };
  }
  if (PARTIAL_EXACT.has(name)) {
    return { support: "partial", reason: REASONS.partial };
  }
  return { support: "full", reason: REASONS.full };
}

/**
 * Annotate a command list entry when source is extension.
 */
export function annotateExtensionCommandWebSupport<T extends { name: string; source?: string }>(
  command: T,
): T & { webSupport?: ExtensionCommandWebSupport; webSupportReason?: string } {
  if (command.source !== "extension") return command;
  const meta = getExtensionCommandWebSupport(command.name);
  return {
    ...command,
    webSupport: meta.support,
    webSupportReason: meta.reason,
  };
}
