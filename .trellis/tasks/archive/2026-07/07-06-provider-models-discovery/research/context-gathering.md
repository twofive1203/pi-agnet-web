# Context Gathering: Provider /models Import

## Local scout findings

- `app/api/models/route.ts` reads the model registry and returns already configured available models. It is not an editing or remote-discovery endpoint.
- `app/api/models-config/route.ts` reads/writes `~/.pi/agent/models.json`. Source supports `GET` and `PUT`; docs currently list `GET/POST`.
- `app/api/models-config/test/route.ts` is the closest server-side pattern for validating draft provider/model configs. It writes a temporary `models.json`, creates a `ModelRegistry`, resolves auth with `getApiKeyAndHeaders`, and performs a timeout-bounded model request.
- `components/ModelsConfig.tsx` owns the model config modal, including draft provider/model state, manual `+ model`, model selection, and Save behavior.
- Relevant local types in `components/ModelsConfig.tsx`:
  - `ProviderEntry`: `baseUrl`, `api`, `apiKey`, `headers`, `compat`, `models`, `modelOverrides`.
  - `ModelEntry`: `id`, `name`, `api`, `reasoning`, `thinkingLevelMap`, `input`, `contextWindow`, `maxTokens`, `cost`, `compat`.

## External model endpoint findings

- OpenAI-compatible model discovery usually uses `GET /v1/models` and returns `{ object: "list", data: Model[] }`.
- NewAPI documents an OpenAI-compatible model endpoint at `/v1/models` with Bearer-token auth and OpenAI-style list shape.
- Proxy systems may return aliases rather than upstream canonical model ids; the returned `id` is still the correct value to import for that proxy.
- Base URL conventions vary: a configured base may already include `/v1`, while docs may show a server root plus `/v1/models`.
- Extra fields such as `owned_by`, `name`, `description`, `context_length`, `pricing`, and provider-specific metadata should be treated as optional.

## Accepted decisions from user

- Create a Trellis task and plan before implementation.
- Scope to OpenAI-compatible provider APIs.
- Use URL candidate strategy: `<base>/models` when base already ends in `/v1` or `/api/v1`; otherwise try `<base>/v1/models`, then `<base>/models`.
- Add selected model to UI draft only; persist through existing Save button.
- Block duplicate model ids.
- Import minimal `{ id, name? }` only.
- Use existing provider headers and apiKey semantics consistently with the test route.

## Source artifact pointers

- Researcher artifact: `.pi-subagents/artifacts/outputs/a770ef3a/research.md`
- Scout synthesis artifact: `.pi-subagents/artifacts/23528218_scout_0_output.md`
