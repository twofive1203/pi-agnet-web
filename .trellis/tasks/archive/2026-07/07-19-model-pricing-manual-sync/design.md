# Design: Model Pricing Manual Sync

## Data Flow

```text
Models settings Sync button
  -> POST /api/model-pricing
     -> fetch https://pi.dev/api/models
     -> validate and normalize provider/id/cost
     -> atomic write ~/.pi/agent/model-pricing.json
     -> return cache summary

Custom model id/addition
  -> GET /api/model-pricing?provider=<provider>&model=<id>
     -> read local cache only
     -> exact provider/id or unique id fallback
     -> return cost match, no-match, or provider/model/cost candidates when ambiguous
     -> merge only missing cost fields into staged ModelsConfig state
     -> user can manually choose one ambiguous candidate

Pricing catalog viewer
  -> GET /api/model-pricing?catalog=1
     -> read and flatten local cache only
     -> search/filter provider and model in the browser
```

## Server Boundary

Create `lib/model-pricing.ts` for external payload validation, cache read/write, summary, and lookup logic. The App Router route remains thin.

The upstream payload is untrusted. Accept only object-shaped provider maps with object-shaped model entries and finite, non-negative numeric values for all four cost fields, plus an optional finite positive `contextWindow`. Normalize only the fields needed by the Web UI. Write a temporary file in the same directory, then rename it over the cache so a failed refresh cannot corrupt the previous catalog.

## API

`GET /api/model-pricing`

- Without `provider`/`model`: cache summary only.
- With `model` and optional `provider`: cached lookup only, returning exact, unique-id, ambiguous candidates, or no-match metadata.
- With `catalog=1`: normalized cached catalog for read-only browsing.
- Never performs upstream network I/O.

`POST /api/model-pricing`

- Fetches the fixed pi.dev endpoint with a timeout and JSON accept header.
- Validates, persists, and returns the new summary.
- On failure, returns an error without replacing the old cache.

## UI

Add a compact pricing catalog row in the Models modal header with sync state, last sync time, counts, and an icon button. Model ID edits use a short debounce before local lookup. Discovered model additions perform the same lookup as part of staging.

Automatic enrichment merges only absent cost properties and `contextWindow`. A small source message on the model detail reports when cached pricing or context data was applied. Ambiguous id-only results expose a manual match button and portal dialog listing each provider, context, and four cost fields; choosing one fills only missing values. A separate portal catalog viewer supports provider filtering and provider/model search.

## Documentation

Update `AGENTS.md`, `docs/modules/api.md`, `docs/modules/frontend.md`, and `docs/integrations/README.md`.
