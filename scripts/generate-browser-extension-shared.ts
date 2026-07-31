/**
 * Generate extension-side copies of shared browser policy/redaction logic
 * from the TypeScript sources under lib/.
 *
 * Source of truth:
 *   - lib/browser-action-policy.ts
 *   - lib/browser-redaction.ts
 *   - lib/browser-protocol.ts (protocol version + advertised extension features)
 *
 * Outputs:
 *   - extensions/chrome-tab-debug/action-policy.js (ESM)
 *   - extensions/chrome-tab-debug/action-policy.inject.js (classic IIFE for content)
 *   - extensions/chrome-tab-debug/redaction.js (ESM)
 *   - extensions/chrome-tab-debug/protocol-capabilities.js (ESM constants)
 *
 * Run: npx tsx scripts/generate-browser-extension-shared.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { BROWSER_EXTENSION_FEATURES, BROWSER_PROTOCOL_VERSION } from "../lib/browser-protocol";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(ROOT, "extensions", "chrome-tab-debug");

const HEADER = `/**
 * GENERATED FILE — do not edit by hand.
 * Source: lib/browser-*.ts via scripts/generate-browser-extension-shared.ts
 * Regenerate: npx tsx scripts/generate-browser-extension-shared.ts
 */

`;

function transpileToEsm(relPath: string): string {
  const abs = join(ROOT, relPath);
  const source = readFileSync(abs, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      removeComments: false,
    },
    fileName: abs,
  });
  if (result.diagnostics?.length) {
    const message = result.diagnostics
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
      .join("\n");
    throw new Error(`Failed to transpile ${relPath}:\n${message}`);
  }
  return result.outputText;
}

function esmToIife(esmSource: string, globalName: string): string {
  const exported = new Set<string>();
  let body = esmSource;

  body = body.replace(/export\s+async\s+function\s+([A-Za-z0-9_]+)/g, (_m, name: string) => {
    exported.add(name);
    return `async function ${name}`;
  });
  body = body.replace(/export\s+function\s+([A-Za-z0-9_]+)/g, (_m, name: string) => {
    exported.add(name);
    return `function ${name}`;
  });
  body = body.replace(/export\s+const\s+([A-Za-z0-9_]+)/g, (_m, name: string) => {
    exported.add(name);
    return `const ${name}`;
  });
  body = body.replace(/export\s+\{([^}]+)\}/g, (_m, list: string) => {
    for (const part of list.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^([A-Za-z0-9_]+)(?:\s+as\s+([A-Za-z0-9_]+))?$/);
      if (match) exported.add(match[2] || match[1]!);
    }
    return "/* export list hoisted to IIFE global */";
  });

  if (exported.size === 0) {
    throw new Error("esmToIife: no exports found to attach on global");
  }

  const names = [...exported];
  return `${HEADER}(function (global) {
"use strict";
${body}
global.${globalName} = Object.freeze({
${names.map((n) => `  ${n},`).join("\n")}
});
})(typeof globalThis !== "undefined" ? globalThis : self);
`;
}

function main(): void {
  mkdirSync(EXT_DIR, { recursive: true });

  const policyEsm = transpileToEsm("lib/browser-action-policy.ts");
  const redactionEsm = transpileToEsm("lib/browser-redaction.ts");

  writeFileSync(join(EXT_DIR, "action-policy.js"), `${HEADER}${policyEsm}`, "utf8");
  writeFileSync(join(EXT_DIR, "redaction.js"), `${HEADER}${redactionEsm}`, "utf8");
  writeFileSync(
    join(EXT_DIR, "protocol-capabilities.js"),
    `${HEADER}export const PROTOCOL_VERSION = ${BROWSER_PROTOCOL_VERSION};\nexport const EXTENSION_FEATURES = Object.freeze(${JSON.stringify(BROWSER_EXTENSION_FEATURES)});\n`,
    "utf8",
  );
  writeFileSync(
    join(EXT_DIR, "action-policy.inject.js"),
    esmToIife(policyEsm, "__snailPiActionPolicy"),
    "utf8",
  );

  console.log("generate-browser-extension-shared: wrote policy, redaction, and protocol capability artifacts");
}

main();
