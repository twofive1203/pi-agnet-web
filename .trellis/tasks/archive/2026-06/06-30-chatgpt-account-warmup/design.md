# ChatGPT account warmup design

## Scope

Phase 1 implemented manual selected-account warmup for saved `openai-codex` OAuth accounts.

Phase 2 adds scheduled warmup management for local long-running pi-web instances: persisted schedule settings, a lightweight in-process scheduler, and separate run history.

## Architecture

- UI entry point: existing ChatGPT/Codex account management area in `components/ModelsConfig.tsx`.
- UI component: `components/ChatGptWarmupDialog.tsx` for selecting accounts, manual warmup, schedule management, and recent run status.
- API route: `POST /api/auth/warmup/openai-codex` for manual warmup and `GET /api/auth/warmup/openai-codex` for recent history.
- Provider logic: `lib/openai-codex-warmup.ts`.
- Scheduled run history: new `lib/openai-codex-warmup-history.ts`, stored separately from credentials and `pi-web.json`.
- Scheduler: new `lib/openai-codex-warmup-scheduler.ts`, initialized lazily from `web-config` routes and guarded by `globalThis` state to survive Next dev hot reload without duplicate timers.
- Schedule config: extend `lib/pi-web-config.ts` `chatgpt` section with `warmup` settings.
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

## Scheduled data flow

1. Browser opens warmup dialog and loads `pi-web.json` through `/api/web-config` plus recent history from `GET /api/auth/warmup/openai-codex`.
2. User toggles scheduled warmup, selects account ids, edits daily local `HH:mm` times, and saves.
3. Dialog writes the full `chatgpt` config patch through `/api/web-config`, preserving `usagePanelEnabled` and unrelated sections.
4. The web-config route validates and persists schedule settings, then ensures the singleton scheduler is running.
5. Scheduler ticks once per minute, reads current `pi-web.json`, checks local `HH:mm`, and skips if disabled, no accounts, no matching time, a run is already in-flight, or the same date/time run key is recorded in history.
6. For a due run, scheduler records the scheduled run key and invokes `warmOpenAICodexAccounts()` sequentially.
7. Scheduler writes run history under the pi agent data directory outside credentials and config.

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
- Process selected accounts sequentially to reduce provider connection/rate-limit risk.

## Schedule config contract

```ts
interface PiWebChatGptWarmupConfig {
  enabled: boolean;
  accountIds: string[];
  times: string[]; // local 24h HH:mm, e.g. ["07:00", "13:00"]
}

interface PiWebChatGptConfig {
  usagePanelEnabled: boolean;
  warmup: PiWebChatGptWarmupConfig;
}
```

Defaults: disabled, no selected accounts, `times: ["07:00", "13:00"]`.

## Run history contract

Persist under `~/.pi/agent/chatgpt-warmup-history.json`:

```ts
interface OpenAICodexWarmupHistory {
  version: 1;
  lastScheduledRunKey: string | null;
  runs: OpenAICodexWarmupHistoryRun[];
}

interface OpenAICodexWarmupHistoryRun {
  id: string;
  source: "manual" | "scheduled";
  scheduledRunKey: string | null;
  startedAt: string;
  completedAt: string;
  accountIds: string[];
  results: ChatGptWarmupResult[];
}
```

## Compatibility and docs

- Add/update warmup route details in `docs/modules/api.md`.
- Add/update warmup dialog component details in `docs/modules/frontend.md`.
- Update `docs/modules/library.md` for the warmup helper, history helper, and scheduler.
- `AGENTS.md` only needs updates if top-level navigation changes; this task likely only updates module docs.

## Model selection

The MVP uses a fixed low-cost Codex model for warmup. The current installed built-in Codex catalog includes `gpt-5.4-mini`; use it as the default warmup model unless implementation-time validation shows it is unavailable in the active dependency version. Do not follow the user's active/default model and do not expose model selection in the first dialog.
