import type { MessageParams, MessageTree } from "./types";

/**
 * Resolve a dotted key path inside a nested message tree.
 */
export function resolveMessage(tree: MessageTree, key: string): string | undefined {
  const parts = key.split(".");
  let node: string | MessageTree | undefined = tree;
  for (const part of parts) {
    if (!node || typeof node === "string") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

/**
 * Replace `{name}` placeholders. Missing values become empty string.
 */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === null || value === undefined) return "";
    return String(value);
  });
}

/**
 * Translate a key against the active dictionary, falling back to the fallback
 * dictionary, then to the key itself.
 */
export function translate(
  messages: MessageTree,
  fallback: MessageTree,
  key: string,
  params?: MessageParams,
): string {
  const raw = resolveMessage(messages, key) ?? resolveMessage(fallback, key) ?? key;
  return interpolate(raw, params);
}
