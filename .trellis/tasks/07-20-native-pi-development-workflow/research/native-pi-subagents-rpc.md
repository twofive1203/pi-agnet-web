# Native pi-subagents RPC Findings

## Scope

Repository and installed-package inspection for a Snail Pi Web-owned workflow orchestrator. Verified against `pi-subagents` 0.35.1 and Pi SDK 0.80.10 installed in the current environment.

## Stable Integration Surface

`pi-subagents` exposes a versioned in-process event-bus RPC intended for other Pi extensions and hosts:

- Ready: `subagents:rpc:v1:ready`
- Request: `subagents:rpc:v1:request`
- Reply: `subagents:rpc:v1:reply:<requestId>`
- Protocol version: `1`
- Methods: `ping`, `spawn`, `status`, `interrupt`, `stop`

`spawn` is async-only and goes through the same executor as the native `subagent` tool. It preserves agent discovery, validation, session attribution, spawn limits, cwd handling, artifacts, and async lifecycle records.

Example envelope:

```ts
{
  version: 1,
  requestId,
  method: "spawn",
  params: {
    agent: "worker",
    task: "...",
    context: "fresh",
    cwd,
    async: true,
    clarify: false,
  },
}
```

## Pi SDK Host Integration

Pi SDK supports an externally owned event bus:

```ts
const eventBus = createEventBus();
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  eventBus,
});
await loader.reload();
const { session } = await createAgentSession({ cwd, resourceLoader: loader, sessionManager });
```

This is preferable to importing `pi-subagents/src/*` or scraping tool output. The WebUI can retain the event bus next to its workflow host session and issue RPC requests directly.

## Builtin Agents

`pi-subagents` ships builtin agents that require no Trellis-generated project files:

- `worker`: implementation agent, single-writer orientation, validates and reports changes.
- `reviewer`: independent review agent for diffs/plans/solutions.

MVP should default to these names. The workflow prompt supplies task identity, project-relative document paths, phase contract, structured output expectations, no-commit rule, and recursion restrictions. Future versions may allow choosing other discovered agents.

## Cwd Contract

Native `pi-subagents` resolves child cwd from explicit run `cwd`, otherwise the parent extension `ctx.cwd`. The Workflow orchestrator should always pass the canonical project cwd explicitly and verify RPC `ping.session.cwd` before spawn. Never use `process.cwd()` as a workflow fallback.

## Lifecycle Artifacts

Async runs expose machine-readable lifecycle fields and files, including:

- `runId`, `sessionId`, `state`, `cwd`, `startedAt`, `lastUpdate`, `endedAt`
- `asyncDir`, `sessionFile`, `outputFile`
- `steps`, `results`, model attempts, tool/turn/token/cost metadata
- `status.json`, `events.jsonl`, output logs, final result JSON

Workflow records should store references to these artifacts rather than duplicate full child transcripts. Consumers should ignore unknown future fields.

## Constraints

- RPC is in-process. The WebUI host must create/load the same Pi extensions and retain the event bus.
- RPC `stop` is scoped to the active parent session. A deterministic workflow host session id per cwd should be used so a recreated host can address its runs where supported.
- Server restarts require reconciliation from persisted workflow run records and pi-subagents lifecycle artifacts.
- The workflow must fail visibly when `pi-subagents` is unavailable, RPC ping fails, session cwd differs, or the task context is invalid.
