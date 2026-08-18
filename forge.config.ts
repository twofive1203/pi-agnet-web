/**
 * Electron Forge config — pet-only Windows package (U8 hardened).
 *
 * HARD RULES:
 * - Package the desktop pet ONLY.
 * - Do NOT bundle Next.js, pi SDK, Automation workers, node-pty, or a Node sidecar.
 * - Separate from the npm `spi` publish surface (`package.json#files` must not include desktop/).
 * - Signing is optional at build time via env placeholders; unsigned builds are for local QA only.
 *
 * Validation: `npm run test:desktop-package` → `scripts/smoke-desktop-package.mjs`
 *
 * Typed loosely so `tsc` does not require `@electron-forge/*` at install time.
 */

/** Paths that must never appear inside a pet package / asar. */
export const DESKTOP_FORBIDDEN_BUNDLE_PATHS = [
  ".next",
  ".preview",
  "app/api",
  "bin/pi-web.js",
  "node_modules/next",
  "node_modules/@lydell/node-pty",
  "node_modules/node-pty",
  "node_modules/@earendil-works/pi-coding-agent",
  "node_modules/@earendil-works/pi-ai",
  "node_modules/pi-subagents",
  "node_modules/pi-ask-user",
  "lib/rpc-manager.ts",
  "lib/automation-runner.ts",
  "lib/quick-command-runner.ts",
  "instrumentation.ts",
  "ecosystem.config.cjs",
  "codex-ui-resouce",
] as const;

/** electron-packager ignore patterns (path relative to project root, leading /). */
export const DESKTOP_PACKAGER_IGNORE: Array<RegExp | string> = [
  // WebUI / service runtime
  /^\/app(\/|$)/,
  /^\/\.next(\/|$)/,
  /^\/bin(\/|$)/,
  /^\/components(\/|$)/,
  /^\/hooks(\/|$)/,
  /^\/public(\/|$)/,
  /^\/extensions(\/|$)/,
  /^\/docs(\/|$)/,
  /^\/scripts(\/|$)/,
  /^\/assets(\/|$)/, // copied once via extraResource into resources/assets
  /^\/\.preview(\/|$)/,
  /^\/desktop\/\.preview(\/|$)/,
  /^\/\.build-stamp\.json$/,
  /^\/README\.md$/,
  /^\/tests(\/|$)/,
  /^\/\.pi(\/|$)/,
  /^\/\.trellis(\/|$)/,
  /^\/instrumentation\.ts$/,
  /^\/proxy\.ts$/,
  /^\/next\.config\.ts$/,
  /^\/ecosystem\.config\.cjs$/,
  // Server-side lib (pet imports only a few pure modules via relative paths from desktop/)
  // Prefer packaging a compiled desktop bundle in a later slice; until then ignore heavy trees.
  /^\/lib\/rpc-manager\.ts$/,
  /^\/lib\/automation-.*$/,
  /^\/lib\/quick-command-.*$/,
  /^\/lib\/workflow-.*$/,
  /^\/lib\/session-.*$/,
  // Native / pi stacks
  /^\/node_modules\/next(\/|$)/,
  /^\/node_modules\/@lydell\/node-pty(\/|$)/,
  /^\/node_modules\/node-pty(\/|$)/,
  /^\/node_modules\/@earendil-works\/pi-coding-agent(\/|$)/,
  /^\/node_modules\/@earendil-works\/pi-ai(\/|$)/,
  /^\/node_modules\/pi-subagents(\/|$)/,
  /^\/node_modules\/pi-ask-user(\/|$)/,
  /^\/node_modules\/pi-manage-todo-list(\/|$)/,
  /node-pty/,
  // Dev noise
  /^\/\.git(\/|$)/,
  /^\/out(\/|$)/,
  /^\/coverage(\/|$)/,
  /^\/codex-ui-resouce(\/|$)/,
  /\.(?:ts|tsx)$/,
  /\.map$/,
];

