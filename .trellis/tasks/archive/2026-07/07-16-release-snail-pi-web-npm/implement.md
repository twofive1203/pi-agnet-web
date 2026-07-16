# Implementation Plan: Release Snail Pi Web 0.7.2

## Pre-release

- Read `prd.md`, `design.md`, this plan, and the deployment/release guide.
- Load applicable Trellis/project standards.
- Re-run safe npm identity and registry availability checks without inspecting credentials.
- Record the main-tree dirty status and current commit.

## Phase 1: Release-only version commit

1. Build staged manifest blobs from `HEAD`, changing only:
   - `package.json`: `version` to `0.7.2`.
   - `package-lock.json`: top-level and root-package versions to `0.7.2`.
2. Inspect `git diff --cached -- package.json package-lock.json`.
3. Confirm no other staged paths exist.
4. Run JSON/package consistency checks against the staged content.
5. Commit as `chore: release 0.7.2`.
6. Confirm unrelated working-tree changes remain present and unstaged.

## Phase 2: Isolated release worktree

1. Create a detached temporary worktree from the release commit outside the main checkout.
2. Confirm `git status --porcelain` is empty before installing/building.
3. Run `npm ci` in the isolated worktree.
4. Run:

```bash
npm run lint
node_modules/.bin/tsc --noEmit
npm run build
npm pack --dry-run --json
```

5. Save only non-secret validation summaries in task notes if needed; do not copy npm auth/config files.

## Phase 3: Dry-run inspection

Verify:

- name `@twofive/snail-pi-web`;
- version `0.7.2`;
- bin mapping `spi -> bin/pi-web.js`;
- package contains `bin/pi-web.js`, `.next/**`, `public/snail-pi-logo.svg`, scripts, Next config, and manifest;
- package excludes `.npmrc`, `.env*`, `.trellis/**`, `.pi-subagents/**`, `.git/**`, old Yolk assets, logs, caches, and source maps;
- main working tree still contains exactly the unrelated uncommitted work expected before release.

Report dry-run size/file-count evidence and ask for explicit final publish confirmation.

## Phase 4: Publish (confirmation required)

Only after user confirmation, from the validated isolated worktree:

```bash
npm publish --access public --registry=https://registry.npmjs.org/
```

If npm requests OTP/browser authorization or reports an auth-policy failure, stop and ask the user to complete authorization locally. Never request or display the secret.

## Phase 5: Verify

1. Query registry metadata for exact version, `latest`, and bin mapping.
2. Perform a registry package-download dry-run from a separate empty temp directory where practical.
3. Verify the main working tree's unrelated changes are unchanged.
4. Mark PRD acceptance criteria complete only with registry evidence.
5. Keep or remove the release worktree according to whether retry/debugging is still needed.

## Validation Commands

```bash
npm whoami --registry=https://registry.npmjs.org/
npm pkg get name version bin files
npm run lint
node_modules/.bin/tsc --noEmit
npm run build
npm pack --dry-run --json
npm view @twofive/snail-pi-web@0.7.2 name version bin dist-tags --json --prefer-online
git diff --check
git status --short
```

## Safety Checks

- Never run `npm config list`, inspect `.npmrc`, list tokens, or dump environment variables.
- Never stage or commit `.next`, `node_modules`, tarballs, auth/config files, `.pi-subagents`, or unrelated Trellis tasks.
- Never build/publish from the dirty main working tree.
- Never publish before the explicit final confirmation gate.
