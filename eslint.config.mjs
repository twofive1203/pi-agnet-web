import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      ".pi/**",
      ".trellis/**",
      "scripts/**/*.cjs",
      // Compiled standalone Automation worker / discovery artifacts (esbuild CJS output).
      "lib/automation-worker-runtime.cjs",
      "lib/automation-worker-runtime.meta.json",
      "lib/automation-extension-discovery-runtime.cjs",
      "lib/automation-extension-discovery-runtime.meta.json",
      // Desktop pet Electron bundles (esbuild CJS output).
      "desktop/main/main.js",
      "desktop/main/main.js.map",
      "desktop/preload/pet-preload.js",
      "desktop/preload/pet-preload.js.map",
      "desktop/.build-stamp.json",
      // Plain runtime companion checked in for file:// loading without a bundler step.
      // Keep lint on pet-app.tsx / pet-state.ts instead.
      "desktop/renderer/pet-app.js",
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
