# Design: Release Snail Pi Web 0.7.2

## Overview

Publish `@twofive/snail-pi-web@0.7.2` as the first public release under the new npm package identity. Separate release preparation from the dirty main working tree so the built `.next` output and npm tarball contain only committed Snail branding source.

## Release Source Boundary

The main working tree has unrelated uncommitted slash-command and pi SDK dependency changes. Because `.next` is included in the npm package, building in the main tree would silently publish those changes.

Use this boundary:

1. Create one release-only commit on the current branch that changes only the root version in `package.json` and `package-lock.json` from `0.7.1` to `0.7.2`.
2. Preserve all existing unstaged modifications by staging the version fields from the committed index rather than adding either whole manifest.
3. Create a detached temporary Git worktree from the release commit.
4. Install, validate, build, pack, and publish only from that clean worktree.

The isolated worktree must report a clean Git status before dependencies/build outputs are generated. `node_modules`, `.next`, and the tarball are ignored/generated release artifacts and are not committed.

## Version Commit

Expected commit content:

- `package.json`: root `version` only.
- `package-lock.json`: top-level version and `packages[""]` version only.

Expected commit message:

```text
chore: release 0.7.2
```

Before committing, inspect `git diff --cached` and reject the commit if it includes dependency upgrades, ChatInput changes, task artifacts, credentials, or any other path.

## Validation Pipeline

Run in the clean release worktree:

1. `npm ci`
2. `npm run lint`
3. `node_modules/.bin/tsc --noEmit`
4. `npm run build`
5. `npm pack --dry-run --json`

Inspect the dry-run JSON/file list for:

- package name `@twofive/snail-pi-web`;
- version `0.7.2`;
- `bin/pi-web.js` and bin mapping `spi`;
- `.next` production output;
- `public/snail-pi-logo.svg`;
- no `.npmrc`, `.env*`, `.trellis`, `.pi-subagents`, Git metadata, logs, caches, source maps, or old Yolk logo files.

Also inspect package metadata with `npm pkg get name version bin files` and ensure the clean worktree commit is the release commit.

## Credential Boundary

Permitted credential-related operation:

```bash
npm whoami --registry=https://registry.npmjs.org/
```

Publishing lets npm read its own existing credential configuration internally, but the workflow must not inspect that configuration.

Forbidden:

- reading or printing `.npmrc`;
- `npm config list`, token-list commands, or environment dumps;
- echoing auth configuration;
- asking the user to paste a password, token, or OTP;
- capturing credential files in Trellis artifacts or logs.

If npm requires interactive login, browser authorization, or OTP, stop. The user must complete it locally without sharing the secret in chat.

## Publish Gate

After validation and manifest inspection, report:

- release commit hash;
- clean worktree path;
- validation results;
- dry-run package name/version/size/file count and key content checks;
- confirmation that unrelated main-tree changes remain unstaged.

Then ask for explicit final confirmation before running:

```bash
npm publish --access public --registry=https://registry.npmjs.org/
```

## Post-publish Verification

Use registry metadata queries that do not expose credentials:

```bash
npm view @twofive/snail-pi-web@0.7.2 name version bin dist-tags --json --prefer-online
```

Where practical, run a registry download dry-run in a separate empty temporary directory to prove the package can be fetched and still exposes `spi`. Do not start a long-lived server unless separately requested.

## Failure and Rollback

- Before publish: fix validation issues in source, create a corrective commit, and recreate/reset the isolated release worktree; never publish a failed dry-run bundle.
- Authentication/OTP failure: leave the validated worktree intact and ask the user to authorize locally.
- Publish succeeds but verification is temporarily stale: retry metadata lookup with `--prefer-online`; do not republish the same version.
- npm versions are immutable. If a bad package is published, prepare a new patch version rather than attempting to overwrite `0.7.2`.
- Remove the temporary release worktree only after publication/verification or explicit cancellation.
