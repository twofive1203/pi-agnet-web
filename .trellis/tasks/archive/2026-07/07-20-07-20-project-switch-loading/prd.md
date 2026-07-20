# Optimize project switch loading

## Goal

Reduce perceived and actual latency when the browser first opens or the selected project changes.

## Requirements

- The file Explorer is collapsed by default on first render.
- A collapsed Explorer must not mount `FileExplorer` or request the workspace file tree.
- Clicking the Explorer header expands it and loads the current workspace on demand.
- Switching projects while Explorer is collapsed must not load the new workspace file tree.
- Model metadata should remain available to the chat model selector without repeating expensive registry construction for each session/project transition.
- Model configuration refreshes must still invalidate stale model metadata.
- Preserve existing session selection, file opening, Explorer refresh, and model switching behavior.
- Preserve unrelated user changes already present in the worktree.

## Acceptance Criteria

- [x] Initial browser entry renders Explorer collapsed and issues no file-tree request until expansion.
- [x] Project switching while Explorer is collapsed issues no file-tree request.
- [x] Expanding Explorer loads the selected project and the existing refresh action still works.
- [x] Model list loading is shared/cached across chat session remounts and refreshes after model configuration changes.
- [x] Loading and error behavior does not leave stale data attributed to the wrong project/session.
- [x] `npm run lint` passes.
- [x] `node_modules/.bin/tsc --noEmit` passes.

## Notes

- Prefer client-side request deduplication/cache for browser remounts and a bounded server cache only if registry creation remains expensive.
- Do not defer the current-session context load; only optimize independent Explorer/model metadata work.
