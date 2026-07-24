#!/usr/bin/env npx tsx
/**
 * Project-local SnFlow CLI wrapper for the Snail Pi Web development workflow.
 * Loads the WebUI package script in-process via dynamic import.
 * Uses async IIFE to avoid top-level await (portable across CJS/ESM).
 *
 * Managed by SnFlow setup — do not hand-edit; re-run Update SnFlow instead.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const WEBUI_ROOT = "D:\\workspace\\aiwork\\pi-agnet-web";
const TARGET = path.join(WEBUI_ROOT, "scripts", "workflow-task.ts");

if (!existsSync(TARGET)) {
  console.error(
    "snflow-task: Snail Pi Web workflow-task.ts not found at " + TARGET,
    "Re-run SnFlow Update from the WebUI Settings panel, or check WebUI package installation.",
  );
  process.exit(2);
}

(async () => {
  try {
    const { main } = await import(pathToFileURL(TARGET).href);
    await main();
  } catch (error) {
    console.error("snflow-task:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
})();
