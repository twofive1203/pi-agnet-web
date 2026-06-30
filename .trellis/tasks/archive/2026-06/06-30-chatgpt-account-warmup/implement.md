# ChatGPT account warmup implementation plan

## Phase 1 completed: manual warmup

1. Add shared warmup types and provider helper.
   - Create `lib/openai-codex-warmup.ts`.
   - Reuse saved account credential loading from `lib/oauth-accounts.ts`.
   - Reuse OAuth token refresh logic pattern from `lib/subscription-quota.ts`.
   - Send a minimal real Codex request with a timeout.
   - Refresh quota cache after each attempt using `getOAuthAccountSubscriptionQuota()`.

2. Add API route.
   - Create `app/api/auth/warmup/openai-codex/route.ts`.
   - Validate JSON payload and account ids.
   - Return typed per-account results with readable errors.

3. Add warmup UI.
   - Create `components/ChatGptWarmupDialog.tsx`.
   - Wire it into `components/ModelsConfig.tsx` near the existing saved-account list.
   - Allow multi-select of saved accounts.
   - Display per-account running/success/error state.
   - Reload accounts after completion so quota cache updates appear in the existing list.

4. Update docs.
   - `docs/modules/api.md`: add warmup route.
   - `docs/modules/frontend.md`: add warmup dialog component.
   - `docs/modules/library.md`: add warmup helper.

## Phase 2 checklist: scheduled warmup management

1. Extend pi-web config.
   - Add `PiWebChatGptWarmupConfig` to `lib/pi-web-config.ts`.
   - Default to disabled, accountIds `[]`, and times `["07:00", "13:00"]`.
   - Normalize legacy/missing configs and validate `HH:mm` schedule entries.
   - Ensure `SettingsConfig` preserves the new nested `chatgpt.warmup` field when saving unrelated ChatGPT settings.

2. Add run history storage.
   - Create `lib/openai-codex-warmup-history.ts`.
   - Store history at `~/.pi/agent/chatgpt-warmup-history.json`.
   - Track manual and scheduled runs, including results and `lastScheduledRunKey`.
   - Cap retained history to a small bounded count.

3. Add scheduler.
   - Create `lib/openai-codex-warmup-scheduler.ts`.
   - Use `globalThis` to hold one interval and in-flight scheduled keys across Next dev hot reloads.
   - Tick once per minute and read fresh `pi-web.json` each tick.
   - Skip duplicate local date/time keys already recorded in history.
   - Invoke `warmOpenAICodexAccounts()` sequentially and record scheduled history.
   - Initialize lazily from `app/api/web-config/route.ts` and warmup routes.

4. Extend API.
   - Add `GET /api/auth/warmup/openai-codex` to return recent history and ensure scheduler.
   - Update manual `POST` to record manual run history.

5. Extend UI.
   - Add schedule controls to `components/ChatGptWarmupDialog.tsx`.
   - Load/save schedule through `/api/web-config`.
   - Let users choose schedule accounts and daily local times.
   - Show recent manual/scheduled history.

6. Update docs.
   - `docs/modules/api.md`: note warmup history GET and schedule behavior.
   - `docs/modules/frontend.md`: update warmup dialog responsibilities.
   - `docs/modules/library.md`: add history/scheduler helpers and config extension.

7. Validate.
   - `npm run lint`
   - `node_modules/.bin/tsc --noEmit`

## Risk points

- The Codex backend endpoint is private-ish and may reject minimal requests differently than the normal pi provider path.
- OAuth refresh must update saved credentials without touching the active account.
- The selected model should be low-cost but still sufficient to trigger the same desired quota window.
- Sequential warmup may take longer for many accounts, but avoids avoidable concurrency/rate-limit issues.
- Next dev hot reload can re-evaluate modules, so scheduler state must live on `globalThis`.
- In-process scheduling only works while the local pi-web Node process is running and after some request has initialized the scheduler.

## Rollback

- Removing the new route, helper, dialog, scheduler/history helpers, config extension, and docs should restore previous account management behavior.
- Existing account add/import/activate/delete/quota refresh flows should not be modified except for adding the warmup entry point and schedule controls.
