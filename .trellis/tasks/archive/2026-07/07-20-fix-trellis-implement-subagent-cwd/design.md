# Technical Design

## Problem Model

A Trellis task path is usually project-relative (`.trellis/tasks/...`). The dispatch is therefore correct only when the child process/tool call uses the owning project's root as `cwd`. Any fallback to the web server's `process.cwd()`, a previously selected project, or a different session's cwd can make `task.py current` and task artifact reads target the wrong `.trellis` tree.

## Investigation

1. Locate all `trellis-implement` dispatch producers and the subagent tool/runtime adapter.
2. Trace how the active session cwd, task path, and explicit subagent `cwd` are represented.
3. Inspect recent subagent artifacts/configuration to compare successful and failing cwd values.
4. Confirm whether the bug is in application dispatch construction, Pi extension integration, or Trellis prompt/runtime configuration.

## Intended Fix

At the nearest application-owned dispatch boundary, derive an absolute project root from the active task/session context, validate that the task belongs to that root, and pass the root explicitly as the subagent `cwd`. Do not rely on ambient cwd fallback for Trellis agents.

If dispatch is controlled only by prompts/config rather than application code, update the authoritative Trellis workflow/agent instructions so every `trellis-implement` invocation includes explicit `cwd`, and add any enforceable validation available in the integration layer.

## Compatibility

- Keep the `Active task: <path>` first-line guard.
- Keep relative task paths when the child cwd is explicitly bound; use absolute paths only if the runtime contract requires them.
- Do not change unrelated agent routing or user-configured model overrides.

## Validation

- Add a regression test around cwd selection or dispatch payload construction.
- Run focused tests for changed modules.
- Run `npm run lint` and `node_modules/.bin/tsc --noEmit`.
- Perform a controlled `trellis-implement` smoke dispatch if the runtime supports doing so without modifying unrelated files.
