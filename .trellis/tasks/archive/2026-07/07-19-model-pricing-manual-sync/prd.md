# Model Pricing Manual Sync

## Goal

Add manual model-pricing synchronization from `https://pi.dev/api/models`, persist the validated catalog locally, and automatically prefill pricing when custom models are added.

## Confirmed Requirements

1. Synchronization is manual only. Opening Models settings or adding a model must not fetch `pi.dev`.
2. A successful sync is stored under the Pi agent data directory and remains available across server restarts.
3. Models settings shows the cached catalog status and provides an explicit Sync action.
4. Adding a custom model looks up the local cache and fills `cost.input`, `cost.output`, `cost.cacheRead`, `cost.cacheWrite`, and `contextWindow` when a safe match exists.
5. Match by exact provider + model id first. If no exact provider exists, use a model-id-only match only when that id has exactly one catalog candidate.
6. If a model id has multiple catalog candidates, do not guess; provide a manual match action that lists provider/model/cost candidates and applies the selected candidate.
7. Never overwrite non-empty user-entered cost fields or `contextWindow` during automatic or manual enrichment.
8. Discovered OpenAI-compatible models and manually entered model ids both use the cached lookup.
9. Models settings provides a searchable provider/model pricing catalog view backed by the local cache.
10. Sync/lookup failures remain browser-safe and do not modify `models.json` or destroy the last successful cache.

## Persistence

Store a versioned cache at `~/.pi/agent/model-pricing.json` (respecting `PI_CODING_AGENT_DIR` through `getAgentDir()`). The cache records source URL, sync timestamp, provider/model counts, and normalized pricing entries.

## Non-goals

- Scheduled or startup synchronization
- Scraping the HTML page
- Editing Pi SDK built-in model prices
- Guessing among multiple provider-specific prices for the same model id
- Replacing manually entered prices

## Acceptance Criteria

- [x] Manual Sync calls the pi.dev JSON endpoint and persists a validated local cache.
- [x] The UI displays not-synced, syncing, success metadata, and readable failure states.
- [x] No network request occurs merely by opening settings or adding a model.
- [x] Exact provider/id matches prefill all four cost fields and context window when cached.
- [x] Unique id-only matches prefill costs and context window for custom provider aliases.
- [x] Ambiguous id-only matches do not apply a price automatically.
- [x] Ambiguous matches expose a manual candidate picker and apply the selected price.
- [x] Existing manual cost fields are preserved.
- [x] Last successful cache survives failed refresh attempts.
- [x] The cached catalog is visible through a searchable provider/model pricing viewer.
- [x] API/frontend/integration docs are updated.
- [x] `npm run lint` and `node_modules/.bin/tsc --noEmit` pass.
