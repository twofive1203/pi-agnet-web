/**
 * Pure multi-tab session coordination smoke (no browser, no BroadcastChannel).
 */
import assert from "node:assert/strict";
import {
  applySessionTabMessage,
  buildSessionTabMessage,
  createSessionTabId,
  isSessionTabMessage,
  pruneStaleSessionTabPeers,
  resolveSessionTabRole,
  sessionTabChannelName,
  summarizeSessionTabPresence,
  type SessionTabPeer,
} from "../lib/session-tab-coordination";

function main() {
  assert.match(sessionTabChannelName("abc/def"), /pi-web:session-tab:v1:/);
  assert.notEqual(createSessionTabId(1), createSessionTabId(2));

  const hello = buildSessionTabMessage({
    type: "hello",
    sessionId: "s1",
    tabId: "tab_b",
  });
  assert.equal(isSessionTabMessage(hello), true);
  assert.equal(isSessionTabMessage({ type: "hello" }), false);

  // Simultaneous open: lexicographic election among live ids.
  let peers = new Map<string, SessionTabPeer>();
  peers = applySessionTabMessage(peers, hello, { localTabId: "tab_a" });
  const dual = resolveSessionTabRole({ localTabId: "tab_a", peers });
  assert.equal(dual.writerTabId, "tab_a");
  assert.equal(dual.role, "writer");

  const dualB = resolveSessionTabRole({ localTabId: "tab_b", peers: [
    { tabId: "tab_a", role: "reader", lastSeen: Date.now() },
  ] });
  // tab_a < tab_b lexicographically → tab_b is reader
  assert.equal(dualB.role, "reader");
  assert.equal(dualB.writerTabId, "tab_a");

  // Existing writer heartbeat keeps second tab read-only.
  peers = applySessionTabMessage(
    new Map(),
    buildSessionTabMessage({
      type: "heartbeat",
      sessionId: "s1",
      tabId: "tab_writer",
      role: "writer",
    }),
    { localTabId: "tab_reader" },
  );
  const reader = resolveSessionTabRole({ localTabId: "tab_reader", peers });
  assert.equal(reader.role, "reader");
  assert.equal(reader.writerTabId, "tab_writer");

  // Takeover claim forces local writer and demotes peers.
  peers = applySessionTabMessage(
    peers,
    buildSessionTabMessage({
      type: "claim_write",
      sessionId: "s1",
      tabId: "tab_reader",
    }),
    { localTabId: "tab_other" },
  );
  const afterClaim = resolveSessionTabRole({
    localTabId: "tab_reader",
    peers,
    localClaimsWrite: true,
  });
  assert.equal(afterClaim.role, "writer");
  assert.equal(afterClaim.writerTabId, "tab_reader");

  const demoted = resolveSessionTabRole({
    localTabId: "tab_writer",
    peers,
    localClaimsWrite: false,
  });
  assert.equal(demoted.role, "reader");
  assert.equal(demoted.writerTabId, "tab_reader");

  // Stale peers are pruned.
  const staleMap = new Map<string, SessionTabPeer>([
    ["old", { tabId: "old", role: "writer", lastSeen: 0 }],
    ["fresh", { tabId: "fresh", role: "reader", lastSeen: 10_000 }],
  ]);
  const pruned = pruneStaleSessionTabPeers(staleMap, { now: 10_000, staleMs: 6_000 });
  assert.equal(pruned.has("old"), false);
  assert.equal(pruned.has("fresh"), true);

  const presence = summarizeSessionTabPresence({
    sessionId: "s1",
    localTabId: "tab_reader",
    peers,
    localClaimsWrite: true,
  });
  assert.equal(presence.hasOtherTabs, true);
  assert.equal(presence.role, "writer");

  // bye removes peer
  peers = applySessionTabMessage(
    peers,
    buildSessionTabMessage({ type: "bye", sessionId: "s1", tabId: "tab_reader" }),
    { localTabId: "tab_writer" },
  );
  assert.equal(peers.has("tab_reader"), false);

  // Source contract: ChatWindow/ChatInput wire the lock.
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const root = path.resolve(__dirname, "..");
  const chatWindow = fs.readFileSync(path.join(root, "components/ChatWindow.tsx"), "utf8");
  const chatInput = fs.readFileSync(path.join(root, "components/ChatInput.tsx"), "utf8");
  assert.match(chatWindow, /useSessionTabLock/);
  assert.match(chatWindow, /multiTabBanner/);
  assert.match(chatWindow, /takeOverWrite/);
  assert.match(chatInput, /writeLocked/);
  assert.match(chatInput, /multiTabWriteLocked/);

  console.log("session tab coordination smoke checks passed");
}

main();
