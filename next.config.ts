import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-tui",
    "glob",
    "@lydell/node-pty",
    "ws",
  ],
  // Ensure standalone Automation worker + discovery artifacts are available in traced/published runtime.
  outputFileTracingIncludes: {
    "/*": [
      "./lib/automation-worker-runtime.cjs",
      "./lib/automation-worker-runtime.meta.json",
      "./lib/automation-worker-host.ts",
      "./lib/automation-extension-discovery-runtime.cjs",
      "./lib/automation-extension-discovery-runtime.meta.json",
      "./lib/automation-extension-discovery-host.ts",
    ],
    "/api/*": [
      "./lib/automation-worker-runtime.cjs",
      "./lib/automation-worker-runtime.meta.json",
      "./lib/automation-worker-host.ts",
      "./lib/automation-extension-discovery-runtime.cjs",
      "./lib/automation-extension-discovery-runtime.meta.json",
      "./lib/automation-extension-discovery-host.ts",
    ],
  },
  outputFileTracingExcludes: {
    "/*": [".pi/**/*"],
    "/api/*": [".pi/**/*"],
  },
  allowedDevOrigins: ["192.168.*.*", "127.0.0.1", "localhost"],
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;
