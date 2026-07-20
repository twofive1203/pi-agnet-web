# Design: Grok structured usage panel

## Summary

Replace the `pi-grok-cli` `/grok-cli-usage` command bridge with a server-owned structured Grok billing query. Persist last successful results, expose a shared usage API, and render the same data in:

1. an optional top-bar `GrokUsagePanel` (ChatGPT-panel interaction pattern, manual refresh only)
2. Models → Grok CLI → Subscription

OAuth login/model registration remains owned by `pi-grok-cli`. This task only owns billing fetch, cache, API, and display.

## Architecture

```text
Settings (pi-web.json.grok.usagePanelEnabled)
  -> AppShell top bar
     -> GrokUsagePanel
        -> GET /api/auth/usage/grok-cli?mode=cache   (or default cache-first)
        -> GET /api/auth/usage/grok-cli?mode=refresh (manual)

ModelsConfig OAuthDetail (provider=grok-cli)
  -> same GET /api/auth/usage/grok-cli cache/refresh

API route
  -> lib/grok-usage.ts
     -> resolve token via AuthStorage + ModelRegistry.getApiKeyForProvider("grok-cli")
        (optional env bypass GROK_CLI_OAUTH_TOKEN, same as plugin)
     -> fetch xAI billing:
          GET {baseUrl}/billing
          GET {baseUrl}/billing?format=credits
        headers:
          Authorization: Bearer <token>
          x-xai-token-auth: xai-grok-cli
     -> parse monthly + optional weekly
     -> on success: write last-known cache under agent dir
     -> return browser-safe structured JSON (no credentials)
```

## Contracts

### Config (`lib/pi-web-config.ts`)

Add a dedicated `grok` section (do not overload `chatgpt`):

```ts
export interface PiWebGrokConfig {
  usagePanelEnabled: boolean;
}

export interface PiWebConfig {
  // existing...
  chatgpt: PiWebChatGptConfig;
  grok: PiWebGrokConfig;
}
```

Default:

```json
{
  "grok": {
    "usagePanelEnabled": false
  }
}
```

`readPiWebConfig` / `writePiWebConfigPatch` / Settings UI must accept and preserve `grok`.

### Structured usage payload

```ts
export interface GrokMonthlyUsage {
  used: number;
  monthlyLimit: number;
  remaining: number;
  utilization: number; // 0-100, derived
  billingPeriodEnd: string; // ISO
}

export interface GrokWeeklyUsage {
  creditUsagePercent: number; // 0-100
  billingPeriodEnd: string; // ISO
}

export interface GrokUsageResult {
  provider: "grok-cli";
  configured: boolean;
  success: boolean;
  source: "cache" | "live";
  monthly: GrokMonthlyUsage | null;
  weekly: GrokWeeklyUsage | null;
  error: string | null;
  queriedAt: number | null;
  envBypass: boolean; // true when GROK_CLI_OAUTH_TOKEN was used; never include the token
}
```

Rules:

- `remaining = max(0, monthlyLimit - used)`
- `utilization = clamp(round(used / monthlyLimit * 100), 0, 100)` when limit > 0; otherwise 0
- weekly is optional; omit/null when credits endpoint fails or payload lacks weekly period
- never return access/refresh tokens or raw credential objects

### API

Rewrite the Grok-only usage surface. Preferred shape:

- `GET /api/auth/usage/grok-cli`
  - default / `?mode=cache`: return last-known cache if present; if no cache, return `success:false` with browser-safe “not queried yet / no cache” state (do not auto-hit billing)
  - `?mode=refresh`: live billing fetch; on success overwrite cache; on failure return browser-safe error and leave previous cache intact (response may include previous cache fields only if product chooses, but preferred: return live failure payload and let client keep its in-memory previous success)

Implementation options (pick one during implement; prefer simplest that preserves route docs):

1. Keep `app/api/auth/usage/[provider]/route.ts`, support only `provider=grok-cli`, switch method from POST+cwd to GET+mode.
2. Or replace with fixed `app/api/auth/usage/grok-cli/route.ts` and delete the dynamic allowlist if no other providers remain.

Do **not** accept browser-supplied command names or cwd for usage.

HTTP mapping guidance:

| Condition | HTTP | Body |
| --- | --- | --- |
| Provider unsupported | 404 | `{ error }` |
| Not logged in / no token | 200 | `configured:false` or `success:false` with actionable error |
| No cache on cache read | 200 | `success:false`, `source:"cache"`, empty monthly/weekly, error like “Not queried yet” |
| Live success | 200 | `success:true`, `source:"live"`, structured fields |
| Live billing/network failure | 200 or 502 | `success:false`, browser-safe error; do not leak stack |
| Abort/timeout | 200 or 504 | browser-safe timeout/cancel message |

Prefer DeepSeek balance style: mostly `200 + success flag` for query outcomes, reserve hard 4xx for invalid provider/input.

### Cache

Store last successful structured result under the agent dir, e.g.:

```text
~/.pi/agent/grok-cli-usage-cache.json
```

Suggested schema:

