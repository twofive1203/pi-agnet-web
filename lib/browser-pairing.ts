/**
 * Installation pairing helpers: one-time codes, verifiers, challenge-response.
 * Pairing grants installation trust only — never tab authorization.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  BrowserControlError,
  DEFAULT_BROWSER_BRIDGE_PORT,
  DEFAULT_PAIRING_TTL_MS,
  type InstallationCredentialRecord,
  type PairingOffer,
  isRecord,
} from "./browser-protocol";

export type BrowserBridgePersistedState = {
  version: 1;
  port: number;
  enabled: boolean;
  installations: InstallationCredentialRecord[];
  pendingPairing: null | {
    codeHash: string;
    salt: string;
    expiresAt: number;
    createdAt: number;
  };
};

export type IssuedPairingCode = PairingOffer & {
  /** plaintext code — show once to the user; never persist */
  pairingCode: string;
};

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function getStatePath(agentDir = getAgentDir()): string {
  return join(agentDir, "browser-bridge.json");
}

function emptyState(port = DEFAULT_BROWSER_BRIDGE_PORT): BrowserBridgePersistedState {
  return {
    version: 1,
    port,
    enabled: false,
    installations: [],
    pendingPairing: null,
  };
}

function hashWithSalt(value: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${value}`).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function randomCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  // Format as ABCD-EFGH for human transfer.
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function readBrowserBridgeState(agentDir = getAgentDir()): BrowserBridgePersistedState {
  const path = getStatePath(agentDir);
  if (!existsSync(path)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(raw) || raw.version !== 1) return emptyState();
    const installations = Array.isArray(raw.installations)
      ? raw.installations.filter((item): item is InstallationCredentialRecord => {
        if (!isRecord(item)) return false;
        return typeof item.clientId === "string"
          && typeof item.secretVerifier === "string"
          && typeof item.createdAt === "number";
      })
      : [];
    const pending = isRecord(raw.pendingPairing)
      && typeof raw.pendingPairing.codeHash === "string"
      && typeof raw.pendingPairing.salt === "string"
      && typeof raw.pendingPairing.expiresAt === "number"
      && typeof raw.pendingPairing.createdAt === "number"
      ? {
        codeHash: raw.pendingPairing.codeHash,
        salt: raw.pendingPairing.salt,
        expiresAt: raw.pendingPairing.expiresAt,
        createdAt: raw.pendingPairing.createdAt,
      }
      : null;
    return {
      version: 1,
      port: typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536
        ? raw.port
        : DEFAULT_BROWSER_BRIDGE_PORT,
      enabled: raw.enabled === true,
      installations,
      pendingPairing: pending,
    };
  } catch {
    return emptyState();
  }
}

export function writeBrowserBridgeState(state: BrowserBridgePersistedState, agentDir = getAgentDir()): void {
  const path = getStatePath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function setBrowserBridgeEnabled(enabled: boolean, agentDir = getAgentDir()): BrowserBridgePersistedState {
  const state = readBrowserBridgeState(agentDir);
  state.enabled = enabled;
  writeBrowserBridgeState(state, agentDir);
  return state;
}

export function setBrowserBridgePort(port: number, agentDir = getAgentDir()): BrowserBridgePersistedState {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BrowserControlError("INVALID_FRAME", "Invalid bridge port");
  }
  const state = readBrowserBridgeState(agentDir);
  state.port = port;
  writeBrowserBridgeState(state, agentDir);
  return state;
}

export function issuePairingCode(options?: {
  ttlMs?: number;
  port?: number;
  agentDir?: string;
  now?: number;
}): IssuedPairingCode {
  const agentDir = options?.agentDir ?? getAgentDir();
  const now = options?.now ?? Date.now();
  const state = readBrowserBridgeState(agentDir);
  if (!state.enabled) {
    // Issuing a code implicitly acknowledges the feature is being used; keep disabled
    // flag as-is so settings remain source of truth. Callers should enable first.
  }
  const pairingCode = randomCode(8);
  const salt = randomBytes(16).toString("hex");
  const codeHash = hashWithSalt(normalizePairingCode(pairingCode), salt);
  const expiresAt = now + (options?.ttlMs ?? DEFAULT_PAIRING_TTL_MS);
  state.pendingPairing = { codeHash, salt, expiresAt, createdAt: now };
  if (options?.port) state.port = options.port;
  writeBrowserBridgeState(state, agentDir);
  return {
    pairingCode,
    expiresAt,
    port: state.port,
    host: "127.0.0.1",
  };
}

export function normalizePairingCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export type PairingExchangeResult = {
  clientId: string;
  /** installation secret — return once; extension stores it */
  installationSecret: string;
  port: number;
  host: "127.0.0.1";
  protocolVersion: 1;
};

export function exchangePairingCode(input: {
  pairingCode: string;
  extensionOrigin?: string;
  label?: string;
  agentDir?: string;
  now?: number;
}): PairingExchangeResult {
  const agentDir = input.agentDir ?? getAgentDir();
  const now = input.now ?? Date.now();
  const state = readBrowserBridgeState(agentDir);
  const pending = state.pendingPairing;
  if (!pending) throw new BrowserControlError("PAIRING_INVALID", "No pending pairing code");
  if (pending.expiresAt <= now) {
    state.pendingPairing = null;
    writeBrowserBridgeState(state, agentDir);
    throw new BrowserControlError("PAIRING_EXPIRED", "Pairing code expired");
  }
  const normalized = normalizePairingCode(input.pairingCode);
  const candidate = hashWithSalt(normalized, pending.salt);
  if (!safeEqualHex(candidate, pending.codeHash)) {
    throw new BrowserControlError("PAIRING_INVALID", "Pairing code mismatch");
  }

  const clientId = randomId("ext");
  const installationSecret = randomSecret();
  const secretSalt = randomBytes(16).toString("hex");
  const secretVerifier = `${secretSalt}:${hashWithSalt(installationSecret, secretSalt)}`;

  state.installations = state.installations.filter((item) => item.clientId !== clientId);
  state.installations.push({
    clientId,
    secretVerifier,
    createdAt: now,
    label: input.label,
    extensionOrigin: input.extensionOrigin,
  });
  // one-time code
  state.pendingPairing = null;
  writeBrowserBridgeState(state, agentDir);

  return {
    clientId,
    installationSecret,
    port: state.port,
    host: "127.0.0.1",
    protocolVersion: 1,
  };
}

export function unpairInstallation(clientId: string, agentDir = getAgentDir()): boolean {
  const state = readBrowserBridgeState(agentDir);
  const before = state.installations.length;
  state.installations = state.installations.filter((item) => item.clientId !== clientId);
  writeBrowserBridgeState(state, agentDir);
  return state.installations.length < before;
}

export function unpairAll(agentDir = getAgentDir()): number {
  const state = readBrowserBridgeState(agentDir);
  const count = state.installations.length;
  state.installations = [];
  state.pendingPairing = null;
  writeBrowserBridgeState(state, agentDir);
  return count;
}

export function getInstallation(clientId: string, agentDir = getAgentDir()): InstallationCredentialRecord | null {
  return readBrowserBridgeState(agentDir).installations.find((item) => item.clientId === clientId) ?? null;
}

export function verifyInstallationSecret(
  clientId: string,
  installationSecret: string,
  agentDir = getAgentDir(),
): boolean {
  const installation = getInstallation(clientId, agentDir);
  if (!installation) return false;
  const [salt, expected] = installation.secretVerifier.split(":");
  if (!salt || !expected) return false;
  const actual = hashWithSalt(installationSecret, salt);
  return safeEqualHex(actual, expected);
}

/** Server nonce challenge for WebSocket auth (secret never sent as bearer). */
export function createConnectionChallenge(nonce = randomBytes(24).toString("base64url")): {
  nonce: string;
  expiresAt: number;
} {
  return { nonce, expiresAt: Date.now() + 60_000 };
}

export function computeChallengeResponse(installationSecret: string, nonce: string): string {
  return createHash("sha256").update(`snail-pi-browser-v1:${nonce}:${installationSecret}`).digest("hex");
}

export function verifyChallengeResponse(input: {
  clientId: string;
  nonce: string;
  response: string;
  agentDir?: string;
}): boolean {
  const installation = getInstallation(input.clientId, input.agentDir);
  if (!installation) return false;
  // We only store verifier, not secret — challenge must be verified by extension proving secret.
  // During handshake the extension sends response derived from secret; server cannot recompute
  // without secret. Therefore handshake exchanges a short-lived proof using a pairing-established
  // session key derived at connect time:
  // Extension sends: { clientId, nonce, response } where response = HMAC-like hash(secret, nonce).
  // Server stores only verifier, so we accept a second form: extension also sends secret proof
  // by re-hashing through a one-time connect token issued after secret verification over HTTPS loopback.
  //
  // Practical v1 approach: REST /api/browser/connect-token verifies secret and issues a short-lived
  // connect token; WS handshake presents that token. See issueConnectToken/verifyConnectToken.
  void input;
  return false;
}

type ConnectTokenRecord = {
  clientId: string;
  tokenHash: string;
  expiresAt: number;
};

declare global {
  var __piBrowserConnectTokens: Map<string, ConnectTokenRecord> | undefined;
}

function getConnectTokenMap(): Map<string, ConnectTokenRecord> {
  if (!globalThis.__piBrowserConnectTokens) {
    globalThis.__piBrowserConnectTokens = new Map();
  }
  return globalThis.__piBrowserConnectTokens;
}

export function issueConnectToken(input: {
  clientId: string;
  installationSecret: string;
  agentDir?: string;
  ttlMs?: number;
}): { connectToken: string; expiresAt: number; nonce: string } {
  if (!verifyInstallationSecret(input.clientId, input.installationSecret, input.agentDir)) {
    throw new BrowserControlError("AUTH_FAILED", "Invalid installation credentials");
  }
  const connectToken = randomBytes(32).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const expiresAt = Date.now() + (input.ttlMs ?? 60_000);
  const tokenHash = createHash("sha256").update(connectToken).digest("hex");
  getConnectTokenMap().set(input.clientId, { clientId: input.clientId, tokenHash, expiresAt });
  // Attach nonce in map via composite — store as tokenHash|nonce in a side structure.
  getConnectTokenMap().set(`${input.clientId}:nonce`, {
    clientId: input.clientId,
    tokenHash: nonce,
    expiresAt,
  });
  return { connectToken, expiresAt, nonce };
}

export function verifyConnectHandshake(input: {
  clientId: string;
  connectToken: string;
  nonce: string;
  response: string;
}): boolean {
  const map = getConnectTokenMap();
  const tokenRec = map.get(input.clientId);
  const nonceRec = map.get(`${input.clientId}:nonce`);
  if (!tokenRec || !nonceRec) return false;
  if (tokenRec.expiresAt <= Date.now()) {
    map.delete(input.clientId);
    map.delete(`${input.clientId}:nonce`);
    return false;
  }
  if (nonceRec.tokenHash !== input.nonce) return false;
  const tokenHash = createHash("sha256").update(input.connectToken).digest("hex");
  if (!safeEqualHex(tokenHash, tokenRec.tokenHash)) return false;
  const expected = createHash("sha256")
    .update(`snail-pi-browser-v1:${input.nonce}:${input.connectToken}`)
    .digest("hex");
  if (!safeEqualHex(expected, input.response)) return false;
  // one-time
  map.delete(input.clientId);
  map.delete(`${input.clientId}:nonce`);
  return true;
}

export function listInstallations(agentDir = getAgentDir()): Array<{
  clientId: string;
  createdAt: number;
  label?: string;
  extensionOrigin?: string;
}> {
  return readBrowserBridgeState(agentDir).installations.map((item) => ({
    clientId: item.clientId,
    createdAt: item.createdAt,
    label: item.label,
    extensionOrigin: item.extensionOrigin,
  }));
}
