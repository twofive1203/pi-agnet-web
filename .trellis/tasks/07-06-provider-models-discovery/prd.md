# Import provider models from /models

## Goal

Let users configure an OpenAI-compatible custom provider, fetch that provider's advertised model list from its `/models` endpoint, select a returned model, and add it to the provider's configured models without manually typing the model id.

## User Value

Users of NewAPI, sub2api, and similar OpenAI-compatible proxy systems can add available models faster and with fewer typos. The feature should preserve the existing Models panel workflow where edits are staged locally and persisted only when the user clicks Save.

## Confirmed Facts

- The Models panel currently reads and writes `~/.pi/agent/models.json` through `/api/models-config`.
- `app/api/models-config/route.ts` writes the full JSON body with `PUT`; it does not merge partial updates.
- `app/api/models/route.ts` only projects already configured/available models from the model registry; it is not an editing endpoint.
- `app/api/models-config/test/route.ts` already demonstrates server-side handling for a draft provider/model config, including temporary `models.json`, `ModelRegistry`, `getApiKeyAndHeaders`, and timeout behavior.
- `components/ModelsConfig.tsx` owns custom provider editing, manual model addition, staged state, model selection, and the Save button.
- OpenAI-compatible model discovery commonly returns `{ object: "list", data: [{ id, object, created, owned_by, ... }] }` from `/v1/models` or from `/models` when the configured base URL already ends with `/v1`.

## Requirements

- Add model discovery for custom providers whose API is OpenAI-compatible:
  - `openai-completions`
  - `openai-responses`
- Provide a server-side discovery route so API keys and custom headers are not sent directly from the browser to arbitrary provider origins.
- Reuse the existing provider auth semantics where possible, including provider `headers` and supported `apiKey` forms (`ENV_VAR_NAME`, `!shell-command`, or literal key).
- Discover model lists using this URL candidate behavior:
  - If `baseUrl` ends in `/v1` or `/api/v1`, request `<baseUrl>/models`.
  - Otherwise try `<baseUrl>/v1/models` first, then `<baseUrl>/models`.
  - Preserve existing path prefixes and avoid duplicate slashes.
- Parse OpenAI-compatible responses primarily from `data[]`; each candidate must have a usable string model id.
- The UI must let the user fetch the remote list, search returned candidates, view them grouped by ownership/source, and add models to the current provider.
- Discovery results must show already-added models distinctly and provide a row-level remove action for staged provider models; not-yet-added models get a row-level add action.
- Adding a discovered model stages a minimal model entry in the current UI state: `{ id, name? }` only.
- Do not immediately write `models.json` after model selection; persist through the existing Save button.
- Prevent duplicate model ids under the same provider and show a clear message if the selected id already exists.
- Discovery failures must be non-destructive and show useful diagnostics without changing the draft config.
- Manual model entry must continue to work.

## Acceptance Criteria

- [ ] In the Models panel, a custom OpenAI-compatible provider can fetch a remote model list after `baseUrl` and `apiKey` are configured.
- [ ] NewAPI/sub2api-style OpenAI-compatible responses with `data[].id` are displayed as searchable model candidates grouped by returned ownership/source.
- [ ] Clicking a candidate's add button appends a minimal model entry to the provider's staged `models` array and keeps the discovery list open so the row changes to its added/remove state.
- [ ] Already-added candidate ids show a remove action instead of being added again; duplicate model ids are not created.
- [ ] Discovery honors the accepted URL candidate strategy for `/v1/models` and `/models`.
- [ ] Discovery uses server-side provider auth/header handling consistent with the model test route.
- [ ] Clicking Save persists the added model to `~/.pi/agent/models.json`; reloading `/api/models-config` shows the new model.
- [ ] `/api/models` includes the new model after the configuration has been saved and the registry refreshes.
- [ ] Bad base URLs, bad API keys, unsupported provider APIs, and invalid/non-JSON responses produce clear non-destructive errors.
- [ ] Existing manual `+ model`, provider edit, model edit, and model connection test flows still work.
- [ ] Documentation for model config API routes is updated if a route is added or the existing route-method mismatch is touched.
- [ ] Validation passes with `npm run lint` and `node_modules/.bin/tsc --noEmit`.

## Out of Scope

- Automatic import of all returned models at once.
- Replacing the existing model detail editor with a separate full-screen picker.
- Immediate persistence without the existing Save button.
- Mapping provider-specific metadata such as pricing, context length, modality, or token limits into local model fields.
- Supporting non-OpenAI-native shapes such as Ollama-style `models[]` unless they also expose OpenAI-compatible `data[]`.
- Testing that the selected model can complete chat requests beyond the existing manual model Test button.
- General support for arbitrary custom auth schemes beyond the provider config fields already supported by the model registry.

## Open Questions

None currently blocking planning. The user accepted the recommended scope and behavior above.
