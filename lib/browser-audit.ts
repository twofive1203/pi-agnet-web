/**
 * Bounded audit metadata for browser control actions.
 * Never stores full page content, screenshots, typed text, or sensitive network bodies.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  MAX_AUDIT_FILE_BYTES,
  MAX_AUDIT_FILE_LINES,
  type BrowserErrorCode,
} from "./browser-protocol";
import { summarizeAuditParams } from "./browser-redaction";

function getAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".pi", "agent");
}

export type BrowserAuditEntry = {
  ts: number;
  sessionId?: string;
  bindingId?: string;
  clientId?: string;
  action: string;
  status: "ok" | "error";
  code?: BrowserErrorCode | string;
  /** already-redacted parameter summary */
  params?: Record<string, unknown>;
};

const MAX_ENTRIES = 500;

declare global {
  var __piBrowserAuditBuffer: BrowserAuditEntry[] | undefined;
}

function getBuffer(): BrowserAuditEntry[] {
  if (!globalThis.__piBrowserAuditBuffer) globalThis.__piBrowserAuditBuffer = [];
  return globalThis.__piBrowserAuditBuffer;
}

function auditPath(agentDir = getAgentDir()): string {
  return join(agentDir, "browser-audit.jsonl");
}

function pruneRotatedAuditBackups(path: string, keepName?: string): void {
  try {
    const dir = dirname(path);
    const base = basename(path);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      // Match both legacy timestamped backups and the single stable .bak.
      if (name === base) continue;
      if (!name.startsWith(`${base}.`) || !name.endsWith(".bak")) continue;
      if (keepName && name === keepName) continue;
      try {
        unlinkSync(join(dir, name));
      } catch {
        // ignore individual delete failures
      }
    }
  } catch {
    // best-effort
  }
}

function rotateAuditFileIfNeeded(path: string): void {
  try {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.size <= MAX_AUDIT_FILE_BYTES) {
      // Also bound by line count for small-but-many entries.
      const text = readFileSync(path, "utf8");
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length <= MAX_AUDIT_FILE_LINES) return;
      const kept = lines.slice(-Math.floor(MAX_AUDIT_FILE_LINES / 2));
      writeFileSync(path, `${kept.join("\n")}\n`, "utf8");
      return;
    }
    // Keep at most one rotated backup file to bound on-disk audit storage.
    const rotatedName = `${basename(path)}.bak`;
    const rotated = join(dirname(path), rotatedName);
    pruneRotatedAuditBackups(path);
    if (existsSync(rotated)) {
      try {
        unlinkSync(rotated);
      } catch {
        // ignore
      }
    }
    renameSync(path, rotated);
    // Keep only the last half of lines from oversized file.
    try {
      const previous = readFileSync(rotated, "utf8").split(/\r?\n/).filter(Boolean);
      const kept = previous.slice(-Math.floor(MAX_AUDIT_FILE_LINES / 2));
      writeFileSync(path, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
    } catch {
      writeFileSync(path, "", "utf8");
    }
    // Ensure no older timestamped backups remain after this rotation.
    pruneRotatedAuditBackups(path, rotatedName);
  } catch {
    // best-effort
  }
}

export function recordBrowserAudit(entry: Omit<BrowserAuditEntry, "ts"> & { ts?: number }): void {
  const safeParams = summarizeAuditParams(entry.params);
  const full: BrowserAuditEntry = {
    ts: entry.ts ?? Date.now(),
    sessionId: entry.sessionId,
    bindingId: entry.bindingId,
    clientId: entry.clientId,
    action: entry.action,
    status: entry.status,
    code: entry.code,
    params: safeParams,
  };
  const buffer = getBuffer();
  buffer.push(full);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
  try {
    const path = auditPath();
    mkdirSync(dirname(path), { recursive: true });
    rotateAuditFileIfNeeded(path);
    appendFileSync(path, `${JSON.stringify(full)}\n`, "utf8");
  } catch {
    // Audit is best-effort.
  }
}

export function listBrowserAudit(limit = 100): BrowserAuditEntry[] {
  const buffer = getBuffer();
  if (buffer.length > 0) return buffer.slice(-limit);

  try {
    const path = auditPath();
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
    const parsed: BrowserAuditEntry[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        parsed.push(JSON.parse(line) as BrowserAuditEntry);
      } catch {
        // skip bad line
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

/** Test helper */
export function resetBrowserAuditForTests(): void {
  globalThis.__piBrowserAuditBuffer = [];
  try {
    const path = auditPath();
    if (existsSync(path)) writeFileSync(path, "", "utf8");
  } catch {
    // ignore
  }
}