/**
 * Static package contract consumed by smokes and docs.
 * Keep in sync with packagerConfig / makers below.
 */
export const DESKTOP_PACKAGE_CONTRACT = {
  productName: "SnailPiPet",
  executableName: "snail-pi-pet",
  appUserModelId: "com.twofive.snail-pi-pet",
  appBundleId: "com.twofive.snail-pi-pet",
  petOnly: true,
  separateFromNpmSpi: true,
  requiresNodeJs: false,
  /** Official service remains a separate install/launch (`spi` / npm). */
  serviceLaunchCommand: "spi --no-open",
  defaultOrigin: "http://127.0.0.1:62666",
  forbiddenBundlePaths: DESKTOP_FORBIDDEN_BUNDLE_PATHS,
  /** Env vars reserved for authenticode / CI signing (not required for local pack). */
  signingEnvPlaceholders: [
    "WINDOWS_CERTIFICATE_FILE",
    "WINDOWS_CERTIFICATE_PASSWORD",
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
  ] as const,
  /** userData relative settings filename — uninstall must not delete ~/.pi/agent. */
  settingsFileName: "desktop-pet-settings.json",
  agentDataDirNote: "~/.pi/agent is owned by spi; pet uninstall must leave it untouched",
} as const;

const WINDOWS_ICON = "assets/icons/icon";
const WINDOWS_ICON_ICO = "desktop/assets/icons/icon.ico";
const signingCertificateFile = process.env.WINDOWS_CERTIFICATE_FILE;
const signingCertificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD;

const config = {
  packagerConfig: {
    name: DESKTOP_PACKAGE_CONTRACT.productName,
    executableName: DESKTOP_PACKAGE_CONTRACT.executableName,
    appBundleId: DESKTOP_PACKAGE_CONTRACT.appBundleId,
    asar: true,
    prune: true,
    icon: WINDOWS_ICON,
    ignore: DESKTOP_PACKAGER_IGNORE,
    extraResource: ["desktop/assets"],
    appCopyright: "Snail Pi contributors",
    win32metadata: {
      CompanyName: "Snail Pi",
      FileDescription: "Snail Pi desktop pet task observer (attach-only)",
      OriginalFilename: `${DESKTOP_PACKAGE_CONTRACT.executableName}.exe`,
      ProductName: DESKTOP_PACKAGE_CONTRACT.productName,
      InternalName: DESKTOP_PACKAGE_CONTRACT.executableName,
      // AppUserModelID is also set at runtime in desktop/main/main.ts
    },
    // Do not set protocols that would imply service control.
  },
  rebuildConfig: {
    // Pet must not rebuild native node-pty / pi bindings.
    onlyModules: [],
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: DESKTOP_PACKAGE_CONTRACT.productName,
        exe: `${DESKTOP_PACKAGE_CONTRACT.executableName}.exe`,
        authors: "Snail Pi",
        description: "Snail Pi desktop pet task observer (attach-only). Does not include the spi service.",
        iconUrl: "https://raw.githubusercontent.com/twofive1203/pi-agnet-web/main/desktop/assets/icons/icon.ico",
        setupIcon: WINDOWS_ICON_ICO,
        // electron-winstaller's legacy Update.exe cannot always accept modern ICOs;
        // Setup.exe and the packaged app still receive the branded icon.
        skipUpdateIcon: true,
        loadingGif: undefined,
        setupExe: `${DESKTOP_PACKAGE_CONTRACT.productName}Setup.exe`,
        noMsi: true,
        ...(signingCertificateFile && signingCertificatePassword
          ? {
              certificateFile: signingCertificateFile,
              certificatePassword: signingCertificatePassword,
            }
          : {}),
      },
    },
  ],
  plugins: [] as unknown[],
  // hooks reserved for U8+ artifact post-checks (optional):
  // hooks: { postMake: [async (_cfg, results) => { ... scan results for forbidden paths }] }
};

export default config;
