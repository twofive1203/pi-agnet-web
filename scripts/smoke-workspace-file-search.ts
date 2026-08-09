import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { searchWorkspaceFiles } from "../lib/workspace-file-search";

async function main(): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-web-file-search-"));
  try {
    await mkdir(path.join(cwd, "src", "nested"), { recursive: true });
    await mkdir(path.join(cwd, "node_modules", "ignored"), { recursive: true });
    await writeFile(path.join(cwd, "src", "alpha.ts"), "export {}\n", "utf8");
    await writeFile(path.join(cwd, "src", "nested", "AlphaView.tsx"), "export {}\n", "utf8");
    await writeFile(path.join(cwd, "src", "nested", "beta.ts"), "export {}\n", "utf8");
    await writeFile(path.join(cwd, "node_modules", "ignored", "alpha.js"), "", "utf8");

    const matches = await searchWorkspaceFiles(cwd, "alpha", { deadlineMs: 5_000 });
    assert.deepEqual(
      matches.files.map((file) => file.relativePath.replaceAll("\\", "/")).sort(),
      ["src/alpha.ts", "src/nested/AlphaView.tsx"],
    );
    assert.equal(matches.total, 2);
    assert.equal(matches.truncated, false);

    const capped = await searchWorkspaceFiles(cwd, "", { maxResults: 2, deadlineMs: 5_000 });
    assert.equal(capped.files.length, 2);
    assert.equal(capped.truncated, true);

    const budgeted = await searchWorkspaceFiles(cwd, "missing", { maxEntries: 2, deadlineMs: 5_000 });
    assert.equal(budgeted.truncated, true);
    assert.ok(budgeted.scannedEntries <= 2);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      searchWorkspaceFiles(cwd, "alpha", { signal: controller.signal }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );

    console.log("smoke-workspace-file-search: OK");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
