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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
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

function normalizedRelative(base, file) {
  return path.relative(base, file).split(path.sep).join("/");
}

function artifactEntries(outDir) {
  const files = walkFiles(outDir);
  const entries = files.map((file) => normalizedRelative(outDir, file));
  const asars = files.filter((file) => path.basename(file).toLowerCase() === "app.asar");
  for (const asarPath of asars) {
    const asar = awaitImportAsar();
    for (const entry of asar.listPackage(asarPath)) {
      entries.push(`asar:${normalizedRelative(outDir, asarPath)}:${String(entry).replace(/^[/\\]+/, "")}`);
    }
  }
  for (const nupkgPath of files.filter((file) => file.toLowerCase().endsWith(".nupkg"))) {
    for (const entry of listZipEntries(nupkgPath)) {
      entries.push(`nupkg:${normalizedRelative(outDir, nupkgPath)}:${entry}`);
    }
  }
  return { files, entries, asars };
}

function listZipEntries(zipPath) {
  // NUPKG is ZIP; names live in its central directory and are enough for the path contract.
  const fromBuffer = readFileSync(zipPath);
  const names = [];
  let cursor = fromBuffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(cursor >= 0, `invalid nupkg zip: ${zipPath}`);
  const entries = fromBuffer.readUInt16LE(cursor + 10);
  cursor = fromBuffer.readUInt32LE(cursor + 16);
  for (let index = 0; index < entries; index++) {
    assert.equal(fromBuffer.readUInt32LE(cursor), 0x02014b50, `invalid nupkg directory: ${zipPath}`);
    const nameLength = fromBuffer.readUInt16LE(cursor + 28);
    const extraLength = fromBuffer.readUInt16LE(cursor + 30);
    const commentLength = fromBuffer.readUInt16LE(cursor + 32);
    names.push(fromBuffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

const require = createRequire(import.meta.url);
let asarModule;
function awaitImportAsar() {
  if (!asarModule) {
    // @electron/asar is installed transitively with Forge and exposes a CommonJS API.
    asarModule = require("@electron/asar");
  }
  return asarModule;
}

function extractAsarForAssetCheck(asarPath) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "snail-pet-asar-"));
  awaitImportAsar().extractAll(asarPath, dir);
  return dir;
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
    assert.ok(/icon\s*:\s*WINDOWS_ICON/.test(forgeSrc), "forge config must set the application icon");
    assert.ok(/setupIcon\s*:\s*WINDOWS_ICON_ICO/.test(forgeSrc), "Squirrel must set the setup icon");
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
        ".preview",
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
  assert.ok(contract.forbiddenBundlePaths.includes(".preview"));
  assert.ok(contract.forbiddenBundlePaths.includes("bin/pi-web.js"));
  assert.ok(contract.forbiddenBundlePaths.some((p) => p.includes("node-pty") || p.includes("pi-coding-agent")));

  if (forgeDefault) {
    assert.equal(forgeDefault.packagerConfig?.asar, true);
    assert.equal(forgeDefault.packagerConfig?.name, contract.productName);
    assert.ok(Array.isArray(forgeDefault.packagerConfig?.ignore));
    assert.equal(forgeDefault.packagerConfig?.icon, "assets/icons/icon");
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
  assert.ok(rootPkg.scripts?.["test:desktop-quick-session"], "test:desktop-quick-session script required");
  assert.match(
    String(rootPkg.scripts["test:desktop-observer"]),
    /test:desktop-quick-session/,
    "desktop observer aggregate must include quick-session smoke",
  );
  assert.ok(rootPkg.scripts?.["desktop:preview"], "desktop:preview script required");
  assert.ok(rootPkg.scripts?.["desktop:package"], "desktop:package script required");
  assert.ok(rootPkg.scripts?.["desktop:make"], "desktop:make script required");

  // desktop/package.json is private and not the npm package
  const desktopPkgPath = path.join(ROOT, "desktop", "package.json");
  assert.ok(existsSync(desktopPkgPath), "desktop/package.json must exist");
  const desktopPkg = JSON.parse(readText(desktopPkgPath));
  assert.equal(desktopPkg.private, true);
  assert.equal(desktopPkg.name, "snail-pi-pet");
  assert.notEqual(desktopPkg.name, rootPkg.name);
  assert.equal(desktopPkg.engines?.node, rootPkg.engines?.node);
  assert.ok(desktopPkg.devDependencies?.electron, "desktop package must declare its Forge Electron runtime");
  assert.ok(desktopPkg.scripts?.package?.includes("run-desktop-forge.mjs"));
  assert.ok(desktopPkg.scripts?.make?.includes("run-desktop-forge.mjs"));

  // --- Required pet source surface ---
  const required = [
    "desktop/main/main.ts",
    "desktop/main/observer-client.ts",
    "desktop/main/quick-session-client.ts",
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
    "desktop/renderer/quick-session-state.ts",
    "desktop/renderer/pet-assets.ts",
    "desktop/renderer/pet-key.ts",
    "desktop/renderer/codex-pet-assets.ts",
    "desktop/renderer/pet-runtime-profile.ts",
    "desktop/main/pet-catalog.ts",
    "desktop/renderer/pet.css",
    "desktop/assets/pets/snail-default/manifest.json",
    "desktop/assets/pets/snail-classic/manifest.json",
    "desktop/assets/pets/snail-sprite/manifest.json",
    "desktop/assets/pets/snail-sprite/snail.png",
    "desktop/assets/icons/icon.ico",
    "desktop/assets/icons/icon.png",
    "desktop/assets/tray/tray-icon.png",
    "scripts/run-desktop-forge.mjs",
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
    { id: "snail-sprite", renderMode: "spritesheet" },
  ]);
  const ico = readFileSync(path.join(ROOT, "desktop", "assets", "icons", "icon.ico"));
  assert.equal(ico.readUInt16LE(0), 0, "icon.ico reserved header");
  assert.equal(ico.readUInt16LE(2), 1, "icon.ico type");
  assert.ok(ico.readUInt16LE(4) >= 4, "icon.ico must carry multiple Windows sizes");
  for (const pngPath of ["desktop/assets/icons/icon.png", "desktop/assets/tray/tray-icon.png"]) {
    const png = readFileSync(path.join(ROOT, pngPath));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${pngPath} must be PNG`);
  }

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
  ].filter(Boolean).filter((candidate, index, candidates) => candidates.indexOf(candidate) === index);

  let scannedArtifact = false;
  for (const outDir of outCandidates) {
    if (!existsSync(outDir)) continue;
    scannedArtifact = true;
    const { files: filesInOut, entries, asars } = artifactEntries(outDir);
    const normalizedEntries = entries.map((entry) => entry.toLowerCase().replace(/\\/g, "/"));
    for (const forbidden of contract.forbiddenBundlePaths) {
      const needle = String(forbidden).toLowerCase().replace(/\\/g, "/");
      const hit = normalizedEntries.some(
        (entry) => entry.includes(`/${needle}`) || entry.includes(needle + "/") || entry.endsWith(needle),
      );
      assert.equal(hit, false, `artifact under ${rel(outDir)} must not contain forbidden path: ${forbidden}`);
    }
    for (const requiredEntry of ["main/main.js", "preload/pet-preload.js", "renderer/index.html", "renderer/pet-app.js"]) {
      assert.ok(
        normalizedEntries.some((entry) => entry.endsWith(requiredEntry)),
        `artifact under ${rel(outDir)} must contain ${requiredEntry}`,
      );
    }
    if (normalizedRelative(ROOT, outDir).replace(/\\/g, "/").endsWith("/out")) {
      for (const requiredArtifact of ["snail-pi-pet.exe", "snailpipetsetup.exe", ".nupkg"]) {
        assert.ok(
          normalizedEntries.some((entry) =>
            requiredArtifact.startsWith(".") ? entry.endsWith(requiredArtifact) : entry.endsWith(`/${requiredArtifact}`),
          ),
          `Forge output must contain ${requiredArtifact}`,
        );
      }
    }
    const resourceFiles = filesInOut.filter((file) => {
      const artifactPath = normalizedRelative(outDir, file).toLowerCase();
      return artifactPath.includes("/resources/") || artifactPath.startsWith("resources/");
    });
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
      assert.equal(packagedPets.length, 3, "artifact must contain all three builtin pets");
    } else if (asars.length > 0) {
      const extracted = extractAsarForAssetCheck(asars[0]);
      try {
        assert.ok(existsSync(path.join(extracted, "main", "main.js")), "asar must contain main bundle");
      } finally {
        rmSync(extracted, { recursive: true, force: true });
      }
    } else {
      assert.fail(`artifact under ${rel(outDir)} has neither expanded resources nor app.asar`);
    }
    console.log(`ARTIFACT_SCAN_OK dir=${rel(outDir)} files=${filesInOut.length} asars=${asars.length}`);
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
