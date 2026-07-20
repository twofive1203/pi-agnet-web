# Implementation Plan: Grok structured usage panel

## Checklist

1. **Config surface**
   - Add `PiWebGrokConfig` + defaults + patch/read validation in `lib/pi-web-config.ts`.
   - Expose Settings toggle in `components/SettingsConfig.tsx`.
   - Ensure `AppShell` / web-config consumers type-check with the new section.

2. **Server usage core**
   - Add `lib/grok-usage.ts`:
     - token resolution (`GROK_CLI_OAUTH_TOKEN` then `ModelRegistry.getApiKeyForProvider("grok-cli")`)
     - base URL resolution
     - monthly + weekly billing fetch/parse
     - last-known cache read/write under agent dir
     - browser-safe result mapping
   - Prefer patterns from `lib/deepseek-balance.ts` for result shape and error handling.
   - Do not import `pi-grok-cli` package code into the server runtime.

3. **API route rewrite**
   - Convert Grok usage API from POST+cwd+extension-command to GET structured cache/refresh.
   - Remove allowlisted `grok-cli-usage` command mapping.
   - Confirm no remaining callers of `runExtensionCommand`; if none, delete `lib/extension-command-runner.ts`.

4. **Top-bar panel**
   - Add `components/GrokUsagePanel.tsx` (ChatGPT panel interaction: portal popover, manual refresh, cache-first load).
   - Mount from `components/AppShell.tsx` when `webConfig.grok.usagePanelEnabled`.
   - Adjust right-side padding if both GPT and Grok panels can show.

5. **Models Subscription replacement**
   - Replace `GrokUsageView` notices renderer with structured usage card.
   - Remove cwd-gated usage query, `ExtensionCommandResult` state, and command-bridge fetch path for Grok.
   - Use the same API as the top-bar panel.

6. **Docs**
   - Update `docs/modules/api.md`, `docs/modules/frontend.md`, `docs/integrations/README.md`.
   - Update `AGENTS.md` / deployment config index if they enumerate `pi-web.json` sections.

7. **Validation**
   - `npm run lint`
   - `node_modules/.bin/tsc --noEmit`
   - Manual smoke (when credentials available):
     - logged-in Grok → refresh succeeds → cache file written → reopen shows cache without refresh
     - panel toggle on/off
     - Models Grok Subscription structured view
     - not-logged-in / token failure browser-safe error
     - confirm no `/grok-cli-usage` / `runExtensionCommand` path remains for usage

## Suggested file touch list

| Area | Files |
| --- | --- |
| Config | `lib/pi-web-config.ts`, `components/SettingsConfig.tsx` |
| Core/API | `lib/grok-usage.ts` (new), `app/api/auth/usage/**`, maybe delete `lib/extension-command-runner.ts` |
| UI | `components/GrokUsagePanel.tsx` (new), `components/AppShell.tsx`, `components/ModelsConfig.tsx` |
| Docs | `docs/modules/api.md`, `docs/modules/frontend.md`, `docs/integrations/README.md`, possibly `AGENTS.md` |

## Review gates

- No credential leakage in API responses or cache file.
- No automatic live billing on panel mount (cache-first only).
- No residual dependency on extension command runner for Grok usage.
- Keep Codex quota / ChatGPT panel behavior unchanged.
- Keep Grok OAuth login path unchanged.

## Rollback points

1. After config-only changes: safe to revert config keys.
2. After API helper: clients still old until UI switches.
3. After UI switch + command-bridge removal: full feature; rollback via git restore of route/UI/helper.

## Out of scope reminders

- No scheduler
- No multi-account Grok switching
- No package install UI
- No OAuth rewrite
