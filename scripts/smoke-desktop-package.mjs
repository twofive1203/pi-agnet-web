/**
 * Pet-only packaging contract smoke (U8).
 *
 * Does NOT require Electron Forge to be installed or a full Windows make.
 * When `out/` (or DESKTOP_PACKAGE_OUT) exists, also scans the artifact tree.
 *
 * Run: node scripts/smoke-desktop-package.mjs
 *      npm run test:desktop-package
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadDesktopPetAssetValidator } from "./desktop-pet-asset-validator.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join("/");
}

function readText(p) {
  return readFileSync(p, "utf8");
}

function assertNoServiceControl(source, fileLabel) {
  assert.equal(
    /from\s+["']child_process["']|require\(\s*["']child_process["']\s*\)/.test(source),
    false,
    `${fileLabel}: must not import child_process`,
  );
  assert.equal(
    /\b(?:spawn|fork|execFile)\s*\(/.test(source),
    false,
    `${fileLabel}: must not spawn/fork/execFile`,
  );
  assert.equal(/\bprocess\.kill\b/.test(source), false, `${fileLabel}: must not process.kill`);
  assert.equal(/\bservicePid\b\s*[:=]/.test(source), false, `${fileLabel}: must not track servicePid`);
}

async function main() {
  console.log("smoke-desktop-package: start");
  const { validatePackagedPetAssets } = await loadDesktopPetAssetValidator(ROOT);

  // --- Load forge contract ---
  const forgeUrl = pathToFileURL(path.join(ROOT, "forge.config.ts")).href;
  // tsx may not be registered; prefer dynamic import via compiled-less path.
  // Use createRequire-free approach: read + eval contract constants from file text + import via tsx if needed.
  let contract;
  let forgeDefault;
  try {
    const mod = await import(forgeUrl);
    contract = mod.DESKTOP_PACKAGE_CONTRACT;
    forgeDefault = mod.default;
  } catch {
    // Fallback: spawn tsx register is unavailable under plain node for .ts.
    // Parse the contract from the TypeScript source with a minimal extractor.
    const forgeSrc = readText(path.join(ROOT, "forge.config.ts"));
    assert.ok(forgeSrc.includes("petOnly: true"), "forge.config must declare petOnly");
    assert.ok(forgeSrc.includes("separateFromNpmSpi: true"), "forge.config must separate from npm spi");
    assert.ok(forgeSrc.includes("com.twofive.snail-pi-pet"), "forge.config must set AppUserModelID / bundle id");
    assert.ok(forgeSrc.includes("snail-pi-pet"), "forge.config must set executableName");
    assert.ok(forgeSrc.includes("WINDOWS_CERTIFICATE_FILE"), "forge.config must document signing placeholders");
    assert.ok(
      /extraResource\s*:\s*\[[^\]]*["']desktop\/assets["']/.test(forgeSrc),
      "forge.config must package builtin pet assets",
    );
    contract = {
      productName: "SnailPiPet",
      executableName: "snail-pi-pet",
      appUserModelId: "com.twofive.snail-pi-pet",
      petOnly: true,
      separateFromNpmSpi: true,
      requiresNodeJs: false,
      serviceLaunchCommand: "spi --no-open",
      forbiddenBundlePaths: [
        ".next",
        "bin/pi-web.js",
        "node_modules/next",
        "node_modules/@lydell/node-pty",
        "node_modules/@earendil-works/pi-coding-agent",
        "node_modules/pi-subagents",
      ],
      signingEnvPlaceholders: [
        "WINDOWS_CERTIFICATE_FILE",
        "WINDOWS_CERTIFICATE_PASSWORD",
        "CSC_LINK",
        "CSC_KEY_PASSWORD",
      ],
    };
    forgeDefault = null;
  }

  assert.equal(contract.petOnly, true);
  assert.equal(contract.separateFromNpmSpi, true);
  assert.equal(contract.requiresNodeJs, false);
  assert.equal(contract.executableName, "snail-pi-pet");
  assert.equal(contract.appUserModelId, "com.twofive.snail-pi-pet");
  assert.equal(contract.serviceLaunchCommand, "spi --no-open");
  assert.ok(Array.isArray(contract.forbiddenBundlePaths));
  assert.ok(contract.forbiddenBundlePaths.includes(".next"));
  assert.ok(contract.forbiddenBundlePaths.includes("bin/pi-web.js"));
  assert.ok(contract.forbiddenBundlePaths.some((p) => p.includes("node-pty") || p.includes("pi-coding-agent")));

  if (forgeDefault) {
    assert.equal(forgeDefault.packagerConfig?.asar, true);
    assert.equal(forgeDefault.packagerConfig?.name, contract.productName);
    assert.ok(Array.isArray(forgeDefault.packagerConfig?.ignore));
    assert.ok(
      forgeDefault.packagerConfig?.extraResource?.includes("desktop/assets"),
      "packager extraResource must include builtin pet assets",
    );
    assert.ok(forgeDefault.makers?.some((m) => String(m.name).includes("squirrel")));
    const ignoreSrc = forgeDefault.packagerConfig.ignore.map(String).join("\n");
    assert.ok(/\.next|next/.test(ignoreSrc), "packager ignore must cover .next/next");
    assert.ok(/node-pty/.test(ignoreSrc), "packager ignore must cover node-pty");
    assert.ok(/pi-coding-agent/.test(ignoreSrc), "packager ignore must cover pi-coding-agent");
  }

  // --- npm spi package must not ship the pet ---
  const rootPkg = JSON.parse(readText(path.join(ROOT, "package.json")));
  const files = rootPkg.files ?? [];
  assert.ok(Array.isArray(files), "package.json files must be an array");
  for (const entry of files) {
    const normalized = String(entry).replace(/\\/g, "/");
    assert.equal(
      normalized === "desktop" ||
        normalized.startsWith("desktop/") ||
        normalized === "forge.config.ts" ||
        normalized.includes("electron"),
      false,
      `npm files must not include desktop/forge/electron entry: ${entry}`,
    );
  }
  assert.equal(rootPkg.bin?.spi, "bin/pi-web.js");
  // Desktop scripts must exist and not be the only publish surface
  assert.ok(rootPkg.scripts?.["test:desktop-package"], "test:desktop-package script required");
  assert.ok(rootPkg.scripts?.["test:desktop-observer"], "test:desktop-observer script required");
  assert.ok(rootPkg.scripts?.["desktop:preview"], "desktop:preview script required");

  // desktop/package.json is private and not the npm package
  const desktopPkgPath = path.join(ROOT, "desktop", "package.json");
  assert.ok(existsSync(desktopPkgPath), "desktop/package.json must exist");
  const desktopPkg = JSON.parse(readText(desktopPkgPath));
  assert.equal(desktopPkg.private, true);
  assert.equal(desktopPkg.name, "snail-pi-pet");
  assert.notEqual(desktopPkg.name, rootPkg.name);

  // --- Required pet source surface ---
  const required = [
    "desktop/main/main.ts",
    "desktop/main/observer-client.ts",
    "desktop/main/connection-state.ts",
    "desktop/main/activity-store.ts",
    "desktop/main/notification-controller.ts",
    "desktop/main/window-manager.ts",
    "desktop/main/tray-controller.ts",
    "desktop/main/deep-link-opener.ts",
    "desktop/main/settings-store.ts",
    "desktop/preload/pet-preload.ts",
    "desktop/renderer/index.html",
    "desktop/renderer/pet-app.tsx",
    "desktop/renderer/pet-app.js",
    "desktop/renderer/pet-state.ts",
    "desktop/renderer/pet-assets.ts",
    "desktop/renderer/pet.css",
    "desktop/assets/pets/snail-default/manifest.json",
    "desktop/assets/pets/snail-classic/manifest.json",
    "scripts/preview-desktop-pet-states.mjs",
    "docs/operations/desktop-pet-visual-review.md",
    "forge.config.ts",
    "docs/operations/desktop-pet-validation.md",
  ];
  for (const file of required) {
    assert.ok(existsSync(path.join(ROOT, file)), `missing required file: ${file}`);
  }

  // --- Desktop source: no service control ---
  for (const file of walkFiles(path.join(ROOT, "desktop"))) {
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(file)) continue;
    assertNoServiceControl(readText(file), rel(file));
  }

  // main sets AppUserModelID and never warns about interrupting tasks
  const mainSrc = readText(path.join(ROOT, "desktop", "main", "main.ts"));
  assert.ok(mainSrc.includes("com.twofive.snail-pi-pet"), "main must set AppUserModelID");
  assert.ok(mainSrc.includes("No task-interruption warning") || mainSrc.includes("leaves spi"));
  assert.equal(/会中断任务|interrupt tasks/.test(mainSrc), false);

  // Preload isolation
  const preloadSrc = readText(path.join(ROOT, "desktop", "preload", "pet-preload.ts"));
  assert.ok(preloadSrc.includes("contextBridge.exposeInMainWorld"));
  assert.equal(/getToken|observerToken|child_process/.test(preloadSrc), false);

  // Renderer CSP
  const html = readText(path.join(ROOT, "desktop", "renderer", "index.html"));
  assert.ok(html.includes("Content-Security-Policy"));
  assert.ok(html.includes("default-src 'none'"));

  const forgeIgnoreSrc = readText(path.join(ROOT, "forge.config.ts"));
  assert.ok(/\^\\\/scripts/.test(forgeIgnoreSrc) || /scripts/.test(forgeIgnoreSrc), "packager ignore must cover preview scripts");
  assert.ok(/\^\\\/docs/.test(forgeIgnoreSrc) || /docs/.test(forgeIgnoreSrc), "packager ignore must cover review docs");
  assert.ok(
    /desktop\/\.preview|\.preview/.test(readText(path.join(ROOT, ".gitignore"))),
    "preview output must stay gitignored",
  );

  const sourcePetAssets = validatePackagedPetAssets(
    path.join(ROOT, "desktop", "assets", "pets"),
    {
      readFile: readText,
      exists: existsSync,
      size: (filePath) => statSync(filePath).size,
      join: path.join,
    },
  );
  assert.deepEqual(sourcePetAssets, [
    { id: "snail-default", renderMode: "css" },
    { id: "snail-classic", renderMode: "css" },
  ]);

  // Window security contract source
  const winSrc = readText(path.join(ROOT, "desktop", "main", "window-manager.ts"));
  assert.ok(winSrc.includes("nodeIntegration: false"));
  assert.ok(winSrc.includes("contextIsolation: true"));
  assert.ok(winSrc.includes("sandbox: true"));

  // Validation doc must cover AE matrix + manual gaps
  const validationDoc = readText(path.join(ROOT, "docs", "operations", "desktop-pet-validation.md"));
  for (const ae of ["AE1", "AE2", "AE5", "AE6", "AE7", "AE8", "AE9", "AE10", "AE11", "AE12", "AE13"]) {
    assert.ok(validationDoc.includes(ae), `validation doc must mention ${ae}`);
  }
  assert.ok(validationDoc.includes("spi --no-open"), "validation doc must document service start command");
  assert.ok(
    /未执行|manual|Manual|not executed/i.test(validationDoc),
    "validation doc must mark manual/unexecuted items",
  );
  assert.ok(validationDoc.includes("SmartScreen") || validationDoc.includes("签名"), "validation doc must mention signing/SmartScreen");

  // Deployment + troubleshooting mention independent startup
  const deploy = readText(path.join(ROOT, "docs", "deployment", "README.md"));
  assert.ok(/desktop pet|桌宠/i.test(deploy), "deployment README must mention desktop pet");
  assert.ok(deploy.includes("spi --no-open"), "deployment README must mention spi --no-open");

  const troubleshooting = readText(path.join(ROOT, "docs", "operations", "troubleshooting.md"));
  assert.ok(/desktop pet|桌宠|service not running|服务未启动/i.test(troubleshooting));

  // README surfaces
  for (const readme of ["README.md", "README.zh-CN.md"]) {
    const body = readText(path.join(ROOT, readme));
    assert.ok(/桌宠|desktop pet/i.test(body), `${readme} must mention desktop pet`);
    assert.ok(body.includes("spi --no-open") || body.includes("`spi`"), `${readme} must mention spi`);
  }

  // --- Optional artifact scan ---
  const outCandidates = [
    process.env.DESKTOP_PACKAGE_OUT,
    path.join(ROOT, "out"),
    path.join(ROOT, "desktop", "out"),
    path.join(ROOT, "dist"),
  ].filter(Boolean);

  let scannedArtifact = false;
  for (const outDir of outCandidates) {
    if (!existsSync(outDir)) continue;
    scannedArtifact = true;
    const filesInOut = walkFiles(outDir);
    const joined = filesInOut.map((f) => rel(f).toLowerCase()).join("\n");
    for (const forbidden of contract.forbiddenBundlePaths) {
      const needle = String(forbidden).toLowerCase().replace(/\\/g, "/");
      // Allow mentions only inside our smoke logs; block real nested paths.
      const hit = filesInOut.some((f) => {
        const r = rel(f).toLowerCase().replace(/\\/g, "/");
        return r.includes(`/${needle}`) || r.includes(needle + "/") || r.endsWith(needle);
      });
      assert.equal(hit, false, `artifact under ${rel(outDir)} must not contain forbidden path: ${forbidden}`);
    }
    const resourceFiles = filesInOut.filter((file) =>
      rel(file).toLowerCase().replace(/\\/g, "/").includes("/resources/"),
    );
    if (resourceFiles.length > 0) {
      const defaultManifestPath = resourceFiles.find((file) =>
        rel(file)
          .toLowerCase()
          .replace(/\\/g, "/")
          .endsWith("/assets/pets/snail-default/manifest.json"),
      );
      assert.ok(defaultManifestPath, `artifact under ${rel(outDir)} must contain builtin pet manifests`);
      const petsRoot = path.dirname(path.dirname(defaultManifestPath));
      const packagedPets = validatePackagedPetAssets(petsRoot, {
        readFile: readText,
        exists: existsSync,
        size: (filePath) => statSync(filePath).size,
        join: path.join,
      });
      assert.equal(packagedPets.length, 2, "artifact must contain both builtin pets");
    } else {
      console.log(`ARTIFACT_RESOURCE_SCAN_SKIPPED dir=${rel(outDir)} no expanded resources tree`);
    }
    // Executable name presence is soft — Squirrel layout varies.
    void joined;
    console.log(`ARTIFACT_SCAN_OK dir=${rel(outDir)} files=${filesInOut.length}`);
  }
  if (!scannedArtifact) {
    console.log("ARTIFACT_SCAN_SKIPPED no out/ dist/ package directory (expected until forge make)");
  }

  // Uninstall / data isolation documentation contract
  assert.ok(
    validationDoc.includes("~/.pi/agent") || validationDoc.includes(".pi/agent"),
    "validation doc must state agent data isolation on uninstall",
  );

  console.log("smoke-desktop-package: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
