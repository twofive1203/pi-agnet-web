# ChatGPT account warmup design

## Scope

Implement manual selected-account warmup for saved `openai-codex` OAuth accounts. Scheduling, persisted schedule config, and recurring background timers are deferred.

## Architecture

- UI entry point: existing ChatGPT/Codex account management area in `components/ModelsConfig.tsx`.
- New UI component: `components/ChatGptWarmupDialog.tsx` for selecting accounts and showing per-account warmup results.
- API route: `POST /api/auth/warmup/openai-codex`.
- Provider logic: new `lib/openai-codex-warmup.ts`.
- Existing quota refresh: reuse `getOAuthAccountSubscriptionQuota()` from `lib/subscription-quota.ts` after each warmup attempt.
- Existing account credential reads: reuse `readOAuthAccountCredential()` and token refresh path equivalent to `lib/subscription-quota.ts` so non-active accounts can warm without changing active auth.

## Data flow

1. Browser opens warmup dialog from the saved account list.
2. User selects one or more account ids and starts warmup.
3. Dialog posts `{ accountIds: string[] }` to `POST /api/auth/warmup/openai-codex`.
4. Route validates payload and delegates to `warmOpenAICodexAccounts()` in `lib/openai-codex-warmup.ts`.
5. Library reads each saved account credential, refreshes/uses an access token, sends a minimal real Codex request, then refreshes quota cache.
6. Route returns typed per-account results.
7. Dialog renders success/failure and asks the parent account view to reload accounts so cached reset metadata is visible.

## API contract

Request:

```ts
interface ChatGptWarmupRequest {
  accountIds: string[];
}
```

Response:

```ts
interface ChatGptWarmupResponse {
  provider: "openai-codex";
  modelId: "gpt-5.4-mini";
  results: ChatGptWarmupResult[];
}

interface ChatGptWarmupResult {
  accountId: string;
  success: boolean;
  error: string | null;
  latencyMs: number | null;
  quotaRefreshSuccess: boolean;
  quotaError: string | null;
}
```

## Warmup request behavior

- Send a tiny real Codex model request, not a quota-only request.
- Do not create pi AgentSession JSONL files.
- Do not activate or replace the current active account.
- Use no tools and no project context.
- Keep OAuth access/refresh tokens server-side only.
- Process selected accounts sequentially for MVP to reduce provider connection/rate-limit risk.

## Compatibility and docs

- Add the new route to `docs/modules/api.md`.
- Add the new component to `docs/modules/frontend.md`.
- Update `docs/modules/library.md` for the new provider helper.
- `AGENTS.md` only needs updates if top-level navigation changes; this task likely only updates module docs.

## Model selection

The MVP uses a fixed low-cost Codex model for warmup. The current installed built-in Codex catalog includes `gpt-5.4-mini`; use it as the default warmup model unless implementation-time validation shows it is unavailable in the active dependency version. Do not follow the user's active/default model and do not expose model selection in the first dialog.
