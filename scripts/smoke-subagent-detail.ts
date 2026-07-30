import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSubagentDetail } from "../lib/parse-subagent-children";

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-detail-"));
  const sessionFile = join(dir, "session.jsonl");

  try {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        timestamp: 1,
        content: [{
          type: "toolCall",
          toolCallId: "child-call",
          toolName: "subagent",
          input: { agent: "worker", task: "nested task" },
        }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "child-call",
        toolName: "subagent",
        content: [{ type: "text", text: "nested result" }],
        details: { results: [{ sessionFile: join(dir, "nested", "session.jsonl") }] },
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        timestamp: 2,
        content: [{ type: "text", text: "final child output" }],
      },
    },
  ];
  await writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const detail = await parseSubagentDetail(sessionFile, 1);
  assert.equal(detail.depth, 1);
  assert.equal(detail.output, "final child output");
  assert.equal(detail.children.length, 1);
  assert.equal(detail.children[0]?.agent, "worker");
  assert.equal(detail.children[0]?.status, "completed");
  assert.match(detail.fingerprint, /^v1:\d+:\d+$/);
  assert.equal(detail.fileTruncated, false);

  const bounded = await parseSubagentDetail(sessionFile, 2, {
    maxChildren: 0,
    maxOutputChars: 5,
  });
  assert.equal(bounded.children.length, 0);
  assert.equal(bounded.childrenTruncated, true);
  assert.equal(bounded.output, "utput");
  assert.equal(bounded.outputTruncated, true);

  await writeFile(sessionFile, `${"x".repeat(256)}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const byteBounded = await parseSubagentDetail(sessionFile, 1, { maxBytes: 128 });
  assert.equal(byteBounded.fileTruncated, true);
  assert.equal(byteBounded.outputTruncated, true);

  const manyChildren = Array.from({ length: 20 }, (_, index) => ([
    {
      type: "message",
      message: {
        role: "assistant",
        timestamp: index,
        content: [{
          type: "toolCall",
          toolCallId: `child-${index}`,
          toolName: "subagent",
          input: { agent: "worker", task: `task-${index}` },
        }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: `child-${index}`,
        toolName: "subagent",
        content: [{ type: "text", text: `done-${index}` }],
      },
    },
  ])).flat();
  await writeFile(sessionFile, `${manyChildren.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const newestChildren = await parseSubagentDetail(sessionFile, 1);
  assert.equal(newestChildren.children.length, 16);
  assert.equal(newestChildren.children[0]?.id, "child-4");
  assert.equal(newestChildren.children.at(-1)?.id, "child-19");

  await writeFile(
    sessionFile,
    `${"x".repeat(1_100_000)}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const tailBounded = await parseSubagentDetail(sessionFile, 1);
  assert.equal(tailBounded.fileTruncated, true);
  assert.equal(tailBounded.output, "final child output", "tail window must retain latest assistant output");
  assert.equal(tailBounded.children[0]?.status, "completed", "tail window must retain direct child completion");

    console.log("smoke-subagent-detail: OK");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
