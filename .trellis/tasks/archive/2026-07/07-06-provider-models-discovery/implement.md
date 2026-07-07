# Implementation Plan: Import provider models from /models

## Preconditions

- Planning artifacts reviewed and approved by the user.
- Task status moved from `planning` to `in_progress` with `task.py start` before code edits.
- Load Trellis frontend/guides specs before implementation.

## Checklist

1. **Inspect latest local context**
   - Re-read `components/ModelsConfig.tsx` around provider/model types, `ProviderDetail`, `addModel`, selection, and save flow.
   - Re-read `app/api/models-config/test/route.ts` for existing temporary registry/auth handling.
   - Check `docs/modules/api.md` and `docs/modules/frontend.md` for documentation update points.

2. **Add backend discovery route**
   - Create `app/api/models-config/discover/route.ts`.
   - Validate payload shape: `providerName` string, `provider` object.
   - Restrict provider API to `openai-completions` and `openai-responses`.
   - Validate `baseUrl` as `http:` or `https:`.
   - Resolve API key and headers consistently with `models-config/test`.
   - Build accepted URL candidates.
   - Fetch candidates sequentially with timeout.
   - Parse JSON `data[]` model objects with string `id`.
   - Return normalized candidates, tried URLs, chosen URL, or concise diagnostics.

3. **Integrate Models UI discovery**
   - Add discovery request/response/candidate TypeScript types near existing model config types.
   - Add discovery state and handlers in `ModelsConfig` or pass callbacks into `ProviderDetail` without persisting discovery-only state to `ModelsJson`.
   - Add a provider detail control to fetch remote models.
   - Render returned candidates with search, ownership/source grouping, collapsible group headers, and added-state indication.
   - Add a not-yet-added candidate to current provider as `{ id, name? }` only through a row-level `+` action.
   - Remove an already-added candidate from the current provider draft through a row-level `-` action.
   - Keep the discovery list open after row-level add/remove so the plus/minus state updates in place.
   - Keep manual `+ model` unchanged.

4. **Duplicate and error handling**
   - Block duplicate insertion if a provider already has `model.id === candidate.id`.
   - Show a clear duplicate or staged-removal message.
   - Show discovery errors without modifying provider/model draft config.
   - Reset or scope discovery state when switching providers or changing key provider fields.

5. **Documentation**
   - Update `docs/modules/api.md` with the new discovery route.
   - Correct `models-config/` methods to `GET/PUT` if editing that row.
   - Update `docs/modules/frontend.md` if the Models modal section should mention remote model discovery.

6. **Validation**
   - Run `npm run lint`.
   - Run `node_modules/.bin/tsc --noEmit`.
   - Manual browser/API verification:
     - Configure an OpenAI-compatible provider with a valid base URL and key.
     - Fetch models and add one returned id.
     - Confirm duplicate add is blocked.
     - Save and reload `/api/models-config` to verify persistence.
     - Confirm `/api/models` includes the saved model after registry refresh.
     - Verify bad URL/key/non-JSON responses show non-destructive errors.

## Risky Files / Rollback Points

- `components/ModelsConfig.tsx` is large; keep edits localized and avoid broad formatting changes.
- `app/api/models-config/test/route.ts` should not be changed unless extracting a small shared helper is clearly safer.
- `models.json` persistence remains full-file overwrite through existing Save; discovery route must not write to it.
- Rollback route/UI additions independently if validation fails.

## Review Gate Before Implementation

- User approves the PRD/design/implementation plan.
- `task.py start 07-06-provider-models-discovery` succeeds.
- Context manifests include relevant docs and source files.
