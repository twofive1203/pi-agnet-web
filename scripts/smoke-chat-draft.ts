import assert from "node:assert/strict";
import {
  clearChatDraft,
  getChatDraftStorageKey,
  parseChatDraft,
  readChatDraft,
  writeChatDraft,
} from "../lib/chat-draft";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const storage = new MemoryStorage() as unknown as Storage;
const scope = "session:abc/中文";

assert.match(getChatDraftStorageKey(scope), /^pi-web:chat-draft:v1:/);
assert.equal(parseChatDraft(null), null);
assert.equal(parseChatDraft("not-json"), null);
assert.equal(parseChatDraft(JSON.stringify({ version: 2, text: "stale", files: [] })), null);

writeChatDraft(storage, scope, {
  text: "Review `components/ChatInput.tsx`",
  files: [{ name: "notes.md", path: "C:/tmp/notes.md", size: 128 }],
});
assert.deepEqual(readChatDraft(storage, scope), {
  text: "Review `components/ChatInput.tsx`",
  files: [{ name: "notes.md", path: "C:/tmp/notes.md", size: 128 }],
});

writeChatDraft(storage, scope, { text: "", files: [] });
assert.equal(readChatDraft(storage, scope), null, "empty drafts should remove persisted state");

writeChatDraft(storage, scope, { text: "restored", files: [] });
clearChatDraft(storage, scope);
assert.equal(readChatDraft(storage, scope), null);

console.log("chat draft smoke passed");
