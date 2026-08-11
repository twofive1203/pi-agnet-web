/**
 * Pure smoke for npm package update-check helpers (no live registry I/O).
 *
 * Usage: npx tsx scripts/smoke-package-update-check.ts
 */
import assert from "node:assert/strict";
import {
  checkPackageUpdates,
  clearPackageUpdateCache,
  compareVersions,
  isUpdateAvailable,
  parseVersionParts,
  PI_NPM_PACKAGE,
  SPI_NPM_PACKAGE,
} from "../lib/package-update-check";

function section(name: string): void {
  console.log(`\n== ${name} ==`);
}

section("parseVersionParts");
assert.deepEqual(parseVersionParts("1.2.3"), [1, 2, 3]);
assert.deepEqual(parseVersionParts("v0.9.11"), [0, 9, 11]);
assert.deepEqual(parseVersionParts("1.2.3-beta.1"), [1, 2, 3]);
assert.equal(parseVersionParts(""), null);
assert.equal(parseVersionParts("not-a-version"), null);

section("compareVersions / isUpdateAvailable");
assert.equal(compareVersions("0.9.12", "0.9.11"), 1);
assert.equal(compareVersions("0.9.11", "0.9.12"), -1);
assert.equal(compareVersions("0.84.1", "0.84.1"), 0);
assert.equal(compareVersions("1.0", "1.0.0"), 0);
assert.equal(compareVersions("bad", "1.0.0"), 0);
assert.equal(isUpdateAvailable("0.9.11", "0.9.12"), true);
assert.equal(isUpdateAvailable("0.9.12", "0.9.11"), false);
assert.equal(isUpdateAvailable("0.9.11", null), false);

async function main(): Promise<void> {
  section("checkPackageUpdates with mocked registry");
  clearPackageUpdateCache();

  const calls: string[] = [];
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes(encodeURIComponent(SPI_NPM_PACKAGE))) {
      return new Response(JSON.stringify({ version: "0.9.99" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes(encodeURIComponent(PI_NPM_PACKAGE))) {
      return new Response(JSON.stringify({ version: "0.90.0" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("missing", { status: 404 });
  };

  const first = await checkPackageUpdates({
    webCurrent: "0.9.11",
    piCurrent: "0.84.1",
    fetchImpl: mockFetch,
  });
  assert.equal(first.web.packageName, SPI_NPM_PACKAGE);
  assert.equal(first.pi.packageName, PI_NPM_PACKAGE);
  assert.equal(first.web.current, "0.9.11");
  assert.equal(first.web.latest, "0.9.99");
  assert.equal(first.web.updateAvailable, true);
  assert.equal(first.pi.latest, "0.90.0");
  assert.equal(first.pi.updateAvailable, true);
  assert.equal(first.cached, false);
  assert.equal(calls.length, 2);

  const second = await checkPackageUpdates({
    webCurrent: "0.9.11",
    piCurrent: "0.84.1",
    fetchImpl: mockFetch,
  });
  assert.equal(second.cached, true);
  assert.equal(second.web.updateAvailable, true);
  assert.equal(calls.length, 2, "cache should skip registry on second call");

  section("registry failure stays quiet");
  clearPackageUpdateCache();
  const failingFetch: typeof fetch = async () => {
    throw new Error("network down");
  };
  const failed = await checkPackageUpdates({
    webCurrent: "0.9.11",
    piCurrent: "0.84.1",
    fetchImpl: failingFetch,
  });
  assert.equal(failed.web.updateAvailable, false);
  assert.equal(failed.pi.updateAvailable, false);
  assert.equal(failed.web.latest, null);
  assert.ok(failed.web.error);

  console.log("\npackage-update-check smoke OK");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
