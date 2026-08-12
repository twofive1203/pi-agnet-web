/**
 * Desktop pet access-key persistence (main-process only).
 *
 * Kept out of desktop-pet-settings.json. Prefer Electron safeStorage encryption;
 * when encryption is unavailable the key stays in memory only (not written).
 */

export const DESKTOP_ACCESS_KEY_FILENAME = "desktop-pet-access-key.json";
export const DESKTOP_ACCESS_KEY_STORE_VERSION = 1 as const;

export type AccessKeyCodec = {
  /** True when encrypt/decrypt round-trips are available for disk persistence. */
  isAvailable(): boolean;
  encrypt(plain: string): string;
  decrypt(blob: string): string;
};

export type AccessKeyFs = {
  readFile(path: string, encoding: "utf8"): string;
  writeFile(path: string, data: string, encoding: "utf8"): void;
  mkdirp(dir: string): void;
  exists(path: string): boolean;
  unlink?(path: string): void;
};

type StoredAccessKeyFile = {
  version: typeof DESKTOP_ACCESS_KEY_STORE_VERSION;
  /** Base64 ciphertext from the codec — never plaintext. */
  ciphertext: string;
};

const MAX_ACCESS_KEY_LENGTH = 512;

export function accessKeyFilePath(userDataDir: string): string {
  const base = userDataDir.replace(/[\\/]+$/, "");
  return `${base}/${DESKTOP_ACCESS_KEY_FILENAME}`.replace(/\\/g, "/");
}

export function normalizeAccessKeyInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key.length > MAX_ACCESS_KEY_LENGTH) return null;
  return key;
}

/** In-memory codec for tests; does not claim disk encryption. */
export function createMemoryAccessKeyCodec(): AccessKeyCodec {
  return {
    isAvailable: () => false,
    encrypt: (plain) => plain,
    decrypt: (blob) => blob,
  };
}

/**
 * Electron safeStorage-backed codec. When encryption is unavailable, isAvailable()
 * is false so callers keep the key in memory only.
 */
export function createSafeStorageAccessKeyCodec(safeStorage: {
  isEncryptionAvailable: () => boolean;
  encryptString: (plain: string) => Buffer;
  decryptString: (blob: Buffer) => string;
}): AccessKeyCodec {
  return {
    isAvailable: () => {
      try {
        return safeStorage.isEncryptionAvailable() === true;
      } catch {
        return false;
      }
    },
    encrypt: (plain) => {
      const buf = safeStorage.encryptString(plain);
      return Buffer.from(buf).toString("base64");
    },
    decrypt: (blob) => {
      const buf = Buffer.from(blob, "base64");
      return safeStorage.decryptString(buf);
    },
  };
}

export function loadDesktopAccessKey(
  userDataDir: string,
  fs: AccessKeyFs,
  codec: AccessKeyCodec,
): string | null {
  if (!codec.isAvailable()) return null;
  const filePath = accessKeyFilePath(userDataDir);
  try {
    if (!fs.exists(filePath)) return null;
    const raw = JSON.parse(fs.readFile(filePath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Partial<StoredAccessKeyFile>;
    if (record.version !== DESKTOP_ACCESS_KEY_STORE_VERSION) return null;
    if (typeof record.ciphertext !== "string" || !record.ciphertext.trim()) return null;
    const plain = codec.decrypt(record.ciphertext.trim());
    return normalizeAccessKeyInput(plain);
  } catch {
    return null;
  }
}

export function saveDesktopAccessKey(
  userDataDir: string,
  accessKey: string,
  fs: AccessKeyFs,
  codec: AccessKeyCodec,
): { persisted: boolean } {
  const key = normalizeAccessKeyInput(accessKey);
  if (!key) {
    clearDesktopAccessKey(userDataDir, fs);
    return { persisted: false };
  }
  if (!codec.isAvailable()) {
    return { persisted: false };
  }
  const filePath = accessKeyFilePath(userDataDir);
  const dir = filePath.replace(/\/[^/]+$/, "");
  fs.mkdirp(dir);
  const payload: StoredAccessKeyFile = {
    version: DESKTOP_ACCESS_KEY_STORE_VERSION,
    ciphertext: codec.encrypt(key),
  };
  fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { persisted: true };
}

export function clearDesktopAccessKey(userDataDir: string, fs: AccessKeyFs): void {
  const filePath = accessKeyFilePath(userDataDir);
  try {
    if (!fs.exists(filePath)) return;
    if (typeof fs.unlink === "function") {
      fs.unlink(filePath);
      return;
    }
    fs.writeFile(filePath, "", "utf8");
  } catch {
    // best effort
  }
}