```json
{
  "version": 1,
  "provider": "grok-cli",
  "monthly": { "used": 0, "monthlyLimit": 0, "remaining": 0, "utilization": 0, "billingPeriodEnd": "..." },
  "weekly": null,
  "queriedAt": 1710000000000,
  "envBypass": false
}
```

- Write only on live success.
- Read failures degrade to “no cache”.
- No multi-account keying in MVP (single active `grok-cli` credential model).
- Do not store tokens in the cache file.

### Token resolution (`lib/grok-usage.ts`)

Mirror the plugin command’s resolution order as closely as practical without importing the package:

1. If `process.env.GROK_CLI_OAUTH_TOKEN` is non-empty, use it and set `envBypass:true`.
2. Else `AuthStorage.create()` + `ModelRegistry.create(authStorage)` + `getApiKeyForProvider("grok-cli")`.
3. If missing, return not-configured / login guidance.

Base URL:

```text
process.env.PI_GROK_CLI_BASE_URL
|| process.env.GROK_CLI_BASE_URL
|| "https://cli-chat-proxy.grok.com/v1"
```

(strip trailing slashes)

Billing headers:

```ts
{
  authorization: `Bearer ${token}`,
  "x-xai-token-auth": "xai-grok-cli",
  accept: "application/json",
}
```

Parse rules should follow `pi-grok-cli` `src/provider/billing.ts`:

- monthly from `/billing` → `config.monthlyLimit.val`, `config.used.val`, `config.billingPeriodEnd`
- weekly from `/billing?format=credits` → only when `currentPeriod.type === "USAGE_PERIOD_TYPE_WEEKLY"`; `creditUsagePercent` defaults to 0 when omitted

Timeout: bounded (e.g. 15s), abortable via request signal when available.

## UI Design

### Settings

In `components/SettingsConfig.tsx`, add a Grok section/toggle near ChatGPT settings:

- Label: Grok 用量面板
- Description: 在顶栏显示 Grok CLI 用量；仅手动刷新，打开时先显示上次成功结果。
- Bound to `webConfig.grok.usagePanelEnabled`.

### Top bar (`components/AppShell.tsx`)

Render when `webConfig?.grok.usagePanelEnabled === true`, adjacent to the ChatGPT panel region (same right-side usage area). Keep layout padding logic aware of either/both panels.

### New component `components/GrokUsagePanel.tsx`

Align interaction with `ChatGptUsagePanel`:

- collapsed pill: `Grok` label + compact status (Updated / Loading / Error / Not queried) + mini utilization pie(s)
- expanded fixed popover via portal (avoid top-bar clip)
- show monthly used/limit/remaining/utilization/reset
- show weekly percent/reset when present
- manual refresh button only
- open: load cache first; no automatic live refresh
- no account switcher / reset-credit / scheduler diagnostics

Shared display helpers: reuse `lib/quota-display.ts` where colors/countdown/time formatting already fit; do not force Grok into Codex tier names. Prefer small Grok-specific formatters next to the component or in `lib/grok-usage-display.ts` if needed.

### Models Subscription

Replace `GrokUsageView` text/notices UI in `components/ModelsConfig.tsx` with a structured card that calls the same usage API:

- remove cwd requirement for Grok usage
- remove `ExtensionCommandResult` state / abort path tied to command bridge
- keep isolated from Codex multi-account quota code

## Cleanup

Current consumers of the command bridge:

- `app/api/auth/usage/[provider]/route.ts`
- `components/ModelsConfig.tsx`
- `lib/extension-command-runner.ts` (only used by the usage route)

After structured rewrite:

- delete or rewrite the POST+cwd usage route
- remove Models command-bridge client code
- if `runExtensionCommand` has no remaining callers, delete `lib/extension-command-runner.ts`
- do not leave dead `PROVIDER_USAGE_COMMANDS` allowlist for `grok-cli-usage`

## Compatibility / Boundaries

| Owned by pi-web after this task | Still owned by `pi-grok-cli` |
| --- | --- |
| billing fetch + parse for usage UI | OAuth login / token refresh registration |
| last-known usage cache | model catalog / streaming / tools |
| top-bar panel + Models structured view | `/grok-cli-usage` command in TUI |
| Settings toggle | package install lifecycle |

Risk: xAI billing payload or base URL drift. Mitigation: keep parser tightly scoped and browser-safe; document the copied contract in integrations docs. Do not import `pi-grok-cli` as a runtime dependency of the Next server.

## Documentation updates

- `docs/modules/api.md` — structured usage GET, cache/refresh modes, remove command-bridge description
- `docs/modules/frontend.md` — `GrokUsagePanel`, Models structured Grok usage, Settings toggle
- `docs/integrations/README.md` — usage no longer via `/grok-cli-usage`; OAuth still via package
- `AGENTS.md` config index if it lists `pi-web.json` sections (add Grok panel)

## Rollback

- Revert new config key / panel / helper / route changes
- If needed, restore previous command-bridge route and Models text view from git history
- Cache file is additive and safe to ignore
