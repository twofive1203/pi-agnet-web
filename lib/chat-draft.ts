import type { AttachedFile } from "@/lib/types";

const CHAT_DRAFT_VERSION = 1;
const CHAT_DRAFT_STORAGE_PREFIX = "pi-web:chat-draft:v1:";
const MAX_DRAFT_TEXT_LENGTH = 100_000;
const MAX_DRAFT_FILES = 20;
const MAX_FILE_NAME_LENGTH = 512;
const MAX_FILE_PATH_LENGTH = 4_096;

export interface ChatDraft {
  text: string;
  files: AttachedFile[];
}

interface StoredChatDraft extends ChatDraft {
  version: typeof CHAT_DRAFT_VERSION;
  updatedAt: number;
}

export function getChatDraftStorageKey(scope: string): string {
  return `${CHAT_DRAFT_STORAGE_PREFIX}${encodeURIComponent(scope)}`;
}

export function parseChatDraft(raw: string | null): ChatDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredChatDraft>;
    if (value.version !== CHAT_DRAFT_VERSION || typeof value.text !== "string" || !Array.isArray(value.files)) {
      return null;
    }

    const files = value.files
      .filter((file): file is AttachedFile => Boolean(
        file
        && typeof file.name === "string"
        && typeof file.path === "string"
        && typeof file.size === "number"
        && Number.isFinite(file.size)
        && file.size >= 0,
      ))
      .slice(0, MAX_DRAFT_FILES)
      .map((file) => ({
        name: file.name.slice(0, MAX_FILE_NAME_LENGTH),
        path: file.path.slice(0, MAX_FILE_PATH_LENGTH),
        size: file.size,
      }));

    const text = value.text.slice(0, MAX_DRAFT_TEXT_LENGTH);
    return text.trim() || files.length > 0 ? { text, files } : null;
  } catch {
    return null;
  }
}

export function readChatDraft(storage: Storage, scope: string): ChatDraft | null {
  try {
    return parseChatDraft(storage.getItem(getChatDraftStorageKey(scope)));
  } catch {
    return null;
  }
}

export function writeChatDraft(storage: Storage, scope: string, draft: ChatDraft): void {
  const key = getChatDraftStorageKey(scope);
  try {
    if (!draft.text.trim() && draft.files.length === 0) {
      storage.removeItem(key);
      return;
    }

    const normalized = parseChatDraft(JSON.stringify({
      version: CHAT_DRAFT_VERSION,
      updatedAt: Date.now(),
      text: draft.text,
      files: draft.files,
    } satisfies StoredChatDraft));
    if (!normalized) {
      storage.removeItem(key);
      return;
    }

    storage.setItem(key, JSON.stringify({
      version: CHAT_DRAFT_VERSION,
      updatedAt: Date.now(),
      ...normalized,
    } satisfies StoredChatDraft));
  } catch {
    // Draft persistence is best-effort and must never block the Composer.
  }
}

export function clearChatDraft(storage: Storage, scope: string): void {
  try {
    storage.removeItem(getChatDraftStorageKey(scope));
  } catch {
    // Draft persistence is best-effort and must never block the Composer.
  }
}
