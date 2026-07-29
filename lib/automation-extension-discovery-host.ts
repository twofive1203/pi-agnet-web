/**
 * Standalone extension discovery host.
 *
 * Runs outside the Next.js bundle so createRequire / vm evaluation never
 * pollutes next build/start. Only invoked for digests already present in the
 * trusted reviewed registry (caller must gate before fork).
 *
 * Protocol (stdin JSON → stdout JSON):
 *   request:  { bundleBytesBase64, expectedSha256, sourcePath }
 *   response: DiscoveredExtensionRegistration | { error: string }
 */

import {
  discoverExtensionRegistrationFromBytes,
  type DiscoveredExtensionRegistration,
} from "./automation-extension-runtime";

export type DiscoveryWorkerRequest = {
  bundleBytesBase64: string;
  expectedSha256: string;
  sourcePath: string;
};

export type DiscoveryWorkerResponse =
  | { ok: true; registration: DiscoveredExtensionRegistration }
  | { ok: false; error: string };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let req: DiscoveryWorkerRequest;
  try {
    const raw = (await readStdin()).trim();
    if (!raw) {
      process.stdout.write(JSON.stringify({ ok: false, error: "empty discovery request" }));
      process.exitCode = 2;
      return;
    }
    req = JSON.parse(raw) as DiscoveryWorkerRequest;
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: `invalid discovery request JSON: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
    process.exitCode = 2;
    return;
  }

  if (
    typeof req.bundleBytesBase64 !== "string" ||
    typeof req.expectedSha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(req.expectedSha256) ||
    typeof req.sourcePath !== "string"
  ) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: "discovery request fields invalid" }),
    );
    process.exitCode = 2;
    return;
  }

  try {
    const bundleBytes = Buffer.from(req.bundleBytesBase64, "base64");
    const registration = await discoverExtensionRegistrationFromBytes({
      bundleBytes,
      bundleSha256: req.expectedSha256.toLowerCase(),
      sourcePath: req.sourcePath,
    });
    const response: DiscoveryWorkerResponse = { ok: true, registration };
    process.stdout.write(JSON.stringify(response));
    process.exitCode = 0;
  } catch (error) {
    const response: DiscoveryWorkerResponse = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    process.stdout.write(JSON.stringify(response));
    process.exitCode = 1;
  }
}

const entryHint = (process.argv[1] ?? "").replace(/\\/g, "/");
const isDirect =
  /automation-extension-discovery-(host|runtime)/.test(entryHint) ||
  (typeof require !== "undefined" &&
    typeof module !== "undefined" &&
    typeof require.main !== "undefined" &&
    require.main === module);

if (isDirect) {
  void main();
}

export { main as runDiscoveryWorkerMain };
