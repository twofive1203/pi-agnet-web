# Design: Git panel branch switching

## Scope

Implement a minimal, safe local-branch switch flow in the existing Git panel.

## Architecture

### Frontend

- Extend `components/GitPanel.tsx` to render a branch switch control in or near the existing Branch section.
- Reuse `graphData.branches` from `/api/git/graph` as the available local branch list.
- Keep branch switching local to the Git panel UI, but notify parent state through existing `onDirtyChange` after refreshing.
- Add local UI state for:
  - selected target branch
  - switch-in-progress state
  - switch error message

### API

- Add a new route, likely `app/api/git/switch/route.ts`.
- Method: `POST`.
- Request body:

```json
{
  "cwd": "absolute/workspace/path",
  "branch": "branch-name"
}
```

- Behavior:
  - validate `cwd` and `branch` are non-empty strings
  - verify `cwd` is a Git repository
  - verify the target branch exists as a local branch
  - reject if `git status --porcelain` reports dirty state
  - run `git switch <branch>` using `execFile`, not shell string interpolation
  - return success with the switched branch name, or a readable error and appropriate status

### Data Flow

1. `GitPanel` loads current status and graph.
2. User chooses a non-current local branch.
3. User triggers switch.
4. `GitPanel` POSTs to `/api/git/switch`.
5. API validates safety conditions and runs `git switch`.
6. On success, `GitPanel` calls its existing `fetchAll()` refresh path.
7. Refreshed status/graph updates the UI and calls `onDirtyChange`.

## Safety and Compatibility

- Dirty working trees are blocked before attempting `git switch`; this avoids implicit stash/overwrite semantics.
- Worktree branch conflicts can be left to Git; the API returns Git's stderr/stdout message to the user.
- Existing status and graph APIs remain unchanged.
- No route should execute Git commands through shell interpolation.

## Tradeoffs

- Blocking all dirty worktrees is conservative: Git could switch safely in some dirty cases, but the simple rule avoids surprising data movement.
- Using `graphData.branches` means branch options are available after graph loading. If graph loading fails, the switch UI should be unavailable rather than adding another branch-list API for the first version.
- An explicit Switch button is safer than switching immediately on dropdown change, but adds one click.

## Documentation Updates

- Update `docs/modules/api.md` for the new route.
- Update `docs/modules/frontend.md` if the GitPanel description changes meaningfully.
