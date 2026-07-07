# Design: Import provider models from /models

## Scope

Add an explicit model discovery flow for custom OpenAI-compatible providers in the existing Models configuration modal. The feature fetches a remote model list, presents candidates in the UI, and stages one selected model entry for the existing Save flow.

## Architecture and Boundaries

### Frontend

`components/ModelsConfig.tsx` remains the owner of the draft `ModelsJson` state and persistence flow.

- `ProviderDetail` is the natural place for the discovery action because it already edits `baseUrl`, `apiKey`, and `api`.
- The top-level `ModelsConfig` component should own insertion into the provider's `models` array so it can reuse selection behavior and avoid persisting discovery-only state.
- `ModelDetail` should remain the edit/test surface after a model is inserted.

### Backend

Add a route-specific server endpoint under `app/api/models-config/` for discovery, e.g. `app/api/models-config/discover/route.ts`.

Responsibilities:

- Accept a draft `{ providerName, provider }` payload.
- Validate provider shape and supported provider API.
- Resolve auth and headers consistently with the existing test route.
- Build and try accepted `/models` URL candidates.
- Fetch with timeout and no retries.
- Parse OpenAI-compatible response bodies into normalized candidates.
- Return structured success/error data to the UI.

Do not use `/api/models` for discovery; it only lists already configured registry models.

## Data Flow

1. User edits or creates a custom provider in the Models modal.
2. User clicks a discovery control in the provider detail area.
3. Browser POSTs the current draft provider config to the new discovery endpoint.
4. Server validates the provider and resolves auth/headers using the same model registry semantics used by the test route.
5. Server tries URL candidates in order:
   - `<base>/models` when base path already ends in `/v1` or `/api/v1`.
   - Otherwise `<base>/v1/models`, then `<base>/models`.
6. Server parses JSON and normalizes `data[]` entries with string `id` into candidates like:
   ```ts
   interface DiscoveredModelCandidate {
     id: string;
     name?: string;
     ownedBy?: string;
   }
   ```
7. UI displays candidates with loading/error/success state, search, and ownership/source grouping.
8. User clicks a row-level `+` action for a not-yet-added candidate.
9. UI checks the current provider for duplicate `model.id`.
10. If unique, UI appends `{ id, name? }` to the provider's staged `models` array while keeping the discovery list open.
11. The newly-added candidate row changes from `+` to `-`; already-added candidates show the same row-level `-` action that removes the matching model from the staged provider list.
12. User clicks Save to persist via existing `PUT /api/models-config`.

## Contracts

### Discovery Request

```ts
interface DiscoverModelsRequest {
  providerName: string;
  provider: ProviderEntry;
}
```

`providerName` is used for temporary registry construction and diagnostics. `provider` is the draft provider config from the UI.

### Discovery Response

Success:

```ts
interface DiscoverModelsResponse {
  ok: true;
  url: string;
  triedUrls: string[];
  models: DiscoveredModelCandidate[];
}
```

Failure:

```ts
interface DiscoverModelsResponse {
  ok: false;
  error: string;
  triedUrls?: string[];
  status?: number;
  responseText?: string;
}
```

Keep response excerpts short to avoid dumping secrets or large HTML pages into the UI.

## Auth and Header Handling

The discovery endpoint should follow the model test route pattern rather than implementing unrelated auth rules. The likely approach is to build a temporary `models.json` with the draft provider and a placeholder model, create a `ModelRegistry`, find the placeholder model, and call `registry.getApiKeyAndHeaders(model)`.

Important constraints:

- Do not log API keys.
- Do not echo auth headers in errors.
- Respect provider `headers`.
- Return a clear error when auth resolution fails or no API key is available.

## Compatibility Notes

- Scope is intentionally OpenAI-compatible only: `openai-completions` and `openai-responses`.
- Primary supported response shape is OpenAI/NewAPI style `{ data: [{ id: string, ... }] }`.
- Extra provider fields should not be persisted automatically.
- If a provider returns model aliases, the alias id is the correct value to import.
- Returned ids are advertised availability only; completion still requires the existing Test flow or actual chat usage.

## UI Behavior

- The discovery UI should be non-destructive.
- Loading/error state should be local to the currently selected provider detail.
- Manual `+ model` remains available.
- Returned candidates are grouped by `owned_by`/owner when available, with collapsible groups and search over id/name/owner.
- Not-yet-added candidates show a row-level `+`; already-added candidates show a row-level `-`.
- Duplicate candidate ids should be visually or textually marked and blocked from insertion.
- After insertion, keep the discovery list active so users can add or remove more returned candidates; users can select imported model rows from the left model list for review/editing before Save.

## Security and Operational Considerations

- Server-side fetch avoids browser-origin key leakage but introduces server-side outbound requests. Keep this route scoped to configured provider URLs, use a short timeout, and reject missing/invalid URLs.
- Avoid broad SSRF-hardening expansion in this task unless existing project patterns require it; at minimum require `http:`/`https:` URLs and do not support non-URL inputs.
- Limit parsed model count and response/excerpt sizes to keep the UI responsive.
- Discovery must not mutate `models.json`; rollback is simply closing/canceling the modal before Save.

## Documentation Impact

- Update `docs/modules/api.md` to add the new discovery route.
- If editing the nearby `models-config/` row, correct the method listing from `GET/POST` to `GET/PUT` to match source behavior.
- Update `docs/modules/frontend.md` only if it describes the Models modal in enough detail that this new behavior should be discoverable there.

## Trade-offs Accepted

- Single-model add instead of bulk import keeps the MVP smaller and avoids accidental large config changes.
- Minimal `{ id, name? }` import avoids incorrect metadata mapping across proxy ecosystems.
- Existing Save button persistence preserves the current modal mental model.
- Duplicate blocking is safer than overwriting user-customized model entries.
