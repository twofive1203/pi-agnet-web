/**
 * npm public-registry latest-version checks for the empty-session version row.
 *
 * Compares the running web (spi) and pi SDK versions against registry.npmjs.org
 * with a short in-process cache so the empty state can show a quiet update dot
 * without hammering the network on every new-session render.
 */

export const SPI_NPM_PACKAGE = "@twofive/snail-pi-web";
export const PI_NPM_PACKAGE = "@earendil-works/pi-coding-agent";

export type PackageUpdateKey = "web" | "pi";

export interface PackageVersionStatus {
  key: PackageUpdateKey;
  /** npm package name queried. */
  packageName: string;
  /** Running/local version baked into the WebUI build. */
  current: string;
  /** Latest dist-tag from the public registry, or null when unknown. */
  latest: string | null;
  updateAvailable: boolean;
  /** Present when the registry lookup failed or was skipped. */
  error?: string;
}

export interface PackageUpdateCheckResult {
  web: PackageVersionStatus;
  pi: PackageVersionStatus;
  checkedAt: number;
  /** True when the payload was served from the in-process cache. */
  cached: boolean;
}

interface CachedNpmLatest {
  version: string | null;
  error?: string;
  fetchedAt: number;
}

const SUCCESS_TTL_MS = 60 * 60 * 1000;
const ERROR_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4_000;

declare global {
  var __piPackageUpdateCache: Map<string, CachedNpmLatest> | undefined;
}

function getCache(): Map<string, CachedNpmLatest> {
  if (!globalThis.__piPackageUpdateCache) {
    globalThis.__piPackageUpdateCache = new Map();
  }
  return globalThis.__piPackageUpdateCache;
}

/** Test helper: clear the in-process npm-latest cache. */
export function clearPackageUpdateCache(): void {
  getCache().clear();
}

/**
 * Parse a loose npm version into numeric core parts.
 * Strips a leading `v`, ignores build metadata, and drops prerelease labels
 * after the core so `1.2.3-beta` compares as `1.2.3` for update hints only.
 */
export function parseVersionParts(raw: string): number[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withoutBuild = trimmed.startsWith("v") || trimmed.startsWith("V")
    ? trimmed.slice(1)
    : trimmed;
  const core = withoutBuild.split("-")[0]?.split("+")[0] ?? "";
  if (!core) return null;
  const parts = core.split(".");
  if (parts.length === 0 || parts.some((part) => part === "" || !/^\d+$/.test(part))) {
    return null;
  }
  return parts.map((part) => Number(part));
}

/**
 * Compare two loose versions.
 * Returns 1 when `a > b`, -1 when `a < b`, 0 when equal or either side is unparsable.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  if (!left || !right) return 0;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

export function isUpdateAvailable(current: string, latest: string | null | undefined): boolean {
  if (!latest) return false;
  return compareVersions(latest, current) > 0;
}

function registryLatestUrl(packageName: string): string {
  // Scoped packages must be one encoded path segment: @scope%2Fname
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
}

async function fetchNpmLatest(
  packageName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CachedNpmLatest> {
  const cache = getCache();
  const now = Date.now();
  const hit = cache.get(packageName);
  if (hit) {
    const ttl = hit.error ? ERROR_TTL_MS : SUCCESS_TTL_MS;
    if (now - hit.fetchedAt < ttl) return hit;
  }

  try {
    const response = await fetchImpl(registryLatestUrl(packageName), {
      method: "GET",
      headers: {
        Accept: "application/json",
        // Identify the product lightly; helps operators diagnose registry blocks.
        "User-Agent": "snail-pi-web-version-check",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) {
      const entry: CachedNpmLatest = {
        version: null,
        error: `registry HTTP ${response.status}`,
        fetchedAt: now,
      };
      cache.set(packageName, entry);
      return entry;
    }
    const body = (await response.json()) as { version?: unknown };
    const version = typeof body.version === "string" && body.version.trim()
      ? body.version.trim()
      : null;
    const entry: CachedNpmLatest = {
      version,
      error: version ? undefined : "missing version field",
      fetchedAt: now,
    };
    cache.set(packageName, entry);
    return entry;
  } catch (error) {
    const entry: CachedNpmLatest = {
      version: null,
      error: error instanceof Error ? error.message : String(error),
      fetchedAt: now,
    };
    cache.set(packageName, entry);
    return entry;
  }
}

function toStatus(
  key: PackageUpdateKey,
  packageName: string,
  current: string,
  latestEntry: CachedNpmLatest,
): PackageVersionStatus {
  const latest = latestEntry.version;
  return {
    key,
    packageName,
    current,
    latest,
    updateAvailable: isUpdateAvailable(current, latest),
    ...(latestEntry.error ? { error: latestEntry.error } : {}),
  };
}

export interface CheckPackageUpdatesOptions {
  webCurrent?: string;
  piCurrent?: string;
  fetchImpl?: typeof fetch;
  /** When true, always hit the registry (still writes the shared cache). */
  forceRefresh?: boolean;
}

/**
 * Resolve current vs latest versions for web/spi and the bundled pi SDK.
 * Failures never throw — callers always get a structured payload.
 */
export async function checkPackageUpdates(
  options: CheckPackageUpdatesOptions = {},
): Promise<PackageUpdateCheckResult> {
  const webCurrent = (options.webCurrent
    ?? process.env.NEXT_PUBLIC_APP_VERSION
    ?? "0.0.0").trim() || "0.0.0";
  const piCurrent = (options.piCurrent
    ?? process.env.NEXT_PUBLIC_PI_VERSION
    ?? "0.0.0").trim() || "0.0.0";
  const fetchImpl = options.fetchImpl ?? fetch;

  if (options.forceRefresh) {
    getCache().delete(SPI_NPM_PACKAGE);
    getCache().delete(PI_NPM_PACKAGE);
  }

  const cache = getCache();
  const beforeWeb = cache.get(SPI_NPM_PACKAGE);
  const beforePi = cache.get(PI_NPM_PACKAGE);
  const now = Date.now();
  const stillFresh = (entry: CachedNpmLatest | undefined): boolean => {
    if (!entry) return false;
    const ttl = entry.error ? ERROR_TTL_MS : SUCCESS_TTL_MS;
    return now - entry.fetchedAt < ttl;
  };
  const cached = stillFresh(beforeWeb) && stillFresh(beforePi);

  const [webLatest, piLatest] = await Promise.all([
    fetchNpmLatest(SPI_NPM_PACKAGE, fetchImpl),
    fetchNpmLatest(PI_NPM_PACKAGE, fetchImpl),
  ]);

  return {
    web: toStatus("web", SPI_NPM_PACKAGE, webCurrent, webLatest),
    pi: toStatus("pi", PI_NPM_PACKAGE, piCurrent, piLatest),
    checkedAt: Date.now(),
    cached,
  };
}
