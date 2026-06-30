# ChatGPT account warmup

## Goal

Add a ChatGPT/Codex account warmup workflow so a user can intentionally trigger the ChatGPT 5-hour quota window for selected saved `openai-codex` accounts from pi-web.

## User Value

- The user can prepare one or more saved ChatGPT Plus/Pro accounts before active coding work starts.
- The user can see whether warmup succeeded and whether quota reset metadata was refreshed afterward.
- A later scheduled warmup flow can automate recurring morning/afternoon warmups.

## Confirmed Facts from Repository

- Saved ChatGPT/Codex accounts are managed as `openai-codex` OAuth accounts.
- Account UI currently lives mostly in `components/ModelsConfig.tsx` and includes add/import, activate, delete, remark, extra info, and per-account quota refresh.
- Saved account credentials and metadata are handled by `lib/oauth-accounts.ts` under the pi agent data directory.
- Quota querying is implemented in `lib/subscription-quota.ts` through `https://chatgpt.com/backend-api/wham/usage`, updates per-account `quotaCache`, and supports querying a specific saved account by `accountId`.
- Existing quota refresh is read-only from a quota-window perspective; warmup should send a real minimal Codex model request.
- `pi-web.json` currently has `chatgpt.usagePanelEnabled`; it has no warmup settings or schedule config yet.
- The app uses Next.js node runtime API routes, shared logic in `lib/`, and client UI components under `components/`.

## Requirements

### MVP: Manual warmup

- Provide a way to select one or more saved `openai-codex` accounts and warm them up on demand.
- Warmup must use saved account credentials without requiring the account to become the active account.
- Warmup must send a minimal real Codex request, not only query quota.
- Warmup must report per-account success or failure.
- After each account warmup, refresh that account's quota cache when possible so reset metadata in existing account UI stays current.
- The UI should fit the existing account-management flow and avoid exposing OAuth tokens or raw credential content.

### Phase 1: Completed manual warmup

- The first implementation includes manual selected-account warmup only.
- Manual warmup uses a fixed low-cost Codex model and refreshes quota cache afterward.

### Phase 2: Scheduled warmup management

- Allow saved schedules such as daily `07:00` and `13:00`.
- Allow choosing which saved accounts participate in scheduled warmup.
- Persist schedule configuration in `pi-web.json` under the existing ChatGPT config section.
- Keep run history separate from credentials and general config.
- Prevent duplicate scheduled runs caused by dev hot reload or server restart.
- Show enough schedule and recent-run status in the warmup management UI to verify automation is configured.

## Acceptance Criteria

- [ ] A user can open a ChatGPT warmup management UI from the existing ChatGPT/Codex account management area.
- [ ] The UI lists saved accounts with enough labels/status to choose target accounts.
- [ ] The user can run immediate warmup for selected accounts.
- [ ] The API returns a typed per-account result containing success/failure and readable error messages.
- [ ] Non-active saved accounts can be warmed without changing the currently active account.
- [ ] Successful or attempted warmup refreshes the selected account's quota cache when possible.
- [ ] The implementation keeps provider-specific network logic in `lib/` and route-specific glue in `app/api/**/route.ts`.
- [ ] Existing account add/import/activate/delete/quota refresh flows continue to work.
- [ ] Documentation route/module maps are updated if new API routes or major components are added.
- [ ] `npm run lint` and `node_modules/.bin/tsc --noEmit` pass.
- [ ] A user can enable scheduled warmup from the warmup management UI.
- [ ] The user can choose saved accounts for scheduled warmup without exposing credentials.
- [ ] The user can save daily warmup times such as `07:00` and `13:00`.
- [ ] The schedule persists in `pi-web.json` and preserves unrelated ChatGPT settings.
- [ ] Scheduled run history is persisted outside credentials and general config.
- [ ] The scheduler avoids duplicate runs for the same local date/time across dev hot reload or server restart.

## Out of Scope Unless Explicitly Approved

- Browser automation of chatgpt.com.
- Changing active account as part of warmup.
- Sending large prompts, using project context, tools, or creating pi AgentSession JSONL files for warmup.
- Cross-process or external cron scheduler.
- Serverless-compatible scheduling guarantees.

## Product Decisions

- Warmup uses a fixed low-cost Codex model by default for the first implementation.

## Open Questions

None for MVP planning.
