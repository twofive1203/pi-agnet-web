import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON_IDENTIFIER = "com.twofive.snail-pi-pet";
const ELECTRON_EXECUTABLE = "snail-pi-pet";

function read(relativePath: string): string {
  const absolutePath = path.join(ROOT, relativePath);
  assert.ok(existsSync(absolutePath), `missing Phase A file: ${relativePath}`);
  return readFileSync(absolutePath, "utf8");
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(read(relativePath)) as T;
}

function assertNoServiceControl(source: string, label: string): void {
  assert.equal(/child_process|Command::new|std::process::Command|process\.kill/.test(source), false,
    `${label} must remain attach-only and must not control spi`);
}

console.log("smoke-desktop-tauri-contract: start");

const rootPackage = readJson<{
  files?: string[];
  scripts?: Record<string, string>;
}>("package.json");
const tauriPackage = readJson<{
  name: string;
  private: boolean;
  scripts?: Record<string, string>;
}>("desktop-tauri/package.json");
const config = readJson<{
  productName: string;
  identifier: string;
  build?: { frontendDist?: string; beforeDevCommand?: string; beforeBuildCommand?: string };
  app?: {
    windows?: Array<Record<string, unknown>>;
    security?: { csp?: string };
  };
  bundle?: {
    windows?: { webviewInstallMode?: { type?: string } };
  };
}>("desktop-tauri/src-tauri/tauri.conf.json");
const capabilities = readJson<{
  identifier: string;
  windows: string[];
  permissions: string[];
}>("desktop-tauri/src-tauri/capabilities/default.json");
const cargoToml = read("desktop-tauri/src-tauri/Cargo.toml");
const rustLib = read("desktop-tauri/src-tauri/src/lib.rs");
const rustMain = read("desktop-tauri/src-tauri/src/main.rs");
const windowController = read("desktop-tauri/src-tauri/src/window_controller.rs");
const trayController = read("desktop-tauri/src-tauri/src/tray_controller.rs");
const observerClient = read("desktop-tauri/src-tauri/src/observer_client.rs");
const connectionState = read("desktop-tauri/src-tauri/src/connection_state.rs");
const activityView = read("desktop-tauri/src-tauri/src/activity_view.rs");
const appState = read("desktop-tauri/src-tauri/src/app_state.rs");
const settings = read("desktop-tauri/src-tauri/src/settings.rs");
const accessKey = read("desktop-tauri/src-tauri/src/access_key.rs");
const customPets = read("desktop-tauri/src-tauri/src/custom_pets.rs");
const deepLinks = read("desktop-tauri/src-tauri/src/deep_links.rs");
const notifications = read("desktop-tauri/src-tauri/src/notifications.rs");
const native = read("desktop-tauri/src-tauri/src/native.rs");
const quickSession = read("desktop-tauri/src-tauri/src/quick_session_client.rs");
const bridge = read("desktop-tauri/src/tauri-bridge.ts");
const rendererHtml = read("desktop/renderer/index.html");
const buildScript = read("scripts/build-desktop-tauri.mjs");
const gitignore = read(".gitignore");
const forgeConfig = read("forge.config.ts");
const eslintConfig = read("eslint.config.mjs");
const validation = read("docs/operations/desktop-pet-tauri-validation.md");

assert.equal(tauriPackage.private, true);
assert.equal(tauriPackage.name, "snail-pi-pet-tauri-preview");
assert.notEqual(config.identifier, ELECTRON_IDENTIFIER);
assert.match(config.identifier, /tauri-preview$/);
assert.notEqual(config.productName, "SnailPiPet");
assert.match(config.productName, /Preview/);
assert.match(cargoToml, /name\s*=\s*"snail-pi-pet-tauri-preview"/);
assert.match(cargoToml, /tauri-plugin-single-instance/);
assert.match(rustLib, /TAURI_SETTINGS_FILE_NAME\s*:\s*&str\s*=\s*"tauri-preview-settings\.json"/);
assert.doesNotMatch(rustLib, /desktop-pet-settings\.json/);
assert.doesNotMatch(cargoToml, new RegExp(`name\\s*=\\s*"${ELECTRON_EXECUTABLE}"`));

for (const command of [
  "desktop:tauri:build-ui",
  "desktop:tauri:dev",
  "desktop:tauri:build",
  "test:desktop-tauri-contract",
]) {
  assert.ok(rootPackage.scripts?.[command], `root package must define ${command}`);
}
for (const electronCommand of ["desktop:build", "desktop:dev", "desktop:package", "desktop:make"]) {
  assert.ok(rootPackage.scripts?.[electronCommand], `Electron command changed or missing: ${electronCommand}`);
  assert.doesNotMatch(rootPackage.scripts?.[electronCommand] ?? "", /tauri/i);
}
assert.equal(rootPackage.files?.some((entry) => entry === "desktop-tauri" || entry.startsWith("desktop-tauri/")), false,
  "npm spi package must not publish desktop-tauri");
