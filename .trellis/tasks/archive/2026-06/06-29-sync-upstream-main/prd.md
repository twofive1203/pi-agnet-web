# Sync upstream main

## Goal

Inspect the upstream repository `git@github.com:twofive1203/pi-agnet-web.git`, review recent `main` updates, and merge/pull the upstream `main` branch into the current worktree safely.

## Requirements

- Add or use a Git remote for `git@github.com:twofive1203/pi-agnet-web.git` without disturbing existing remotes.
- Fetch upstream `main` and summarize what changed before applying it.
- Merge the upstream `main` changes into the current branch only after confirming the update set is understood.
- If Git reports conflicts, stop and ask the user how to resolve them before editing conflict hunks.
- Preserve unrelated local/user changes and avoid destructive Git commands.

## Acceptance Criteria

- [x] Upstream remote state has been fetched.
- [x] Recent upstream-only commits and changed files are summarized for the user.
- [x] Current branch incorporates upstream `main`, or merge is paused with a clear conflict summary awaiting user direction.
- [x] Final Git status is reported.
