# Fix trellis implement subagent working directory

## Goal

Ensure every `trellis-implement` dispatch runs from the project that owns the active Trellis task, so relative task paths and `.trellis/` context resolve reliably even when the Pi web process or another session is associated with a different project.

## Requirements

- Trace the complete dispatch path for `trellis-implement`, including prompt construction, tool arguments, runtime configuration, and any project/session cwd fallback.
- Identify the concrete condition that causes a dispatch to inherit another project's directory.
- Bind the spawned subagent to the active task's project root instead of relying on ambient process or session cwd.
- Preserve existing model routing, task prompt guards, async behavior, and other subagent types.
- Reject or clearly report an invalid task/project context instead of silently launching in an unrelated directory.
- Add focused regression coverage for multi-project or mismatched ambient-cwd behavior when the affected layer has an existing test pattern.
- Update durable project documentation if the dispatch contract or configuration behavior changes.

## Acceptance Criteria

- [x] A `trellis-implement` dispatch for a task under project A receives project A as its effective `cwd`, even when the web process or another active session points at project B.
- [x] The subagent can resolve the supplied `Active task:` path and read its task artifacts.
- [x] Existing model/thinking routing and non-Trellis subagent behavior remain unchanged.
- [x] Invalid or missing project/task context does not silently fall back to an unrelated project.
- [x] Focused regression checks, lint, and TypeScript type-check pass.

## Notes

- The reported symptom is that `trellis-implement` starts in another project directory and reports no active task.
- The fix should establish one authoritative project-root source at the dispatch boundary.