assert.doesNotMatch(forgeConfig, /desktop-tauri|tauri-preview/i,
  "Electron Forge configuration must not read Tauri outputs");

assert.equal(config.build?.frontendDist, "../dist");
assert.match(config.build?.beforeDevCommand ?? "", /build-desktop-tauri/);
assert.match(config.build?.beforeBuildCommand ?? "", /build-desktop-tauri/);
assert.equal(config.bundle?.windows?.webviewInstallMode?.type, "embedBootstrapper");
const petWindow = config.app?.windows?.find((candidate) => candidate.label === "pet");
assert.ok(petWindow, "Tauri config must define the pet window");
assert.equal(petWindow.transparent, true);
assert.equal(petWindow.decorations, false);
assert.equal(petWindow.alwaysOnTop, true);
assert.equal(petWindow.visible, false);
assert.equal(petWindow.focus, false);
assert.equal(petWindow.resizable, false);
assert.match(config.app?.security?.csp ?? "", /connect-src\s+'none'/);

assert.match(capabilities.identifier, /phase-[a-c]-/);
assert.deepEqual(capabilities.windows, ["pet"]);
const capabilityText = capabilities.permissions.join("\n").toLowerCase();
for (const forbidden of ["shell", "process", "fs:", "http:", "opener", "*"]) {
  assert.equal(capabilityText.includes(forbidden), false, `capability must not include ${forbidden}`);
}

assert.match(bridge, /Object\.freeze/);
assert.match(bridge, /window\.snailPet/);
assert.match(bridge, /onStateChanged/);
assert.match(bridge, /getState/);
assert.doesNotMatch(bridge, /__TAURI_INTERNALS__|__TAURI__/, "bridge must not depend on a global generic invoke surface");
assert.match(rendererHtml, /Content-Security-Policy/);
assert.match(rendererHtml, /connect-src 'none'/);
assert.match(rendererHtml, /pet-app\.js/);
assert.match(buildScript, /desktop\/renderer/);
assert.match(buildScript, /tauri-bridge/);
assert.match(buildScript, /desktop-tauri["'],\s*["']dist/);
assert.match(connectionState, /127\.0\.0\.1/);
assert.match(observerClient, /is_loopback_observer_url/);
assert.match(activityView, /assert_renderer_view_safe/);
assert.match(appState, /pet:state-changed/);
assert.match(settings, /TAURI_SETTINGS_FILE_NAME/);
assert.match(accessKey, /tauri-preview-access-key\.json/);
assert.match(accessKey, /ELECTRON_ACCESS_KEY_FILE_NAME/);
assert.match(accessKey, /is_available/);
assert.match(settings, /ELECTRON_SETTINGS_FILE_NAME/);
assert.match(customPets, /symlink_escape/);
assert.match(deepLinks, /absolute_url_rejected/);
assert.match(notifications, /needs_input/);
assert.match(native, /SnailPiPetTauriPreview/);
assert.match(quickSession, /x-spi-desktop-control-token/);
assert.match(appState, /save_desktop_settings/);

for (const [label, source] of [
  ["Rust lib", rustLib],
  ["Rust main", rustMain],
  ["window controller", windowController],
  ["tray controller", trayController],
  ["observer client", observerClient],
  ["connection state", connectionState],
  ["app state", appState],
  ["settings", settings],
  ["access key", accessKey],
  ["custom pets", customPets],
  ["deep links", deepLinks],
  ["notifications", notifications],
  ["native", native],
  ["quick session", quickSession],
  ["Tauri bridge", bridge],
] as const) {
  assertNoServiceControl(source, label);
}
assert.match(rustLib, /tauri_plugin_single_instance::init/);
assert.match(windowController, /set_ignore_cursor_events/);
assert.match(windowController, /show_inactive/);
assert.match(trayController, /disable-click-through/);
assert.match(trayController, /quit-preview/);

for (const ignored of [
  "/desktop-tauri/node_modules/",
  "/desktop-tauri/dist/",
  "/desktop-tauri/src-tauri/target/",
  "/desktop-tauri/src-tauri/gen/",
]) {
  assert.ok(gitignore.includes(ignored), `missing generated-output ignore: ${ignored}`);
}
for (const ignored of [
  "desktop-tauri/dist/**",
  "desktop-tauri/src-tauri/target/**",
  "desktop-tauri/src-tauri/gen/**",
]) {
  assert.ok(eslintConfig.includes(ignored), `ESLint must ignore generated Tauri output: ${ignored}`);
}
assert.match(validation, /Gate A/);
assert.match(validation, /未执行/);
assert.match(validation, /100%/);
assert.match(validation, /150%/);
assert.match(validation, /200%/);
assert.match(validation, /点击穿透/);
assert.match(validation, /虚拟桌面/);
assert.match(validation, /Windows 10/);
assert.match(validation, /Windows 11/);

console.log("smoke-desktop-tauri-contract: ok");
