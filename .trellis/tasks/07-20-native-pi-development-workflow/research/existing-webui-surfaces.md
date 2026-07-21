# Existing WebUI Surfaces To Reuse

## Session And Cwd Ownership

- `lib/rpc-manager.ts` creates one cwd-bound in-process Pi AgentSession per chat session and stores wrappers in `globalThis.__piSessions`.
- `app/api/agent/new/route.ts` requires and canonicalizes explicit cwd.
- `hooks/useAgentSession.ts` treats models, tools, chat state, and subagent projections as session/cwd scoped.
- `lib/allowed-roots.ts` is the security boundary for browser-selected workspaces.

The Workflow runtime should follow the same explicit-cwd and globalThis lifecycle patterns, but use a dedicated in-memory workflow host session rather than coupling execution to the currently open chat.

## Native Subagent Integration

- `lib/pi-subagent-discovery.ts` already creates a lightweight SDK session and invokes the registered native `subagent` tool for management discovery.
- `lib/pi-subagent-settings.ts` and `components/AgentsConfig.tsx` own native model/thinking/fallback settings.
- `hooks/useAgentSession.ts` and `components/SubagentPanel.tsx` already normalize and display native subagent tool runs from chat sessions.
- `lib/pi-runtime-resolver.ts` prepares the Pi CLI environment needed by nested child processes.

The Workflow must reuse native settings and runtime preparation. It should not reuse or extend `pi-web.json -> trellis.subagents`, which is a Trellis-only compatibility policy.

## Task And Panel Patterns

- `lib/trellis-reader.ts`, `lib/trellis-types.ts`, `components/TrellisPanel.tsx`, and `components/TrellisSessionWidget.tsx` provide useful read-only task/detail/progress UI patterns.
- `components/AppShell.tsx` already supports right-drawer modes and cwd-scoped panel state.
- `components/MonacoFileEditor.tsx`, `components/MarkdownBody.tsx`, and the workspace file APIs provide editor/preview patterns.
- `lib/trellis-workflow-reader.ts` and `components/TrellisWorkflowVisualizer.tsx` are visualization-only and should not become the new workflow authority.

The native Workflow should use its own store/types/routes/components under a non-Trellis namespace. Shared visual primitives may be extracted only when reuse is real; do not make Trellis readers support two schemas.

## Persistence And Safety Patterns

Relevant local patterns:

- Canonical cwd and allowed-root validation before filesystem access.
- Stable browser keys rather than raw filesystem paths.
- Symlink/realpath checks within workspace.
- Strict external-data normalization with `unknown` and type guards.
- Optimistic revisions and same-directory atomic rename for settings writes.
- Global runtime registries on `globalThis` for hot-reload survival.
- Sidecar/lifecycle artifacts referenced rather than copied into session JSONL.

## Confirmed Gap

The current WebUI has no WebUI-owned mutable development-task lifecycle. Trellis routes are read-only except setup/update actions, and native subagent support is currently chat-tool observation plus settings/discovery. A new store, run manager, API, and panel are required.
