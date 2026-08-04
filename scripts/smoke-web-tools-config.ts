import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyWebToolsConfig,
  computeWebToolsRevision,
  readWebToolsConfigSnapshot,
  resolveWebToolsConfigPaths,
  WEB_TOOLS_PACKAGE_VERSION,
  WEB_TOOLS_PROVIDERS,
  WebToolsConfigError,
} from "../lib/web-tools-config";

let failures = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (condition) console.log(`ok: ${message}`);
  else {
    failures += 1;
    console.error(`FAIL: ${message}`);
  }
}

function main(): void {
  const root = mkdtempSync(join(tmpdir(), "spi-web-tools-smoke-"));
  const homeDir = join(root, "home");
  const xdgDir = join(root, "xdg");
  mkdirSync(homeDir, { recursive: true });
  const isolated = { homeDir, xdgConfigHome: xdgDir, env: {} };
  const { canonicalPath, legacyPath } = resolveWebToolsConfigPaths(isolated);

  try {
    const packageRoot = join(process.cwd(), "node_modules", "@juicesharp", "rpiv-web-tools");
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: string };
    assert(packageJson.version === WEB_TOOLS_PACKAGE_VERSION, "provider adapter is bound to pinned package version");
    for (const provider of WEB_TOOLS_PROVIDERS) {
      const sourceName = provider.id === "youcom" ? "youcom" : provider.id;
      const source = readFileSync(join(packageRoot, "providers", `${sourceName}.ts`), "utf8");
      assert(source.includes(`name: "${provider.id}"`), `provider catalog name matches package: ${provider.id}`);
      assert(source.includes(`label: "${provider.label}"`), `provider catalog label matches package: ${provider.id}`);
      assert(source.includes(`"${provider.apiKeyEnvVar}"`), `provider key env matches package: ${provider.id}`);
      for (const role of provider.roles) assert(source.includes(`"${role}"`), `provider role ${role} matches package: ${provider.id}`);
      if ("baseUrlEnvVar" in provider) {
        assert(source.includes(`"${provider.baseUrlEnvVar}"`), `provider URL env matches package: ${provider.id}`);
      }
    }

    const missing = readWebToolsConfigSnapshot(isolated);
    assert(!missing.exists, "missing config projects safely");
    assert(missing.persistedProvider === "brave", "missing config defaults to Brave");
    assert(!JSON.stringify(missing).includes("apiKeys"), "snapshot has no raw secret map");

    mkdirSync(dirname(canonicalPath), { recursive: true });
    const original = {
      provider: "brave",
      apiKey: "legacy-brave-secret",
      apiKeys: { tavily: "tavily-secret" },
      guidance: { web_search: { prefix: "keep guidance" } },
      interceptors: { github: true },
      vendorField: { keep: true },
    };
    writeFileSync(canonicalPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");
    const loaded = readWebToolsConfigSnapshot(isolated);
    assert(loaded.providers.find((provider) => provider.id === "brave")?.keySource === "legacy", "legacy Brave key is projected without value");
    assert(!JSON.stringify(loaded).includes("legacy-brave-secret"), "legacy key is redacted from projection");
    assert(!JSON.stringify(loaded).includes("tavily-secret"), "apiKeys values are redacted from projection");

    const preserved = applyWebToolsConfig({
      ...isolated,
      expectedRevision: loaded.revision,
      provider: "tavily",
      apiKey: { mode: "preserve" },
    });
    const preservedDisk = readFileSync(canonicalPath, "utf8");
    assert(preserved.persistedProvider === "tavily", "provider selection is persisted");
    assert(preservedDisk.includes("legacy-brave-secret"), "preserve retains legacy key");
    assert(preservedDisk.includes("tavily-secret"), "preserve retains selected provider key");
    assert(preservedDisk.includes("keep guidance"), "guidance is preserved");
    assert(preservedDisk.includes("vendorField"), "unknown fields are preserved");

    const replaced = applyWebToolsConfig({
      ...isolated,
      expectedRevision: preserved.revision,
      provider: "searxng",
      apiKey: { mode: "replace", value: "searxng-secret" },
      baseUrl: { mode: "replace", value: "http://127.0.0.1:8888/" },
    });
    const replacedDisk = JSON.parse(readFileSync(canonicalPath, "utf8")) as {
      apiKeys?: Record<string, string>;
      baseUrls?: Record<string, string>;
    };
    assert(replacedDisk.apiKeys?.searxng === "searxng-secret", "replace stores provider key");
    assert(replacedDisk.baseUrls?.searxng === "http://127.0.0.1:8888", "replace validates and normalizes base URL");
    assert(!JSON.stringify(replaced).includes("searxng-secret"), "replaced key is not returned");

    const envSnapshot = readWebToolsConfigSnapshot({
      ...isolated,
      env: {
        WEB_SEARCH_PROVIDER: "ollama",
        SEARXNG_API_KEY: "environment-secret",
        SEARXNG_URL: "http://environment.invalid:9999",
      },
    });
    const searxng = envSnapshot.providers.find((provider) => provider.id === "searxng");
    assert(envSnapshot.effectiveProvider === "ollama" && envSnapshot.effectiveProviderSource === "environment", "provider environment precedence is projected");
    assert(searxng?.keySource === "environment", "key environment precedence is projected");
    assert(searxng?.baseUrlSource === "environment", "base URL environment precedence is projected");
    assert(!JSON.stringify(envSnapshot).includes("environment-secret"), "environment key value is never returned");

    applyWebToolsConfig({
      ...isolated,
      expectedRevision: replaced.revision,
      provider: "searxng",
      apiKey: { mode: "clear" },
      baseUrl: { mode: "clear" },
    });
    const clearedDisk = JSON.parse(readFileSync(canonicalPath, "utf8")) as {
      apiKeys?: Record<string, string>;
      baseUrls?: Record<string, string>;
    };
    assert(!clearedDisk.apiKeys?.searxng, "clear removes selected provider key");
    assert(!clearedDisk.baseUrls?.searxng, "clear removes selected provider base URL");

    let conflict = false;
    try {
      applyWebToolsConfig({
        ...isolated,
        expectedRevision: replaced.revision,
        provider: "brave",
        apiKey: { mode: "preserve" },
      });
    } catch (error) {
      conflict = error instanceof WebToolsConfigError && error.code === "REVISION_CONFLICT";
    }
    assert(conflict, "stale revisions are rejected");

    writeFileSync(canonicalPath, '{"apiKeys":{"brave":"malformed-secret"}, trailing', "utf8");
    const malformed = readWebToolsConfigSnapshot(isolated);
    assert(!!malformed.parseError, "malformed files return parse diagnostics");
    assert(!JSON.stringify(malformed).includes("malformed-secret"), "malformed parse diagnostics never echo nearby secrets");
    let parseBlocked = false;
    try {
      applyWebToolsConfig({
        ...isolated,
        expectedRevision: malformed.revision,
        provider: "brave",
        apiKey: { mode: "preserve" },
      });
    } catch (error) {
      parseBlocked = error instanceof WebToolsConfigError && error.code === "PARSE_ERROR";
    }
    assert(parseBlocked, "malformed files are never overwritten");

    rmSync(canonicalPath, { force: true });
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, '{"provider":"exa","legacyUnknown":true}\n', "utf8");
    const fallback = readWebToolsConfigSnapshot(isolated);
    assert(fallback.sourceKind === "legacy-fallback" && fallback.persistedProvider === "exa", "XDG path falls back to legacy config when missing");
    const migrated = applyWebToolsConfig({
      ...isolated,
      expectedRevision: fallback.revision,
      provider: "exa",
      apiKey: { mode: "preserve" },
    });
    assert(existsSync(canonicalPath), "saving legacy fallback creates canonical XDG file");
    assert(readFileSync(canonicalPath, "utf8").includes("legacyUnknown"), "legacy fallback unknown fields migrate safely");
    assert(migrated.sourceKind === "canonical", "subsequent reads use canonical file");

    const tempFiles = readdirSync(dirname(canonicalPath)).filter((name) => name.includes(".snail-pi-") && name.endsWith(".tmp"));
    assert(tempFiles.length === 0, "atomic writes leave no temp files");
    assert(
      computeWebToolsRevision(canonicalPath, canonicalPath, readFileSync(canonicalPath, "utf8")) === migrated.revision,
      "revision covers exact persisted bytes",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  if (failures > 0) process.exitCode = 1;
  else console.log("All Web Search config smokes passed.");
}

main();
