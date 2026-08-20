/**
 * Isolated Tauri Preview packaging contract (U8).
 *
 * Does NOT require a full `tauri build`. When a bundle directory exists
 * (or DESKTOP_TAURI_PACKAGE_OUT is set), also scans the artifact tree.
 *
 * The settings rehearsal is read-only: it parses a fixture (or an explicit
 * Electron settings path) and prints an anonymized mapping. It never writes
 * Electron or Tauri user-data files.
 *
 * Run: node scripts/smoke-desktop-tauri-package.mjs
 *      npm run test:desktop-tauri-package
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON_IDENTIFIER = "com.twofive.snail-pi-pet";
const ELECTRON_EXECUTABLE = "snail-pi-pet";
const ELECTRON_PRODUCT = "SnailPiPet";
const ELECTRON_SETTINGS = "desktop-pet-settings.json";
const ELECTRON_ACCESS_KEY = "desktop-pet-access-key.json";
const PREVIEW_IDENTIFIER = "com.twofive.snail-pi-pet.tauri-preview";
const PREVIEW_EXECUTABLE = "snail-pi-pet-tauri-preview";
const PREVIEW_SETTINGS = "tauri-preview-settings.json";
const PREVIEW_ACCESS_KEY = "tauri-preview-access-key.json";
const ALLOWED_WEBVIEW_MODES = new Set(["embedBootstrapper", "downloadBootstrapper"]);
const FORBIDDEN_WEBVIEW_MODES = new Set(["offlineInstaller", "fixedRuntime", "skip"]);
const FORBIDDEN_BUNDLE_NEEDLES = [
  ".next",
  ".preview",
  "bin/pi-web.js",
  "node_modules",
  "node.exe",
  "node_modules/next",
  "node_modules/@lydell/node-pty",
  "node_modules/@earendil-works/pi-coding-agent",
  "node_modules/pi-subagents",
  "electron.exe",
  "app.asar",
  "forge.config",
  "desktop-pet-settings.json",
  "desktop-pet-access-key.json",
  "connection-cases.json",
  "activity-view-cases.json",
  "transition-cases.json",
  "electron-settings-import.json",
  "fixtures",
  "automation",
];
const FRONTEND_DIST_ALLOWLIST = new Set([
  ".phase-b-build.json",
  "index.html",
  "pet-app.js",
  "pet.css",
  "tauri-bridge.js",
]);
const FORBIDDEN_SETTINGS_KEYS = [
  "token",
  "observerToken",
  "accessKey",
  "password",
  "pid",
  "servicePid",
  "childPid",
  "cwd",
  "cwds",
  "prompt",
  "firstMessage",
  "command",
  "output",
];
const PET_SCALES = {
  1: "small",
  1.2: "medium",
  1.5: "large",
};
const BUBBLE_THEMES = new Set(["cream", "peach", "night", "ember", "plum", "moss"]);
const COMPLETION_POLICIES = new Set(["never", "background-only", "always"]);

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
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

function rel(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function normalizedRelative(base, file) {
  return path.relative(base, file).split(path.sep).join("/");
}

function assertNoServiceControl(source, label) {
  assert.equal(
    /use\s+std::process(?!::id)|std::process::Command|Command::new\s*\(|\bprocess\.kill\b|from\s+["']child_process["']|require\(\s*["']child_process["']\s*\)/.test(
      source,
    ),
    false,
    `${label}: must remain attach-only and must not control spi`,
  );
  assert.equal(/\bservicePid\b\s*[:=]/.test(source), false, `${label}: must not track servicePid`);
}

function normalizePetScale(value) {
  if (value === "small" || value === "medium" || value === "large") return value;
  const numeric = typeof value === "number" ? value : Number(value);
  return PET_SCALES[numeric] ?? "medium";
}

function normalizePetKey(selectedPetKey, selectedPetId) {
  if (typeof selectedPetKey === "string" && /^(snail|codex):[a-z0-9][a-z0-9_-]{0,63}$/.test(selectedPetKey)) {
    return selectedPetKey;
  }
  if (typeof selectedPetId === "string" && /^(snail|codex):/.test(selectedPetId)) {
    return selectedPetId;
  }
  if (typeof selectedPetId === "string" && selectedPetId.length > 0) {
    return `snail:${selectedPetId}`;
  }
  return "snail:snail-default";
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const id = typeof item === "string" ? item.trim() : "";
    if (!id || id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 500) break;
  }
  return out;
}

function mapElectronSettingsPreview(raw) {
  const notification = raw?.notification && typeof raw.notification === "object" ? raw.notification : {};
  const sound = raw?.sound && typeof raw.sound === "object" ? raw.sound : {};
  const selectedPetKey = normalizePetKey(raw?.selectedPetKey, raw?.selectedPetId);
  return {
    version: 1,
    port: Number.isInteger(raw?.port) && raw.port >= 1 && raw.port <= 65535 ? raw.port : 62666,
    selectedPetKey,
    selectedPetId: selectedPetKey.split(":")[1] ?? "snail-default",
    petScale: normalizePetScale(raw?.petScale),
    bubbleTheme: BUBBLE_THEMES.has(raw?.bubbleTheme) ? raw.bubbleTheme : "cream",
    alwaysOnTop: raw?.alwaysOnTop !== false,
    clickThrough: raw?.clickThrough === true,
    launchAtLogin: raw?.launchAtLogin === true,
    activityTrayOpen: raw?.activityTrayOpen === true,
    showContextMeter: raw?.showContextMeter !== false,
    rightClickAggregatedMenu: raw?.rightClickAggregatedMenu === true,
    dndEnabled: raw?.dndEnabled === true,
    windowPosition:
      raw?.windowPosition &&
      Number.isFinite(raw.windowPosition.x) &&
      Number.isFinite(raw.windowPosition.y)
        ? { x: Math.round(raw.windowPosition.x), y: Math.round(raw.windowPosition.y) }
        : null,
    notification: {
      needsInput: notification.needsInput !== false,
      blocked: notification.blocked !== false,
      completion: COMPLETION_POLICIES.has(notification.completion)
        ? notification.completion
        : "background-only",
    },
    sound: {
      masterEnabled: sound.masterEnabled === true,
      needsInput: sound.needsInput !== false,
      completion: sound.completion !== false,
    },
    acknowledgedTransitionIds: normalizeIdList(raw?.acknowledgedTransitionIds),
    notifiedTransitionIds: normalizeIdList(raw?.notifiedTransitionIds),
    soundedTransitionIds: normalizeIdList(raw?.soundedTransitionIds),
  };
}

function anonymizeValue(key, value) {
  if (FORBIDDEN_SETTINGS_KEYS.includes(key)) return "<redacted>";
  if (Array.isArray(value)) return { count: value.length };
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [
        nestedKey,
        anonymizeValue(nestedKey, nestedValue),
      ]),
    );
  }
  if (typeof value === "string" && /([A-Za-z]:\\|\/home\/|\/Users\/|\\\\)/.test(value)) {
    return "<path>";
  }
  return value;
}

function anonymizedDiff(mapped) {
  return Object.fromEntries(
    Object.entries(mapped).map(([key, value]) => [key, anonymizeValue(key, value)]),
  );
}

function assertSafeMappedSettings(mapped) {
  const serialized = JSON.stringify(mapped);
  for (const key of FORBIDDEN_SETTINGS_KEYS) {
    assert.equal(
      serialized.includes(`"${key}"`),
      false,
      `mapped settings must not retain forbidden key: ${key}`,
    );
  }
  assert.equal(serialized.includes(ELECTRON_ACCESS_KEY), false);
  assert.equal(/sk-|token-|access-key/i.test(serialized), false);
}

function rehearseSettingsMigration() {
  const fixturePath = path.join(
    ROOT,
    "scripts",
    "fixtures",
    "desktop-pet-host",
    "electron-settings-import.json",
  );
  const raw = readJson(fixturePath);
  const mapped = mapElectronSettingsPreview(raw);
  assertSafeMappedSettings(mapped);
  assert.equal(mapped.selectedPetKey, "snail:snail-classic");
  assert.equal(mapped.petScale, "large");
  assert.equal(mapped.bubbleTheme, "night");
  assert.equal(mapped.launchAtLogin, true);
  assert.equal(mapped.dndEnabled, true);
  assert.equal(mapped.notification.needsInput, false);
  assert.equal(mapped.notification.completion, "always");
  assert.deepEqual(mapped.acknowledgedTransitionIds, ["ae-ready-1"]);
  assert.equal(mapped.windowPosition?.y, -40);

  const officialElectron = path.join(os.homedir(), "AppData", "Roaming", ELECTRON_PRODUCT, ELECTRON_SETTINGS);
  const officialTauri = path.join(
    os.homedir(),
    "AppData",
    "Roaming",
    "com.twofive.snail-pi-pet.tauri-preview",
    PREVIEW_SETTINGS,
  );
  const electronBefore = existsSync(officialElectron) ? readText(officialElectron) : null;
  const electronStat = existsSync(officialElectron) ? statSync(officialElectron).mtimeMs : null;
  const tauriBefore = existsSync(officialTauri) ? readText(officialTauri) : null;
  const tauriStat = existsSync(officialTauri) ? statSync(officialTauri).mtimeMs : null;

  const scratch = path.join(os.tmpdir(), `snail-tauri-rehearsal-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  const scratchReport = path.join(scratch, "anonymized-settings-diff.json");
  writeFileSync(scratchReport, `${JSON.stringify(anonymizedDiff(mapped), null, 2)}\n`);
  assert.ok(existsSync(scratchReport), "rehearsal must be able to write an anonymized report to temp");

  if (electronBefore === null) {
    assert.equal(existsSync(officialElectron), false, "rehearsal must not create Electron settings");
  } else {
    assert.equal(readText(officialElectron), electronBefore, "rehearsal must not rewrite Electron settings");
    assert.equal(statSync(officialElectron).mtimeMs, electronStat);
  }
  if (tauriBefore === null) {
    assert.equal(existsSync(officialTauri), false, "rehearsal must not create Tauri Preview settings");
  } else {
    assert.equal(readText(officialTauri), tauriBefore, "rehearsal must not rewrite Tauri Preview settings");
    assert.equal(statSync(officialTauri).mtimeMs, tauriStat);
  }

  const optionalSource = process.env.DESKTOP_TAURI_ELECTRON_SETTINGS;
  if (optionalSource) {
    assert.ok(existsSync(optionalSource), `optional Electron settings missing: ${optionalSource}`);
    const liveMapped = mapElectronSettingsPreview(readJson(optionalSource));
    assertSafeMappedSettings(liveMapped);
    console.log(
      `SETTINGS_REHEARSAL_LIVE source=${optionalSource} fields=${Object.keys(anonymizedDiff(liveMapped)).join(",")}`,
    );
  }

  console.log(`SETTINGS_REHEARSAL_OK report=${scratchReport}`);
  return mapped;
}

function assertFrontendDist(distDir) {
  assert.ok(existsSync(distDir), "desktop-tauri/dist must exist after the UI build");
  const entries = readdirSync(distDir).sort();
  for (const entry of entries) {
    const full = path.join(distDir, entry);
    assert.equal(statSync(full).isDirectory(), false, `frontend dist must not contain directory: ${entry}`);
    assert.ok(FRONTEND_DIST_ALLOWLIST.has(entry), `frontend dist contains unexpected file: ${entry}`);
    assert.equal(entry.endsWith(".map"), false, `frontend dist must not contain source map: ${entry}`);
  }
  assert.deepEqual(new Set(entries), FRONTEND_DIST_ALLOWLIST);
  console.log(`FRONTEND_DIST_OK files=${entries.length}`);
}

function assertExpandedAppTree(appDir, { emit = true } = {}) {
  const files = walkFiles(appDir);
  assert.ok(files.length > 0, `expanded app tree is empty: ${appDir}`);
  const entries = files.map((file) => normalizedRelative(appDir, file).toLowerCase().replace(/\\/g, "/"));
  for (const forbidden of FORBIDDEN_BUNDLE_NEEDLES) {
    const needle = forbidden.toLowerCase();
    const hit = entries.some(
      (entry) => entry.includes(`/${needle}`) || entry.includes(needle) || entry.endsWith(needle),
    );
    assert.equal(hit, false, `expanded Tauri app must not contain ${forbidden}`);
  }
  assert.ok(
    entries.some((entry) => entry.endsWith(`${PREVIEW_EXECUTABLE}.exe`) || entry.endsWith(PREVIEW_EXECUTABLE)),
    `expanded app must contain ${PREVIEW_EXECUTABLE}`,
  );
  const totalBytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
  const megabytes = totalBytes / (1024 * 1024);
  assert.ok(megabytes <= 30, `expanded Preview app must be <= 30 MB: ${megabytes.toFixed(2)} MB`);
  if (emit) {
    console.log(`ARTIFACT_SCAN_OK dir=${appDir} files=${files.length} appMb=${megabytes.toFixed(2)}`);
  }
}

function characterizeExpandedScan() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "snail-tauri-expanded-scan-"));
  try {
    writeFileSync(path.join(scratch, `${PREVIEW_EXECUTABLE}.exe`), "preview");
    assert.doesNotThrow(() => assertExpandedAppTree(scratch, { emit: false }));
    mkdirSync(path.join(scratch, ".next"));
    writeFileSync(path.join(scratch, ".next", "server.js"), "forbidden");
    assert.throws(() => assertExpandedAppTree(scratch, { emit: false }), /must not contain \.next/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function scanBundleOuter(outDir) {
  const files = walkFiles(outDir);
  const entries = files.map((file) => normalizedRelative(outDir, file).toLowerCase().replace(/\\/g, "/"));
  for (const forbidden of FORBIDDEN_BUNDLE_NEEDLES) {
    const needle = forbidden.toLowerCase();
    const hit = entries.some(
      (entry) => entry.includes(`/${needle}`) || entry.includes(needle) || entry.endsWith(needle),
    );
    assert.equal(hit, false, `Tauri artifact under ${rel(outDir)} must not contain ${forbidden}`);
  }
  const hasPreviewExe = entries.some(
    (entry) => entry.endsWith(`${PREVIEW_EXECUTABLE}.exe`) || entry.endsWith(PREVIEW_EXECUTABLE),
  );
  const previewSetups = files.filter((file) => {
    const name = path.basename(file).toLowerCase();
    return name.endsWith("-setup.exe") && name.includes("preview") && name.includes("tauri");
  });
  assert.ok(
    hasPreviewExe || previewSetups.length > 0,
    `bundle under ${rel(outDir)} must contain ${PREVIEW_EXECUTABLE}.exe or a Preview NSIS setup`,
  );
  assert.equal(
    entries.some(
      (entry) =>
        entry.endsWith(`${ELECTRON_EXECUTABLE}.exe`) || path.basename(entry) === "snailpipetsetup.exe",
    ),
    false,
    `bundle under ${rel(outDir)} must not reuse Electron executable or Squirrel setup names`,
  );
  const oversizedOffline = files.filter((file) => {
    const name = path.basename(file).toLowerCase();
    return name.includes("webview") && name.includes("offline") && statSync(file).size > 20 * 1024 * 1024;
  });
  assert.equal(oversizedOffline.length, 0, "bundle must not include WebView2 Offline/Fixed runtime");
  for (const setup of previewSetups) {
    const megabytes = statSync(setup).size / (1024 * 1024);
    console.log(`INSTALLER_SIZE_OK file=${rel(setup)} mb=${megabytes.toFixed(2)} limit=20`);
    assert.ok(megabytes <= 20, `Preview installer must be <= 20 MB under Evergreen bootstrapper: ${rel(setup)}`);
  }
  console.log(`BUNDLE_OUTER_SCAN_OK dir=${rel(outDir)} files=${files.length} setups=${previewSetups.length}`);
}

function main() {
  console.log("smoke-desktop-tauri-package: start");

  const config = readJson(path.join(ROOT, "desktop-tauri", "src-tauri", "tauri.conf.json"));
  const cargoToml = readText(path.join(ROOT, "desktop-tauri", "src-tauri", "Cargo.toml"));
  const capabilities = readJson(path.join(ROOT, "desktop-tauri", "src-tauri", "capabilities", "default.json"));
  const rootPkg = readJson(path.join(ROOT, "package.json"));
  const tauriPkg = readJson(path.join(ROOT, "desktop-tauri", "package.json"));
  const gitignore = readText(path.join(ROOT, ".gitignore"));
  const validation = readText(path.join(ROOT, "docs", "operations", "desktop-pet-tauri-validation.md"));
  const adr = readText(path.join(ROOT, "docs", "architecture", "decisions", "desktop-pet-tauri-migration.md"));
  const settingsSrc = readText(path.join(ROOT, "desktop-tauri", "src-tauri", "src", "settings.rs"));
  const isolationSrc = readText(path.join(ROOT, "desktop-tauri", "src-tauri", "tests", "isolation.rs"));
  const benchmark = readText(path.join(ROOT, "scripts", "benchmark-desktop-runtimes.ps1"));

  assert.equal(tauriPkg.private, true);
  assert.equal(tauriPkg.name, "snail-pi-pet-tauri-preview");
  assert.equal(config.identifier, PREVIEW_IDENTIFIER);
  assert.notEqual(config.identifier, ELECTRON_IDENTIFIER);
  assert.notEqual(config.productName, ELECTRON_PRODUCT);
  assert.match(String(config.productName), /Preview/);
  assert.match(cargoToml, /name\s*=\s*"snail-pi-pet-tauri-preview"/);
  assert.doesNotMatch(cargoToml, new RegExp(`name\\s*=\\s*"${ELECTRON_EXECUTABLE}"`));
  assert.deepEqual(config.bundle?.targets, ["nsis"]);
  assert.equal(config.bundle?.createUpdaterArtifacts, false);
  assert.equal(config.bundle?.windows?.webviewInstallMode?.type, "embedBootstrapper");
  assert.equal(FORBIDDEN_WEBVIEW_MODES.has(config.bundle?.windows?.webviewInstallMode?.type), false);
  assert.ok(ALLOWED_WEBVIEW_MODES.has(config.bundle?.windows?.webviewInstallMode?.type));
  assert.equal(config.bundle?.windows?.certificateThumbprint, null);
  assert.equal(config.bundle?.windows?.digestAlgorithm, "sha256");
  assert.equal(config.bundle?.windows?.nsis?.installMode, "currentUser");
  assert.match(String(config.bundle?.windows?.nsis?.startMenuFolder ?? ""), /Preview/);
  assert.notEqual(config.bundle?.windows?.nsis?.startMenuFolder, ELECTRON_PRODUCT);

  const files = rootPkg.files ?? [];
  for (const entry of files) {
    const normalized = String(entry).replace(/\\/g, "/");
    assert.equal(
      normalized === "desktop-tauri" || normalized.startsWith("desktop-tauri/"),
      false,
      `npm files must not include desktop-tauri: ${entry}`,
    );
  }
  assert.ok(rootPkg.scripts?.["test:desktop-tauri-package"]);
  assert.ok(rootPkg.scripts?.["desktop:tauri:build"]);
  assert.ok(rootPkg.scripts?.["desktop:package"]);
  assert.doesNotMatch(String(rootPkg.scripts["desktop:package"]), /tauri/i);
  assert.doesNotMatch(String(rootPkg.scripts["desktop:make"]), /tauri/i);

  const required = [
    "desktop-tauri/src-tauri/tauri.conf.json",
    "desktop-tauri/src-tauri/capabilities/default.json",
    "desktop-tauri/src-tauri/src/lib.rs",
    "desktop-tauri/src-tauri/src/settings.rs",
    "desktop-tauri/src-tauri/src/access_key.rs",
    "desktop-tauri/src-tauri/tests/isolation.rs",
    "desktop-tauri/src/tauri-bridge.ts",
    "scripts/build-desktop-tauri.mjs",
    "scripts/smoke-desktop-tauri-package.mjs",
    "scripts/benchmark-desktop-runtimes.ps1",
    "scripts/fixtures/desktop-pet-host/electron-settings-import.json",
    "docs/operations/desktop-pet-tauri-validation.md",
    "docs/architecture/decisions/desktop-pet-tauri-migration.md",
    "desktop/assets/icons/icon.ico",
    "desktop/assets/icons/icon.png",
  ];
  for (const file of required) {
    assert.ok(existsSync(path.join(ROOT, file)), `missing required file: ${file}`);
  }

  for (const file of walkFiles(path.join(ROOT, "desktop-tauri", "src-tauri", "src"))) {
    if (!/\.(rs|ts|js)$/.test(file)) continue;
    assertNoServiceControl(readText(file), rel(file));
  }
  assertNoServiceControl(readText(path.join(ROOT, "desktop-tauri", "src", "tauri-bridge.ts")), "tauri-bridge");

  const rustLib = readText(path.join(ROOT, "desktop-tauri", "src-tauri", "src", "lib.rs"));
  assert.match(settingsSrc, /map_electron_settings_preview/);
  assert.match(settingsSrc, /Read-only mapper/);
  assert.match(settingsSrc, /Never writes files/);
  assert.ok(settingsSrc.includes(ELECTRON_SETTINGS));
  assert.ok(rustLib.includes(PREVIEW_SETTINGS));
  assert.doesNotMatch(settingsSrc, /fs::write\(\s*electron_settings_file_path/);
  assert.ok(isolationSrc.includes("TAURI_PREVIEW_IDENTIFIER"));
  assert.match(isolationSrc, /embedBootstrapper/);

  const capabilityText = (capabilities.permissions ?? []).join("\n").toLowerCase();
  for (const forbidden of ["shell", "process", "fs:", "http:", "opener", "*"]) {
    assert.equal(capabilityText.includes(forbidden), false, `capability must not include ${forbidden}`);
  }

  for (const ae of ["AE1", "AE2", "AE5", "AE6", "AE7", "AE8", "AE9", "AE10", "AE11", "AE12", "AE13", "QS1", "QS5"]) {
    assert.ok(validation.includes(ae), `Tauri validation doc must mention ${ae}`);
  }
  assert.ok(validation.includes("Gate D"));
  assert.ok(/未执行|Manual|not executed/i.test(validation));
  assert.ok(validation.includes("WebView2"));
  assert.ok(validation.includes("~/.pi/agent") || validation.includes(".pi/agent"));
  assert.ok(validation.includes(PREVIEW_IDENTIFIER));
  assert.ok(adr.includes(PREVIEW_IDENTIFIER));
  assert.ok(adr.includes("embedBootstrapper"));
  assert.ok(adr.includes("downloadBootstrapper"));
  assert.ok(/offlineInstaller|Fixed Runtime|fixedRuntime/.test(adr));
  assert.ok(adr.includes("Proceed") && adr.includes("Extend") && adr.includes("Stop"));
  assert.match(benchmark, /privateWorkingSet/i);
  assert.match(benchmark, /connected-idle|connected_idle|ConnectedIdle/i);
  assert.match(benchmark, /WebView2/);
  assert.match(benchmark, /installerMb\s*=\s*20/);
  assert.match(benchmark, /appDirMb\s*=\s*30/);
  assert.match(benchmark, /idlePrivateWorkingSetReduction\s*=\s*0\.30/);
  assert.doesNotMatch(benchmark, /offlineInstaller|fixedRuntime/);

  for (const ignored of [
    "/desktop-tauri/dist/",
    "/desktop-tauri/src-tauri/target/",
    "/desktop-tauri/.benchmark/",
  ]) {
    assert.ok(gitignore.includes(ignored), `missing generated-output ignore: ${ignored}`);
  }

  const deploy = readText(path.join(ROOT, "docs", "deployment", "README.md"));
  const troubleshooting = readText(path.join(ROOT, "docs", "operations", "troubleshooting.md"));
  assert.ok(/Tauri Preview|desktop-tauri/i.test(deploy), "deployment README must mention Tauri Preview");
  assert.ok(deploy.includes("spi --no-open"));
  assert.ok(/Tauri Preview|desktop-tauri/i.test(troubleshooting), "troubleshooting must mention Tauri Preview");

  rehearseSettingsMigration();
  const frontendDist = path.join(ROOT, "desktop-tauri", "dist");
  if (existsSync(frontendDist)) {
    assertFrontendDist(frontendDist);
  } else {
    console.log("FRONTEND_DIST_SKIPPED run desktop:tauri:build-ui to generate the clean allowlisted dist");
  }
  characterizeExpandedScan();

  const defaultBundle = path.join(ROOT, "desktop-tauri", "src-tauri", "target", "release", "bundle");
  const outCandidates = process.env.DESKTOP_TAURI_PACKAGE_OUT
    ? [process.env.DESKTOP_TAURI_PACKAGE_OUT]
    : [defaultBundle];

  let scannedArtifact = false;
  for (const outDir of outCandidates) {
    if (!existsSync(outDir)) continue;
    scannedArtifact = true;
    scanBundleOuter(outDir);
  }
  if (!scannedArtifact) {
    console.log("BUNDLE_OUTER_SCAN_SKIPPED no Tauri bundle directory (expected until desktop:tauri:build)");
  }

  const expandedAppDir = process.env.DESKTOP_TAURI_EXPANDED_APP_DIR;
  if (expandedAppDir) {
    assert.ok(existsSync(expandedAppDir), `expanded Tauri app directory missing: ${expandedAppDir}`);
    assertExpandedAppTree(expandedAppDir);
  } else {
    console.log("ARTIFACT_SCAN_SKIPPED no expanded Tauri application tree; set DESKTOP_TAURI_EXPANDED_APP_DIR after unpack/install");
  }

  console.log(
    `PACKAGE_CONTRACT_OK identifier=${PREVIEW_IDENTIFIER} exe=${PREVIEW_EXECUTABLE} settings=${PREVIEW_SETTINGS} accessKey=${PREVIEW_ACCESS_KEY} webview=embedBootstrapper`,
  );
  console.log("smoke-desktop-tauri-package: ok");
}

main();
