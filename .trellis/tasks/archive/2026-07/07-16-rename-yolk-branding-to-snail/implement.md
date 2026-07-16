# Implementation Plan: Rename Yolk branding to Snail

## Pre-development

- Read `prd.md`, `design.md`, and this plan.
- Load the Trellis frontend spec index and project code/deployment standards.
- Record the current Git diff so unrelated changes remain distinguishable.
- Re-run a live-source branding search before editing.

## Implementation Checklist

1. **Create the Snail visual asset**
   - Add `public/snail-pi-logo.svg` with a compact snail and `π` shell motif.
   - Point browser metadata and the empty-chat landing header to the SVG.
   - Update landing alt/title text to `蜗牛派`.
   - Remove `public/yolk-pi-logo.png` and `public/yolk-pi-source.png` only after confirming no live references remain.

2. **Rename user-facing product copy**
   - Update browser title, landing title, settings/help copy, ChatGPT warmup/repair copy, and model configuration copy.
   - Change the workspace-title fallback to `蜗牛派`.
   - Keep unrelated text, component behavior, and configuration field names unchanged.

3. **Rename distribution identifiers**
   - Change package name to `@twofive/snail-pi-web` and description to Snail/`蜗牛派` wording.
   - Change the package bin key from `ypi` to `spi`, with no compatibility alias.
   - Apply the same root package name/bin metadata to `package-lock.json` without overwriting existing SDK dependency updates.
   - Change the product HTTP User-Agent to `snail-pi-web`.

4. **Update current documentation and operational labels**
   - Update `README.md` and `README.zh-CN.md`, using `蜗牛派（Snail Pi Web）` on first mention and the new npm/CLI commands throughout.
   - Update `docs/deployment/README.md`, including npm scope configuration, publish verification, CLI commands, proxy labels, and recommended PM2 process name.
   - Update relevant `AGENTS.md` branding/binary references.
   - Update tracked proxy startup script comments and terminal banners.
   - Do not change repository remotes, `pi-web.json`, generic `PI_WEB_*` variables, logs, or upstream pi package names.

5. **Check scope and preservation**
   - Search tracked/live files for stale Yolk package/UI references.
   - Verify remaining Yolk text exists only in explicitly excluded history/local artifacts, if any.
   - Inspect `git diff -- package.json package-lock.json` to ensure the user's pi SDK updates remain intact.
   - Confirm unrelated `components/ChatInput.tsx` and `docs/modules/frontend.md` changes were not modified by this task.

## Validation Commands

```bash
npm run lint
node_modules/.bin/tsc --noEmit
git diff --check
```

Additional checks:

```bash
git grep -n -i "yolk" -- ':!.trellis/tasks/**' ':!.pi-subagents/**'
git grep -n "@alan-zhao/yolk-pi-web\|\bypi\b" -- ':!.trellis/tasks/**' ':!.pi-subagents/**'
npm pkg get name bin description
```

Manual verification:

- Browser title is `蜗牛派`.
- Empty-chat landing header shows the new snail logo and `蜗牛派`.
- The SVG is legible at favicon and 42px sizes.
- README commands consistently use `@twofive/snail-pi-web` and `spi`.

## Risk and Rollback Points

- **Dirty package files:** edit only brand-owned fields; never regenerate or downgrade the lockfile wholesale.
- **Breaking CLI rename:** intentional; do not add `ypi` back during implementation.
- **Asset removal:** remove old images only after references have migrated and stale-reference search passes.
- **Publishing:** this task prepares source metadata but does not publish unless the user separately asks and confirms authentication/release readiness.
