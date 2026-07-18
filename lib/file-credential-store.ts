/**
 * File-backed CredentialStore for ~/.pi/agent/auth.json.
 *
 * pi-coding-agent 0.80.10 no longer exports AuthStorage. The SDK still uses the
 * same auth.json shape via an internal store; this module owns the same file
 * contract for pi-web routes that need direct credential read/write.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8" as const, mode: 0o600 };

type AuthStorageData = Record<string, Credential>;

function defaultAuthPath(): string {
  return join(getAgentDir(), "auth.json");
}

function parseStorageData(content: string | undefined): AuthStorageData {
  if (!content) return {};
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as AuthStorageData;
  } catch {
    return {};
  }
}

function ensureParentDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Process-local serialization for auth.json mutations.
 * Cross-process locking is best-effort; the SDK owns its own lock for its store.
 */
const writeChains = new Map<string, Promise<unknown>>();

function enqueue<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  writeChains.set(
    path,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export class FileCredentialStore implements CredentialStore {
  private readonly authPath: string;
  private data: AuthStorageData = {};

  constructor(authPath = defaultAuthPath()) {
    this.authPath = authPath;
    this.reload();
  }

  static create(authPath?: string): FileCredentialStore {
    return new FileCredentialStore(authPath ?? defaultAuthPath());
  }

  reload(): void {
    try {
      if (!existsSync(this.authPath)) {
        this.data = {};
        return;
      }
      this.data = parseStorageData(readFileSync(this.authPath, "utf-8"));
    } catch {
      // Keep last good snapshot on read failures.
    }
  }

  async read(providerId: string): Promise<Credential | undefined> {
    this.reload();
    return this.data[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    this.reload();
    return Object.entries(this.data).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return enqueue(this.authPath, async () => {
      this.reload();
      const current = this.data[providerId];
      const next = await fn(current);
      if (next === undefined) return current;

      const merged: AuthStorageData = { ...this.data, [providerId]: next };
      this.persist(merged);
      this.data = merged;
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await enqueue(this.authPath, async () => {
      this.reload();
      if (!(providerId in this.data)) return;
      const merged = { ...this.data };
      delete merged[providerId];
      this.persist(merged);
      this.data = merged;
    });
  }

  /** Synchronous snapshot read used by multi-account helpers. */
  get(providerId: string): Credential | undefined {
    this.reload();
    return this.data[providerId];
  }

  has(providerId: string): boolean {
    return this.get(providerId) !== undefined;
  }

  private persist(data: AuthStorageData): void {
    ensureParentDir(this.authPath);
    writeFileSync(this.authPath, JSON.stringify(data, null, 2), AUTH_FILE_WRITE_OPTIONS);
    try {
      chmodSync(this.authPath, 0o600);
    } catch {
      // Windows may not support chmod the same way; ignore.
    }
  }
}
