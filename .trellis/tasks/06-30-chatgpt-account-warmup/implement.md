# ChatGPT account warmup implementation plan

## Checklist

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

5. Validate.
   - `npm run lint`
   - `node_modules/.bin/tsc --noEmit`

## Risk points

- The Codex backend endpoint is private-ish and may reject minimal requests differently than the normal pi provider path.
- OAuth refresh must update saved credentials without touching the active account.
- The selected model should be low-cost but still sufficient to trigger the same desired quota window.
- Sequential warmup may take longer for many accounts, but avoids avoidable concurrency/rate-limit issues for MVP.

## Rollback

- Removing the new route, helper, dialog, and docs should restore previous account management behavior.
- Existing account add/import/activate/delete/quota refresh flows should not be modified except for adding the warmup entry point.
