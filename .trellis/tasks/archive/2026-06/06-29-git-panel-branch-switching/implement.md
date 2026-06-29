# Implementation Plan: Git panel branch switching

## Ordered Checklist

1. Add backend route
   - Create `app/api/git/switch/route.ts`.
   - Parse JSON body with `cwd` and `branch`.
   - Validate both values are strings and non-empty.
   - Verify `cwd` is a Git repository.
   - Verify target local branch exists.
   - Block dirty working trees using `git status --porcelain`.
   - Execute `git switch <branch>` with `execFile`.
   - Return structured success/error JSON.

2. Extend Git panel UI
   - Use `graphData?.branches` for local branch options.
   - Render current branch and a branch selector/switch action in the Branch section.
   - Disable switching when loading, switching, dirty, detached with no target, current branch selected, or no branch list is available.
   - Show a concise dirty-state explanation when switching is disabled because of local changes.
   - Show API errors near the switch control.

3. Refresh after switching
   - On switch success, clear switch error and call existing `fetchAll()`.
   - Ensure `onDirtyChange` is updated through the existing status refresh path.

4. Documentation
   - Add the new switch route to `docs/modules/api.md`.
   - Update `docs/modules/frontend.md` GitPanel description if needed.

5. Validation
   - Run `npm run lint`.
   - Run `node_modules/.bin/tsc --noEmit`.

## Risky Files / Rollback Points

- `components/GitPanel.tsx`: UI state and fetch logic changes could affect existing Git panel display.
- `app/api/git/switch/route.ts`: must avoid shell interpolation and must not support force/discard behavior.
- `docs/modules/api.md`: route table should stay synchronized with implementation.

## Review Gates Before Start

- Confirm UX: immediate switch on selection vs select branch then click explicit Switch button.
- Confirm dirty-tree policy remains conservative: block switching whenever any staged, unstaged, or untracked changes are present.
