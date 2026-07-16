# Design: Rename Yolk branding to Snail

## Overview

Perform a bounded product-brand migration from `yolk pi web` to `蜗牛派`, while changing distribution identifiers to `@twofive/snail-pi-web` and `spi`. Keep generic pi integration identifiers and persisted configuration paths stable.

## Naming Contract

| Surface | New value |
| --- | --- |
| Primary browser/UI name | `蜗牛派` |
| First README mention | `蜗牛派（Snail Pi Web）` |
| Technical product identifier | `snail-pi-web` |
| npm package | `@twofive/snail-pi-web` |
| CLI command | `spi` |
| HTTP User-Agent | `snail-pi-web` |
| Runtime config | `~/.pi/agent/pi-web.json` (unchanged) |

The old `ypi` CLI alias will not be retained, per the user's decision.

## Change Boundaries

### User-facing surfaces

Update:

- `app/layout.tsx` metadata and icon path.
- `components/ChatWindow.tsx` empty-chat icon, alt text, and title.
- Product references in ChatGPT usage/warmup, model configuration, and settings copy.
- `lib/workspace-title.ts` fallback title.
- README files, deployment guide, AGENTS navigation title, and proxy startup labels.

### Distribution and runtime identifiers

Update only the brand-owned identifiers:

- Root package name/description and lockfile root package metadata.
- Package bin key from `ypi` to `spi` while keeping the generic implementation file `bin/pi-web.js`.
- Product HTTP User-Agent string.
- Documentation command examples, package scope, and PM2 process-name guidance.

Keep stable/generic integration names unchanged:

- `~/.pi/agent/pi-web.json` and `lib/pi-web-config.ts`.
- `PI_CODING_AGENT_DIR`, `PI_WEB_CMD`, pi SDK package names, and pi agent data paths.
- Generic source filenames such as `bin/pi-web.js` and existing repository remote URLs.

### Logo

Create `public/snail-pi-logo.svg` as a compact transparent SVG:

- recognizable snail silhouette at favicon and 42px sizes;
- shell includes a small `π` motif to retain the pi-agent association;
- simple warm shell and contrasting body colors with a dark outline;
- no external image/font dependency and no embedded raster data.

Use the SVG in metadata and the empty-chat landing header. Remove the tracked Yolk logo/source assets after all live references are migrated.

## Compatibility and Migration

- The package rename creates a new npm package identity; publishing `@twofive/snail-pi-web` does not move or delete `@alan-zhao/yolk-pi-web`.
- `ypi` intentionally stops being installed. Existing scripts must migrate to `spi`.
- Existing application settings continue to work because `pi-web.json` and its schema are unchanged.
- Existing pi data/session paths are unchanged.
- Package version `0.7.1` may remain for the first publication under the new package name unless release preparation separately changes it.

## Preservation Strategy

- Restrict edits in `package.json` and `package-lock.json` to branding/root package metadata and bin mapping; preserve the user's uncommitted pi SDK `0.80.7` dependency updates.
- Do not touch `components/ChatInput.tsx` or its related uncommitted documentation change.
- Do not rewrite historical `.trellis/tasks/**`, `.pi-subagents/**`, `.git/**`, or branch names.
- Use tracked-file and live-source searches for stale branding rather than blindly replacing every historical occurrence.

## Validation

- Search live tracked product files for stale `yolk`, `@alan-zhao/yolk-pi-web`, and `ypi` references, excluding historical Trellis task records.
- Confirm metadata and `ChatWindow` reference `snail-pi-logo.svg`.
- Confirm package and lockfile root metadata match `@twofive/snail-pi-web`, and package bin exposes only `spi`.
- Run `npm run lint` and `node_modules/.bin/tsc --noEmit`.
- Run `git diff --check` and inspect the final diff to ensure unrelated uncommitted work is preserved.

## Rollback

The rename is confined to text metadata and static assets. Before publication, rollback is a normal source revert. After publication, the new npm package remains a separate registry entry; reverting source does not remove it. No persisted user data migration is involved.
