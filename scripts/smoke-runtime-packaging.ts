import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import nextConfig from "../next.config";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function checkServerExternals(): void {
  assert(
    nextConfig.serverExternalPackages?.includes("ws"),
    "ws must remain external so its optional native modules resolve at runtime",
  );
}

function checkPublishedLauncher(): void {
  const launcher = readFileSync(join(ROOT, "bin", "pi-web.js"), "utf8");
  const executableSource = launcher
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  assert(!/shell\s*:\s*true/.test(executableSource), "published launcher must not spawn with shell: true");
  assert(launcher.includes('"explorer.exe"'), "Windows browser launch must use explorer.exe directly");
}

checkServerExternals();
checkPublishedLauncher();
console.log("runtime packaging smoke checks passed");
