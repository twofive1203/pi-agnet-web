# Release Snail Pi Web npm package

## Goal

Prepare and publish a new public version of `@twofive/snail-pi-web` to npm under the user's own `twofive` account, without exposing credentials or accidentally including unrelated uncommitted work.

## Confirmed Facts

- Safe authentication check `npm whoami --registry=https://registry.npmjs.org/` returns `twofive`.
- `@twofive/snail-pi-web` currently returns npm registry `E404`, so this will be the first publication under the new package identity.
- Current package version is `0.7.1` and the CLI mapping is `spi -> bin/pi-web.js`.
- The package release bundle includes `.next`, so the production build output determines which frontend source changes are published.
- The main working tree contains unrelated uncommitted work in `components/ChatInput.tsx`, `docs/modules/frontend.md`, `package.json`, and `package-lock.json`, plus other local task/artifact directories.
- The committed Snail branding release source is available at/after commit `a30603a`; task archive and journal commits follow it.
- Project release validation requires lint, TypeScript checking, the wrapped production build, and an npm pack dry run.

## Requirements

1. Publish the approved version as public package `@twofive/snail-pi-web` with CLI command `spi`.
2. Perform the release from a clean, isolated checkout/worktree based on committed source so unrelated dirty changes cannot enter `.next` or the npm tarball.
3. Bump `package.json` and `package-lock.json` consistently to the approved release version and commit that release-only version change before publication.
4. Run `npm run lint`, `node_modules/.bin/tsc --noEmit`, `npm run build`, and `npm pack --dry-run` from the clean release source.
5. Inspect the dry-run manifest for expected package name/version, CLI file, build output, public snail logo, and absence of secrets/local workflow artifacts.
6. Publish with `npm publish --access public` only after validation and explicit final confirmation.
7. Verify the registry version/dist-tag after publication and perform a non-secret package/CLI smoke check where practical.
8. Preserve all unrelated uncommitted changes in the main working tree.

## Credential Safety

- Never read, print, attach, commit, or summarize `.npmrc`, authentication tokens, passwords, OTP seeds, or credential-bearing environment variables.
- Do not run broad npm configuration dumps such as `npm config list`, token-list commands, or shell environment dumps.
- Use only non-secret identity/registry checks such as `npm whoami` and package metadata queries.
- Let npm consume existing credentials internally. If npm requests an OTP or browser authorization, stop and ask the user to complete that step locally; never ask the user to paste a token, password, or OTP into chat.
- Review Git status and npm pack contents before publishing to ensure no credential or local task files are included.

## Acceptance Criteria

- [x] Approved release version `0.7.2` is present in both package manifests.
- [x] Release validation passes from a clean isolated source tree.
- [x] Dry-run package contents contain the expected built app, `spi` CLI, and Snail logo, with no local secrets or Trellis/subagent artifacts.
- [x] npm reports `@twofive/snail-pi-web@<approved-version>` as publicly available under the `latest` tag.
- [x] Main working-tree unrelated changes remain intact and uncommitted by this release task.
- [x] No credential value is displayed, persisted into task artifacts, or committed.

## Out of Scope

- Publishing or deprecating `@alan-zhao/yolk-pi-web`.
- Changing npm account settings, tokens, email, 2FA policy, or registry credentials.
- Including unrelated slash-command or pi SDK dependency changes in this release.
- Pushing Git commits/remotes unless separately requested.

## Open Questions

None. The user approved release version `0.7.2`.
