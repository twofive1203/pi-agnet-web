# Git panel branch switching

## Goal

Add a safe baseline branch-switching capability to the existing Git panel so users can switch the current workspace to another local Git branch from the web UI, while keeping the feature small and predictable.

## User Value

- Users can inspect the current Git state and switch local branches without leaving Pi Agent Web.
- The current Git panel remains mostly read-only/status-oriented, with one explicit, guarded mutation: branch switching.

## Confirmed Facts

- `components/AppShell.tsx` renders the top-bar Git dropdown and passes `cwd`, `refreshKey`, and `onDirtyChange` into `components/GitPanel.tsx`.
- `components/GitPanel.tsx` currently fetches `/api/git/status` and `/api/git/graph` in parallel, renders branch metadata, commit graph, file changes, and stash count.
- `app/api/git/status/route.ts` returns current branch, dirty status, upstream/ahead/behind, parsed staged/unstaged/untracked files, recent commits, and stash count.
- `app/api/git/graph/route.ts` already returns local branch metadata as `GitGraphData.branches`, but `GitPanel` currently does not render or use it.
- There is no existing API route for `git switch` / checkout. Existing Git mutation routes are scoped to WorkTree creation/removal/archive.
- Shared Git panel types live in `lib/types.ts`.

## Requirements

- Add branch switching from the Git panel for existing local branches.
- Use the existing `GitGraphData.branches` list as the local branch source where practical.
- Do not support branch creation in this task.
- Do not support remote tracking branch checkout in this task.
- Do not support force checkout, stash, apply/drop stash, or discard changes in this task.
- Prevent accidental or unsafe switches when the current workspace is dirty.
- After a successful switch, refresh Git status and graph so the panel and dirty indicator reflect the new branch.
- Surface switch failures to the user with a readable error message, including Git errors such as a branch being checked out in another worktree.
- Preserve current Git panel status/graph/change-list behavior unless directly required for branch switching.

## Acceptance Criteria

- [ ] Git panel shows available local branches and identifies the current branch.
- [ ] User can switch from the current branch to another local branch through the Git panel.
- [ ] Branch switch is disabled or blocked when `status.isDirty` is true.
- [ ] Successful switch updates displayed current branch, upstream/ahead/behind, commit graph, change lists, and top-bar dirty indicator.
- [ ] Failed switch does not corrupt UI state and displays an actionable error.
- [ ] Non-Git directories still show the existing "Not a Git repository" state.
- [ ] Existing read-only Git panel sections continue to render.
- [ ] `npm run lint` and `node_modules/.bin/tsc --noEmit` pass.

## Out of Scope

- Creating, renaming, deleting, or merging branches.
- Switching to or creating local branches from remote branches.
- Stashing, force switching, discarding, or resolving dirty working trees.
- Full Git client workflows such as commit, push, pull, rebase, or conflict resolution.

## Decisions

- Branch switching uses an explicit two-step flow: select a target branch, then click a dedicated "Switch" button. This avoids accidental workspace mutation from merely opening or changing a dropdown selection.
