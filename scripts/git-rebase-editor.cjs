#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

function fail(message) {
  process.stderr.write(`git-rebase-editor: ${message}\n`);
  process.exitCode = 2;
}

const mode = process.argv[2];
const filePath = process.argv[3];
const action = process.env.PI_GIT_REWRITE_ACTION;
const target = (process.env.PI_GIT_REWRITE_TARGET || "").toLowerCase();
const encodedMessage = process.env.PI_GIT_REWRITE_MESSAGE_BASE64 || "";

if (!filePath || !["sequence", "message"].includes(mode) || action !== "reword" || !/^[0-9a-f]{40,64}$/.test(target)) {
  fail("invalid controlled editor invocation");
} else if (mode === "sequence") {
  const current = fs.readFileSync(filePath, "utf8");
  let matched = false;
  const next = current.split(/(?<=\n)/).map((line) => line.replace(
    /^(pick)\s+([0-9a-f]+)(\s|$)/,
    (whole, command, abbreviated, suffix) => {
      const normalized = String(abbreviated).toLowerCase();
      if (matched || !(target.startsWith(normalized) || normalized.startsWith(target))) return whole;
      matched = true;
      return `reword ${abbreviated}${suffix}`;
    },
  )).join("");
  if (!matched) fail("target commit was not present in the rebase todo");
  else fs.writeFileSync(filePath, next, "utf8");
} else {
  let message;
  try {
    message = Buffer.from(encodedMessage, "base64").toString("utf8");
  } catch {
    message = "";
  }
  if (!message.trim()) fail("replacement commit message is empty");
  else fs.writeFileSync(filePath, message.endsWith("\n") ? message : `${message}\n`, "utf8");
}
