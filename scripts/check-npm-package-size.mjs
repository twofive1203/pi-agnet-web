#!/usr/bin/env node
"use strict";

import { spawnSync } from "node:child_process";
import process from "node:process";

const MAX_UNPACKED_BYTES = 75_000_000;
const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath
  ? process.execPath
  : process.platform === "win32"
    ? "npm.cmd"
    : "npm";
const npmArgs = [
  ...(npmExecPath ? [npmExecPath] : []),
  "pack",
  "--dry-run",
  "--json",
  "--ignore-scripts",
];

const packed = spawnSync(
  npmCommand,
  npmArgs,
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  },
);

if (packed.status !== 0) {
  const detail = packed.error?.message || packed.stderr || packed.stdout;
  console.error(detail || "npm pack --dry-run failed");
  process.exit(packed.status ?? 1);
}

let reports;
try {
  reports = JSON.parse(packed.stdout);
} catch (error) {
  console.error("npm pack --dry-run returned invalid JSON");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const report = reports?.[0];
if (!report || !Array.isArray(report.files)) {
  console.error("npm pack --dry-run did not return a package file manifest");
  process.exit(1);
}

const paths = report.files.map((file) => file.path);
const requiredPaths = [
  ".next/BUILD_ID",
  ".next/required-server-files.json",
  "bin/pi-web.js",
];
for (const requiredPath of requiredPaths) {
  if (!paths.includes(requiredPath)) {
    console.error(`Published package is missing required runtime file: ${requiredPath}`);
    process.exit(1);
  }
}

if (!paths.some((path) => path.startsWith(".next/server/") && path.endsWith(".js"))) {
  console.error("Published package is missing compiled Next.js server files");
  process.exit(1);
}
if (!paths.some((path) => path.startsWith(".next/static/"))) {
  console.error("Published package is missing compiled Next.js static assets");
  process.exit(1);
}

const forbiddenPaths = paths.filter(
  (path) =>
    path.endsWith(".nft.json") ||
    path === ".next/trace" ||
    path === ".next/trace-build" ||
    path.startsWith(".next/types/") ||
    path.startsWith(".next/diagnostics/"),
);
if (forbiddenPaths.length > 0) {
  console.error("Published package contains build-only Next.js artifacts:");
  for (const path of forbiddenPaths.slice(0, 20)) console.error(`- ${path}`);
  process.exit(1);
}

if (report.unpackedSize > MAX_UNPACKED_BYTES) {
  console.error(
    `Published package unpacked size ${formatBytes(report.unpackedSize)} exceeds the ${formatBytes(MAX_UNPACKED_BYTES)} mirror budget`,
  );
  process.exit(1);
}

console.log(
  `NPM_PACKAGE_SIZE_OK packed=${formatBytes(report.size)} unpacked=${formatBytes(report.unpackedSize)} files=${report.entryCount}`,
);

function formatBytes(bytes) {
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}
