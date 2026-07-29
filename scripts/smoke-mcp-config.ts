/**
 * Focused MCP configuration smoke tests.
 * Uses isolated temp home/agent/project roots; never touches real user MCP files.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAllowedRoot } from "../lib/allowed-roots";
import {
  applyMcpConfigOperations,
  computeRevisionFromBytes,
  getMcpTargetPath,
  loadMcpConfigSnapshot,
  McpConfigError,
  parseMcpScopeQuery,
  projectMcpConfigFromText,
  readMcpTargetFile,
  resolveAllMcpPaths,
  resolveMcpSaveRevision,
} from "../lib/mcp-config";

let failures = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`ok: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${message} (expected ${e}, got ${a})`);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "spi-mcp-smoke-"));
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  // Minimal settings so package discovery does not throw hard.
  writeFileSync(join(agentDir, "settings.json"), "{}\n", "utf8");

  registerAllowedRoot(projectDir);

  const pathOptions = { cwd: projectDir, agentDir, homeDir };
  const paths = resolveAllMcpPaths(pathOptions);

  try {
    // --- Path resolution ---
    assert(paths["user-shared"].endsWith(join(".config", "mcp", "mcp.json")), "user-shared path");
    assert(paths["user-pi"] === join(agentDir, "mcp.json"), "user-pi path");
    assert(paths["project-shared"] === join(projectDir, ".mcp.json"), "project-shared path");
    assert(paths["project-pi"] === join(projectDir, ".pi", "mcp.json"), "project-pi path");
    assert(paths["agents-global"].includes(join(".agents", "mcp.json")), "agents-global path");
    assert(paths["agents-nested-global"].includes(join(".agents", "mcp", "mcp.json")), "agents-nested path");

    // --- Missing file read ---
    const missing = readMcpTargetFile("project-shared", pathOptions);
    assert(!missing.exists, "missing project shared does not exist");
    assert(!missing.parseError, "missing file has no parse error");
    assertEqual(missing.projection.servers.length, 0, "missing servers empty");

    // --- Create stdio server ---
    const created = await applyMcpConfigOperations({
      targetId: "project-shared",
      cwd: projectDir,
      expectedRevision: missing.revision,
      operations: [
        {
          op: "upsertServer",
          name: "demo",
          server: {
            transport: "stdio",
            command: "npx",
            args: ["-y", "demo-mcp"],
            env: {
              TOKEN: { op: "replace", value: "super-secret-token" },
              FLAG: { op: "replace", value: "plain" },
            },
            lifecycle: "lazy",
          },
        },
      ],
      agentDir,
      homeDir,
    });
    assert(created.reloadRequired === true, "create returns reloadRequired");
    assert(existsSync(paths["project-shared"]), "project shared file created");
    assertEqual(created.selected.projection.servers.length, 1, "one server after create");
    const demo = created.selected.projection.servers[0];
    assert(demo.name === "demo", "server name");
    assert(demo.transport === "stdio", "stdio transport");
    assert(demo.command === "npx", "command projected");
    assert(demo.env?.some((e) => e.key === "TOKEN" && e.configured && !("value" in e)), "TOKEN redacted");
    const disk1 = readFileSync(paths["project-shared"], "utf8");
    assert(disk1.includes("super-secret-token"), "secret stored on disk");
    assert(!JSON.stringify(created.selected.projection).includes("super-secret-token"), "projection omits secret");

    // --- JSONC comments + unknown fields preserved ---
    const commented = `{
  // keep me
  "mcpServers": {
    "demo": {
      "command": "npx",
      "args": ["-y", "demo-mcp"],
      "env": {
        "TOKEN": "super-secret-token",
        "FLAG": "plain"
      },
      "lifecycle": "lazy",
      "customVendor": { "x": 1 }
    }
  },
  "extraRoot": true
}
`;
    writeFileSync(paths["project-shared"], commented, "utf8");
    const beforeRev = computeRevisionFromBytes(paths["project-shared"], commented);
    const afterLifecycle = await applyMcpConfigOperations({
      targetId: "project-shared",
      cwd: projectDir,
      expectedRevision: beforeRev,
      operations: [
        {
          op: "upsertServer",
          name: "demo",
          server: {
            lifecycle: "eager",
          },
        },
      ],
      agentDir,
      homeDir,
    });
    const disk2 = readFileSync(paths["project-shared"], "utf8");
    assert(disk2.includes("// keep me"), "comment preserved");
    assert(disk2.includes("customVendor"), "unknown server field preserved");
    assert(disk2.includes("extraRoot"), "unknown root field preserved");
    assert(disk2.includes("super-secret-token"), "untouched secret preserved byte-for-byte after lifecycle edit");
    assert(afterLifecycle.selected.projection.servers[0]?.lifecycle === "eager", "lifecycle updated");
    assert(
      afterLifecycle.selected.projection.servers[0]?.unknownFieldKeys.includes("customVendor"),
      "unknown field key listed",
    );

    // --- Secret preserve on unrelated save ---
    const revPreserve = afterLifecycle.selected.revision;
    const preserved = await applyMcpConfigOperations({
      targetId: "project-shared",
      cwd: projectDir,
      expectedRevision: revPreserve,
      operations: [
        {
          op: "upsertServer",
          name: "demo",
          server: {
            debug: true,
            env: {
              TOKEN: { op: "preserve" },
            },
          },
        },
      ],
      agentDir,
      homeDir,
    });
    const disk3 = readFileSync(paths["project-shared"], "utf8");
    assert(disk3.includes("super-secret-token"), "preserve keeps secret");
    assert(preserved.selected.projection.servers[0]?.debug === true, "debug set");

    // --- Secret replace / clear ---
    const replaced = await applyMcpConfigOperations({
      targetId: "project-shared",
      cwd: projectDir,
      expectedRevision: preserved.selected.revision,
      operations: [
        {
          op: "upsertServer",
          name: "demo",
          server: {
            env: {
              TOKEN: { op: "replace", value: "new-secret" },
              FLAG: { op: "clear" },
            },
          },
        },
      ],
      agentDir,
      homeDir,
    });
    const disk4 = readFileSync(paths["project-shared"], "utf8");
    assert(disk4.includes("new-secret"), "replace writes new secret");
    assert(!disk4.includes("super-secret-token"), "old secret gone");
    assert(!disk4.includes("\"FLAG\""), "cleared env key removed");
    assert(!JSON.stringify(replaced.selected.projection).includes("new-secret"), "new secret not in projection");

    // --- HTTP + socket transports ---
    const withHttp = await applyMcpConfigOperations({
      targetId: "project-shared",
      cwd: projectDir,
      expectedRevision: replaced.selected.revision,
      operations: [
        {
          op: "upsertServer",
          name: "remote",
          server: {
            transport: "http",
            url: "https://mcp.example.com/mcp",
            auth: "bearer",
            bearerToken: { op: "replace", value: "http-token" },
            headers: {
              "X-Api-Key": { op: "replace", value: "header-secret" },
            },
          },
        },
        {
          op: "upsertServer",
          name: "mux",
          server: {
            transport: "socket",
            socket: "~/.rmcp-servers/memory.sock",
          },
        },
      ],
      agentDir,
      homeDir,
    });
    const names = withHttp.selected.projection.servers.map((s) => s.name).sort();
    assertEqual(names, ["demo", "mux", "remote"], "three servers");
    const remote = withHttp.selected.projection.servers.find((s) => s.name === "remote");
    assert(remote?.transport === "http", "http transport");
    assert(remote?.bearerToken?.configured === true, "bearer configured");
    assert(remote?.headers?.some((h) => h.key === "X-Api-Key" && h.configured), "header configured");
    assert(!JSON.stringify(remote).includes("http-token"), "http token redacted");
    assert(!JSON.stringify(remote).includes("header-secret"), "header secret redacted");
    const mux = withHttp.selected.projection.servers.find((s) => s.name === "mux");
    assert(mux?.transport === "socket", "socket transport");
    assert(mux?.socket?.includes("memory.sock"), "socket path");

    // --- Invalid dual transport rejected ---
    let dualRejected = false;
    try {
      await applyMcpConfigOperations({
        targetId: "project-shared",
        cwd: projectDir,
        expectedRevision: withHttp.selected.revision,
        operations: [
          {
            op: "upsertServer",
            name: "bad",
            server: {
              command: "echo",
              url: "https://example.com",
            },
          },
        ],
        agentDir,
        homeDir,
      });
    } catch (error) {
      dualRejected = error instanceof McpConfigError && error.code === "VALIDATION_ERROR";
    }
    assert(dualRejected, "dual transport rejected");
    const afterDual = readFileSync(paths["project-shared"], "utf8");
    assert(!afterDual.includes("\"bad\""), "failed write leaves file unchanged");

    // --- Revision conflict ---
    let conflict = false;
    try {
      await applyMcpConfigOperations({
        targetId: "project-shared",
        cwd: projectDir,
        expectedRevision: "stale-revision",
        operations: [{ op: "deleteServer", name: "mux" }],
        agentDir,
        homeDir,
      });
    } catch (error) {
      conflict = error instanceof McpConfigError && error.code === "REVISION_CONFLICT" && error.status === 409;
    }
    assert(conflict, "stale revision conflict");

    // --- Parse error blocks mutation ---
    mkdirSync(dirnameSafe(paths["user-shared"]), { recursive: true });
    writeFileSync(paths["user-shared"], "{ not json", "utf8");
    const broken = readMcpTargetFile("user-shared", pathOptions);
    assert(!!broken.parseError, "parse error detected");
    let parseBlocked = false;
    try {
      await applyMcpConfigOperations({
        targetId: "user-shared",
        expectedRevision: broken.revision,
        operations: [
          {
            op: "upsertServer",
            name: "x",
            server: { transport: "stdio", command: "true" },
          },
        ],
        agentDir,
        homeDir,
      });
    } catch (error) {
      parseBlocked = error instanceof McpConfigError && error.code === "PARSE_ERROR";
    }
    assert(parseBlocked, "parse error blocks mutation");
    assert(readFileSync(paths["user-shared"], "utf8") === "{ not json", "parse-error file unchanged");

    // --- !command is not executed on read ---
    const sentinel = join(root, "sentinel-should-not-exist");
    const bangConfig = `{
  "mcpServers": {
    "exec": {
      "command": "echo",
      "env": {
        "SECRET": "!touch ${sentinel.replace(/\\/g, "/")}"
      }
    }
  }
}
`;
    // Use project-pi target
    const piPath = paths["project-pi"];
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(piPath, bangConfig, "utf8");
    const bangRead = readMcpTargetFile("project-pi", pathOptions);
    assert(bangRead.projection.servers[0]?.env?.[0]?.executableSecret === true, "executable secret flagged");
    assert(!existsSync(sentinel), "!command not executed during read");
    const projected = projectMcpConfigFromText(bangConfig);
    assert(!JSON.stringify(projected.projection).includes("!touch"), "command body not leaked beyond flag");
    // env key presence only
    assert(projected.projection.servers[0]?.env?.[0]?.configured === true, "executable secret configured");
    assert(projected.projection.servers[0]?.env?.[0]?.key === "SECRET", "secret key name ok");

    // --- Unauthorized project cwd ---
    let unauthorized = false;
    try {
      await applyMcpConfigOperations({
        targetId: "project-shared",
        cwd: join(root, "other-project"),
        expectedRevision: "0",
        operations: [{ op: "deleteServer", name: "demo" }],
        agentDir,
        homeDir,
      });
    } catch (error) {
      unauthorized =
        error instanceof McpConfigError
        && (error.code === "UNAUTHORIZED_CWD" || error.code === "MISSING_CWD" || error.status === 400 || error.status === 403);
    }
    assert(unauthorized, "forged/unauthorized cwd rejected");

    // --- Snapshot load ---
    // Fix user-shared so snapshot sources can report it
    mkdirSync(join(homeDir, ".config", "mcp"), { recursive: true });
    writeFileSync(paths["user-shared"], "{\n  \"mcpServers\": {}\n}\n", "utf8");
    const snapshot = await loadMcpConfigSnapshot({
      scope: "project",
      targetId: "project-shared",
      cwd: projectDir,
      agentDir,
      homeDir,
    });
    assert(snapshot.sources.length === 6, "six precedence sources");
    assert(snapshot.selected.targetId === "project-shared", "selected target");
    assert(typeof snapshot.adapter.installCommand === "string", "install command present");
    assert(!JSON.stringify(snapshot).toLowerCase().includes("\"connected\""), "no fake connected server state");
    assert(snapshot.reloadRequiredHint.includes("/reload"), "reload hint present");

    // --- Settings write ---
    const settingsWrite = await applyMcpConfigOperations({
      targetId: "user-pi",
      expectedRevision: readMcpTargetFile("user-pi", pathOptions).revision,
      operations: [
        {
          op: "setSettings",
          settings: {
            toolPrefix: "short",
            hostConfigDiscovery: "off",
            samplingAutoApprove: false,
            outputGuard: true,
          },
        },
        {
          op: "setImports",
          imports: ["cursor"],
        },
      ],
      agentDir,
      homeDir,
    });
    assert(settingsWrite.selected.projection.settings?.toolPrefix === "short", "settings toolPrefix");
    assertEqual(settingsWrite.selected.projection.imports, ["cursor"], "imports set");

    // --- Delete server ---
    const beforeDelete = readMcpTargetFile("project-shared", pathOptions);
    const deleted = await applyMcpConfigOperations({
      targetId: "project-shared",
      cwd: projectDir,
      expectedRevision: beforeDelete.revision,
      operations: [{ op: "deleteServer", name: "mux" }],
      agentDir,
      homeDir,
    });
    assert(!deleted.selected.projection.servers.some((s) => s.name === "mux"), "server deleted");

    // --- getMcpTargetPath rejects missing cwd for project ---
    let missingCwd = false;
    try {
      getMcpTargetPath("project-shared", { homeDir, agentDir });
    } catch (error) {
      missingCwd = error instanceof McpConfigError && error.code === "MISSING_CWD";
    }
    assert(missingCwd, "project path without cwd fails");

    // --- Atomic write leaves no tmp ---
    const dirEntries = listMaybe(join(projectDir));
    assert(!dirEntries.some((name) => name.includes(".mcp-") && name.endsWith(".tmp")), "no leftover tmp files");

    // --- Object-form outputGuard preserved through unrelated settings write ---
    const ogPath = paths["user-pi"];
    writeFileSync(
      ogPath,
      JSON.stringify({
        settings: {
          toolPrefix: "server",
          outputGuard: { maxBytes: 4096, maxLines: 100 },
          oauthDir: "/tmp/oauth-store",
        },
      }, null, 2),
      "utf8",
    );
    const ogBefore = readMcpTargetFile("user-pi", pathOptions);
    const ogWrite = await applyMcpConfigOperations({
      targetId: "user-pi",
      expectedRevision: ogBefore.revision,
      operations: [
        {
          op: "setSettings",
          settings: {
            toolPrefix: "short",
            // omit outputGuard / oauthDir so AST merge keeps them
          },
        },
      ],
      agentDir,
      homeDir,
    });
    const ogDisk = readFileSync(ogPath, "utf8");
    assert(ogDisk.includes("maxBytes"), "object outputGuard preserved");
    assert(ogDisk.includes("oauthDir"), "unrelated settings field preserved");
    assert(ogWrite.selected.projection.settings?.toolPrefix === "short", "toolPrefix updated beside object outputGuard");

    // --- Browser-safe projection contract helpers ---
    const redactedText = JSON.stringify(ogWrite.selected.projection);
    assert(!/super-secret|new-secret|http-token|header-secret/.test(redactedText), "no known secrets in final projection");
    assert(!/"connected"\s*:\s*true/.test(JSON.stringify(ogWrite)), "write result does not claim connected");

    // --- Malformed operation rejected ---
    let unknownOp = false;
    try {
      await applyMcpConfigOperations({
        targetId: "user-pi",
        expectedRevision: ogWrite.selected.revision,
        operations: [{ op: "dropEverything" } as never],
        agentDir,
        homeDir,
      });
    } catch (error) {
      unknownOp = error instanceof McpConfigError && error.code === "UNKNOWN_OPERATION";
      if (error instanceof McpConfigError) {
        assert(error.fieldPath === "operations[0]", "unknown op keeps stable fieldPath");
        assert(!/dropEverything/i.test(error.message), "unknown op must not echo discriminator");
      }
    }
    assert(unknownOp, "unknown operation rejected");

    // --- Prototype-named / secret-like discriminators: stable UNKNOWN_OPERATION, no value echo ---
    for (const badOp of ["__proto__", "constructor", "toString", "TOP_SECRET_VALUE"]) {
      let prototypeSafe = false;
      try {
        await applyMcpConfigOperations({
          targetId: "user-pi",
          expectedRevision: ogWrite.selected.revision,
          operations: [{ op: badOp } as never],
          agentDir,
          homeDir,
        });
      } catch (error) {
        assert(!(error instanceof TypeError), `discriminator ${badOp} must not throw TypeError`);
        prototypeSafe =
          error instanceof McpConfigError
          && error.code === "UNKNOWN_OPERATION"
          && error.status === 400
          && error.fieldPath === "operations[0]";
        if (error instanceof Error) {
          assert(
            !error.message.includes(badOp),
            `UNKNOWN_OPERATION must not echo discriminator value (${badOp})`,
          );
        }
      }
      assert(prototypeSafe, `discriminator rejected with stable UNKNOWN_OPERATION (op=${badOp})`);
    }

    // --- Unknown top-level operation fields rejected ---
    let unknownTopLevelField = false;
    let unknownTopLevelPath = "";
    try {
      await applyMcpConfigOperations({
        targetId: "user-pi",
        expectedRevision: ogWrite.selected.revision,
        operations: [
          {
            op: "setSettings",
            settings: { toolPrefix: "mcp" },
            unexpectedTop: true,
          } as never,
        ],
        agentDir,
        homeDir,
      });
    } catch (error) {
      unknownTopLevelField =
        error instanceof McpConfigError
        && error.code === "VALIDATION_ERROR"
        && error.fieldPath === "operations[0].unexpectedTop";
      if (error instanceof McpConfigError) unknownTopLevelPath = error.fieldPath ?? "";
      if (error instanceof Error) {
        assert(!/true|secret|token/i.test(error.message) || error.message.includes("Unknown field"), "no value echo on unknown top-level field");
      }
    }
    assert(unknownTopLevelField, `unknown top-level op field rejected (path=${unknownTopLevelPath})`);

    // --- Reviewer reproduction: unknown nested server mutation field ---
    let unknownServerField = false;
    let unknownServerPath = "";
    try {
      await applyMcpConfigOperations({
        targetId: "user-pi",
        expectedRevision: ogWrite.selected.revision,
        operations: [
          {
            op: "upsertServer",
            name: "strict-server",
            server: {
              command: "echo",
              unexpectedField: "SHOULD_REJECT",
            },
          } as never,
        ],
        agentDir,
        homeDir,
      });
    } catch (error) {
      unknownServerField =
        error instanceof McpConfigError
        && error.code === "VALIDATION_ERROR"
        && error.fieldPath === "operations[0].server.unexpectedField";
      if (error instanceof McpConfigError) unknownServerPath = error.fieldPath ?? "";
      if (error instanceof Error) {
        assert(
          !error.message.includes("SHOULD_REJECT"),
          "unknown nested server field error must not echo rejected value",
        );
      }
    }
    assert(unknownServerField, `unknown nested server field rejected (path=${unknownServerPath})`);

    // --- Representative unknown nested settings/oauth/outputGuard/trace fields ---
    const nestedUnknownCases: Array<{ label: string; operations: unknown[]; fieldPath: string }> = [
      {
        label: "settings",
        fieldPath: "operations[0].settings.notARealSetting",
        operations: [
          {
            op: "setSettings",
            settings: { toolPrefix: "short", notARealSetting: 1 },
          },
        ],
      },
      {
        label: "outputGuard",
        fieldPath: "operations[0].settings.outputGuard.unexpectedOg",
        operations: [
          {
            op: "setSettings",
            settings: { outputGuard: { maxBytes: 10, unexpectedOg: true } },
          },
        ],
      },
      {
        label: "trace",
        fieldPath: "operations[0].settings.trace.unexpectedTrace",
        operations: [
          {
            op: "setSettings",
            settings: { trace: { enabled: true, unexpectedTrace: "nope" } },
          },
        ],
      },
      {
        label: "oauth",
        fieldPath: "operations[0].server.oauth.unexpectedOAuth",
        operations: [
          {
            op: "upsertServer",
            name: "http-strict",
            server: {
              url: "https://example.invalid/mcp",
              oauth: { clientId: "cid", unexpectedOAuth: "x" },
            },
          },
        ],
      },
      {
        label: "secret-op",
        fieldPath: "operations[0].server.env.TOKEN.extra",
        operations: [
          {
            op: "upsertServer",
            name: "env-strict",
            server: {
              command: "echo",
              env: { TOKEN: { op: "preserve", extra: "nope" } },
            },
          },
        ],
      },
    ];

    for (const testCase of nestedUnknownCases) {
      let rejected = false;
      try {
        await applyMcpConfigOperations({
          targetId: "user-pi",
          expectedRevision: ogWrite.selected.revision,
          operations: testCase.operations as never,
          agentDir,
          homeDir,
        });
      } catch (error) {
        rejected =
          error instanceof McpConfigError
          && error.code === "VALIDATION_ERROR"
          && error.fieldPath === testCase.fieldPath;
        if (error instanceof Error) {
          assert(
            !/SHOULD_REJECT|nope|true/.test(error.message) || error.message.startsWith("Unknown field:"),
            `${testCase.label}: must not echo unknown field values`,
          );
        }
      }
      assert(rejected, `unknown nested ${testCase.label} field rejected at ${testCase.fieldPath}`);
    }

    // Confirm file was not mutated by rejected unknown-field attempts
    const afterReject = readMcpTargetFile("user-pi", pathOptions);
    assertEqual(afterReject.revision, ogWrite.selected.revision, "rejected unknown fields leave revision unchanged");

    // --- Settings JSONC comments survive field edits ---
    const settingsCommentPath = paths["user-shared"];
    mkdirSync(dirnameSafe(settingsCommentPath), { recursive: true });
    const settingsCommented = `{
  "settings": {
    // keep settings comment
    "toolPrefix": "server",
    /* nested og comment */
    "outputGuard": {
      // keep og limit comment
      "maxBytes": 1024,
      "maxLines": 50
    },
    "oauthDir": "/tmp/oauth-keep"
  }
}
`;
    writeFileSync(settingsCommentPath, settingsCommented, "utf8");
    const settingsCommentBefore = readMcpTargetFile("user-shared", pathOptions);
    const settingsCommentWrite = await applyMcpConfigOperations({
      targetId: "user-shared",
      expectedRevision: settingsCommentBefore.revision,
      operations: [
        {
          op: "setSettings",
          settings: {
            toolPrefix: "short",
            outputGuard: { maxBytes: 2048, maxLines: 50 },
          },
        },
      ],
      agentDir,
      homeDir,
    });
    const settingsCommentDisk = readFileSync(settingsCommentPath, "utf8");
    assert(settingsCommentDisk.includes("// keep settings comment"), "settings comment preserved");
    assert(settingsCommentDisk.includes("// keep og limit comment"), "nested outputGuard comment preserved");
    assert(settingsCommentDisk.includes("oauthDir"), "untouched settings field kept with comments");
    assert(
      settingsCommentWrite.selected.projection.settings?.toolPrefix === "short",
      "settings toolPrefix updated with comments kept",
    );
    assert(
      typeof settingsCommentWrite.selected.projection.settings?.outputGuard === "object"
        && settingsCommentWrite.selected.projection.settings?.outputGuard
        && (settingsCommentWrite.selected.projection.settings.outputGuard as { maxBytes?: number }).maxBytes === 2048,
      "outputGuard maxBytes updated field-level",
    );

    // --- Server rename preserves nested comments ---
    const renameCommentPath = paths["project-pi"];
    mkdirSync(dirnameSafe(renameCommentPath), { recursive: true });
    const renameCommented = `{
  "mcpServers": {
    "old-name": {
      // keep server comment
      "command": "npx",
      /* block keep */
      "args": ["-y", "demo"],
      "lifecycle": "lazy"
    }
  }
}
`;
    writeFileSync(renameCommentPath, renameCommented, "utf8");
    const renameBefore = readMcpTargetFile("project-pi", pathOptions);
    const renamed = await applyMcpConfigOperations({
      targetId: "project-pi",
      cwd: projectDir,
      expectedRevision: renameBefore.revision,
      operations: [
        { op: "renameServer", from: "old-name", to: "new-name" },
        {
          op: "upsertServer",
          name: "new-name",
          server: { lifecycle: "eager" },
        },
      ],
      agentDir,
      homeDir,
    });
    const renameDisk = readFileSync(renameCommentPath, "utf8");
    assert(renameDisk.includes("\"new-name\""), "renamed server key present");
    assert(!renameDisk.includes("\"old-name\""), "old server key removed");
    assert(renameDisk.includes("// keep server comment"), "server rename keeps nested line comment");
    assert(renameDisk.includes("/* block keep */"), "server rename keeps nested block comment");
    assert(renamed.selected.projection.servers[0]?.name === "new-name", "rename projected");
    assert(renamed.selected.projection.servers[0]?.lifecycle === "eager", "rename+upsert lifecycle");

    // --- Conflict reapply revision helper prefers loaded revision ---
    assertEqual(
      resolveMcpSaveRevision({ stateRevision: "stale-rev", loadedRevision: "fresh-rev" }),
      "fresh-rev",
      "reapply uses freshly loaded revision",
    );
    assertEqual(
      resolveMcpSaveRevision({ stateRevision: "state-rev", loadedRevision: "" }),
      "state-rev",
      "empty loaded revision falls back to state",
    );
    assertEqual(
      resolveMcpSaveRevision({ stateRevision: "state-only" }),
      "state-only",
      "missing loaded revision uses state",
    );

    // --- Explicit invalid scope is distinguished from missing ---
    assertEqual(parseMcpScopeQuery(null), { scope: null, invalid: false }, "missing scope not invalid");
    assertEqual(parseMcpScopeQuery(""), { scope: null, invalid: false }, "empty scope not invalid");
    assertEqual(parseMcpScopeQuery("user"), { scope: "user", invalid: false }, "user scope ok");
    assertEqual(parseMcpScopeQuery("project"), { scope: "project", invalid: false }, "project scope ok");
    assertEqual(parseMcpScopeQuery("nope"), { scope: null, invalid: true }, "invalid scope flagged");

    // --- Global settings projection for newly managed fields ---
    const globalProj = projectMcpConfigFromText(`{
      "settings": {
        "trace": { "enabled": true, "file": "/tmp/mcp.trace", "maxBytes": 9, "maxEvents": 3 },
        "authRequiredMessage": "login please",
        "oauthDir": "/var/oauth",
        "outputGuard": { "maxBytes": 11, "maxLines": 22, "detailsMaxBytes": 33 }
      }
    }`);
    assert(globalProj.projection.settings?.trace?.enabled === true, "trace.enabled projected");
    assert(globalProj.projection.settings?.trace?.file === "/tmp/mcp.trace", "trace.file projected");
    assert(globalProj.projection.settings?.authRequiredMessage === "login please", "authRequiredMessage projected");
    assert(globalProj.projection.settings?.oauthDir === "/var/oauth", "oauthDir projected");
    assert(
      typeof globalProj.projection.settings?.outputGuard === "object"
        && globalProj.projection.settings?.outputGuard
        && (globalProj.projection.settings.outputGuard as { detailsMaxBytes?: number }).detailsMaxBytes === 33,
      "outputGuard detailsMaxBytes projected",
    );

    if (failures > 0) {
      console.error(`\n${failures} MCP smoke assertion(s) failed`);
      process.exitCode = 1;
    } else {
      console.log("\nAll MCP config smoke checks passed");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function dirnameSafe(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return idx >= 0 ? filePath.slice(0, idx) : ".";
}

function listMaybe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
