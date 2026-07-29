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
