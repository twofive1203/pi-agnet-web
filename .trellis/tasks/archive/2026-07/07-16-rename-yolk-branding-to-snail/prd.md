# Rename Yolk branding to Snail

## Goal

Rename the current `yolk pi web` product brand to the Snail brand, with the Chinese product name `蜗牛派`, while preserving unrelated user changes and deciding compatibility-sensitive technical identifiers explicitly.

## Confirmed Facts

- The current user-facing product name is `yolk pi web` in browser metadata, the empty-chat landing header, settings/help copy, workspace-title fallback, READMEs, and deployment documentation.
- The current npm package is `@alan-zhao/yolk-pi-web`; the user wants the npm package renamed as part of this task.
- The existing `@alan-zhao` npm scope belongs to the user's friend and must not be used for the renamed package.
- The user's npm username/scope is `twofive`; the renamed package will be `@twofive/snail-pi-web`.
- `@twofive/snail-pi-web` currently returns npm registry `E404`, so it appears unpublished/available (subject to successful authenticated publishing).
- The current CLI command is `ypi`; it will be replaced by `spi` with no `ypi` compatibility alias.
- The current icon assets are `public/yolk-pi-logo.png` and `public/yolk-pi-source.png`; the layout and landing header reference the logo.
- The runtime config remains `~/.pi/agent/pi-web.json`; the previous branding task intentionally preserved this path for compatibility.
- `package.json` and `package-lock.json` contain unrelated, uncommitted pi SDK dependency updates that must be preserved.
- Historical Trellis task records and generated `.pi-subagents` artifacts contain old Yolk references and are not live product branding.

## Requirements

1. Replace live user-facing `yolk pi web` branding with `蜗牛派` as the primary UI name; use `蜗牛派（Snail Pi Web）` on first mention in README documentation and `snail-pi-web` for technical identifiers.
2. Update browser metadata, primary UI branding, user-facing settings/help text, workspace-title fallback, current READMEs, deployment docs, and startup script labels.
3. Update package/runtime identifiers only according to the compatibility decision captured during planning.
4. Replace the current egg-yolk artwork with a new local SVG snail logo designed for this task; the compact mark should remain legible as both favicon and 42px landing icon.
5. Preserve `~/.pi/agent/pi-web.json` and other stable pi integration names unless explicitly approved otherwise.
6. Do not rewrite historical Trellis archives, Git branch names/history, generated subagent artifacts, or unrelated SDK/package names.
7. Preserve all unrelated uncommitted work.

## Acceptance Criteria

- [x] Browser title and empty-chat landing branding show the approved `蜗牛派`/Snail product name and no longer show `yolk pi web`.
- [x] Live user-facing copy has no stale Yolk product references.
- [x] Current README and deployment instructions consistently use the approved package and CLI identifiers.
- [x] The UI references a Snail-appropriate local icon asset rather than the current egg-yolk artwork.
- [x] Compatibility-sensitive identifiers follow the approved migration policy.
- [x] Historical/local workflow records and unrelated user changes are untouched.
- [x] `npm run lint` passes.
- [x] `node_modules/.bin/tsc --noEmit` passes.

## Out of Scope

- Renaming `~/.pi/agent/pi-web.json` or its internal config schema.
- Renaming upstream pi SDK packages or pi agent data paths.
- Rewriting Git history, old commits, archived Trellis tasks, or generated `.pi-subagents` output.
- Changing repository remotes unless separately requested.

## Open Questions

None. The user approved creating a new local SVG snail logo for this task.
