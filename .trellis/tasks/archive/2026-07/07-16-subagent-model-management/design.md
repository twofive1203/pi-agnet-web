# Design: Native Pi Subagent Model Management and Port 62666

## 1. Scope and Boundaries

This task adds a native `pi-subagents` model manager to Settings and changes Snail Pi Web's default port.

The two subagent configuration systems remain intentionally separate:

- **Native Pi subagents**: Pi `settings.json → subagents`; applies to `pi-subagents` regardless of Trellis.
- **Trellis workflow routing**: `pi-web.json → trellis.subagents`; remains in Settings → Trellis and continues to control Web UI/Trellis routing policy only.

The native manager edits only these MVP fields:

- `subagents.defaultModel`
- `subagents.agentOverrides.<runtimeName>.model`
- `subagents.agentOverrides.<runtimeName>.thinking`
- `subagents.agentOverrides.<runtimeName>.fallbackModels`

It does not edit Agent Markdown/frontmatter, prompts, tools, skills, enable/disable flags, chains, model-scope policy, or extension runtime config.

## 2. Runtime Configuration Semantics

### 2.1 Scope

The UI supports:

- `user`: `<getAgentDir()>/settings.json`
- `project`: `<selected cwd>/.pi/settings.json`

Project scope is unavailable until a workspace is selected. The page shows the exact target file and explains that project values take precedence over user values. Project reads also include the corresponding user-scope managed projection so the UI can label inherited values.

### 2.2 Clear and Inherit

The form never writes placeholder model ids or an `"inherit"` model sentinel.

- Clearing `defaultModel` deletes that property.
- Clearing an Agent model/thinking/fallback override deletes that field.
- Empty override objects are removed only when they contain no unmanaged fields.
- Empty `agentOverrides` and `subagents` objects are cleaned up when truly empty.

For thinking, the explicit values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`; the UI's “inherit” choice deletes the selected-scope field. Existing `false` values are readable and can be cleared/replaced, but the MVP does not newly write `false` because the product-level clear action means “remove this override and restore precedence.”

## 3. Server-Side Library Contract

Add `lib/pi-subagent-settings.ts` as the single owner of native subagent settings I/O and wire types.

### 3.1 Read Projection

A strict read returns:

```ts
interface PiSubagentSettingsFileResult {
  path: string;
  exists: boolean;
  revision: string;
  managed: {
    defaultModel?: string;
    agentOverrides: Record<string, {
      model?: string | false;
      thinking?: string | false;
      fallbackModels?: string[] | false;
    }>;
  };
  parseError?: string;
  validationError?: string;
}
```

Rules:

- Missing file is a valid empty configuration.
- Malformed JSON, a non-object root, malformed `subagents`, malformed `agentOverrides`, or malformed managed fields is surfaced explicitly.
- Unknown Pi settings, unknown `subagents` fields, and unknown per-Agent override fields are retained in the raw document and omitted from the browser projection.
- Reads never normalize malformed content into writable defaults.

### 3.2 Patch Contract

`PUT /api/subagents/config` accepts an explicit managed-field patch plus the revision returned by GET:

```ts
interface PiSubagentSettingsPatch {
  expectedRevision: string;
  defaultModel?: string | null;
  agentOverrides?: Record<string, {
    model?: string | null;
    thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
    fallbackModels?: string[] | null;
  }>;
}
```

Only present fields are modified. `null` deletes a field. This prevents stale form state from replacing unrelated settings or unmanaged subagent fields.

Before writing, the server:

1. Re-reads the target file strictly.
2. Rejects malformed/unreadable content.
3. Rejects a revision mismatch with HTTP 409 so concurrent Pi/other-tab edits are not lost.
4. Validates Agent runtime names and all patch types.
5. Validates primary/default/fallback model ids against Pi's available registry for the selected cwd. Model values are stored as exact `provider/id` strings from the registry.
6. Rejects duplicate fallback models and other invalid lists.
7. Merges only managed fields into the latest raw object.
8. Writes formatted JSON with a trailing newline through a same-directory temporary file and rename.

The returned response is a fresh read projection with a new revision.

## 4. Agent Discovery

Add `lib/pi-subagent-discovery.ts`.

Do not import the third-party package's private TypeScript modules and do not duplicate its package/directory discovery algorithm. Instead, use the installed extension's public management tool surface:

1. Create a lightweight in-memory Pi SDK session for the selected cwd.
2. Locate the registered `subagent` AgentTool.
3. Execute `{ action: "list", agentScope: "both" }` without prompting a model or launching a child.
4. Parse the stable executable-agent lines into `{ name, source, description, defaultContext? }`.
5. Dispose the temporary session in `finally`.

If the extension/tool is missing or its output cannot be parsed, return a browser-safe diagnostic instead of failing settings-file access. Merge configured override names from user/project settings into the display list as “settings-only” entries so hidden, disabled, removed, or stale configured names remain visible and clearable.

This discovery path reports the extension's effective source precedence (`builtin`, `package`, `user`, `project`) without editing bundled files. The UI must not claim that selected-scope settings are the final runtime model: per-run parameters and Agent frontmatter can still take precedence.

## 5. API Route

Add `app/api/subagents/config/route.ts` with Node runtime and force-dynamic behavior.

### GET

`GET /api/subagents/config?scope=user|project&cwd=<workspace>` returns:

- selected-scope managed settings and metadata
- user-scope managed settings when project scope is selected
- discovered Agent list and discovery diagnostics
- extension availability

User scope can load without a selected cwd, using the server cwd only for best-effort discovery. Project scope requires `cwd`.

### PUT

`PUT /api/subagents/config?scope=user|project&cwd=<workspace>` applies the managed patch and returns the refreshed selected-scope projection.

### Security

- User scope always resolves from `getAgentDir()` and accepts no caller-controlled path.
- Project scope canonicalizes and validates `cwd` against `getAllowedRoots()`/`isPathAllowed()`.
- The project target is constructed as `<canonical cwd>/.pi/settings.json`; no raw target path is accepted.
- Symlink/realpath checks ensure an existing `.pi` directory or settings file cannot escape the authorized workspace.
- Browser responses expose the intended settings target and Agent source labels but do not expose bundled Agent file contents.

### Error Statuses

- 400: invalid scope/body/model/thinking/Agent name
- 403: unauthorized project cwd or symlink escape
- 409: revision conflict or malformed target settings that must be fixed manually
- 500: unexpected I/O/SDK failure

## 6. Frontend

Add `components/AgentsConfig.tsx` and mount it as a dedicated `agents` section in `SettingsConfig.tsx`, immediately before Trellis.

The component owns its own load/save/dirty/error state because it persists to Pi `settings.json`, not the modal's existing `pi-web.json` save path.

### UI Elements

- Scope selector: “用户全局” / “当前项目”
- Exact target path and precedence explanation
- Native-vs-Trellis explanatory banner
- Default subagent model selector with “继承/不指定”
- Discovered Agent rows with source badge and description
- Per-Agent primary model selector
- Per-Agent thinking selector
- Ordered fallback-model editor with add/remove/move controls
- Field-level clear/inherit behavior
- Save/reload controls and dirty state
- Clear malformed/config-conflict errors without destructive overwrite
- Empty/missing-extension and no-model states

Model choices come from `/api/models?cwd=...`; existing unavailable ids are shown as existing configuration with a warning and can be preserved or cleared, but newly submitted model values must be registry-backed.

The Trellis section remains behaviorally unchanged, but its copy is tightened to label its controls as Trellis workflow routing rather than native Pi subagent settings.

## 7. Default Port

Change defaults from `30141` to `62666` in:

- `package.json` development and production scripts
- `bin/pi-web.js` fallback after CLI and `PORT`
- current AGENTS/README/deployment/operations documentation

Precedence remains:

```text
spi --port / -p > PORT > 62666
```

Next CLI arguments and environment behavior are otherwise unchanged.

Do not modify historical Trellis archives or `.pi-subagents` generated artifacts.

## 8. Documentation

Update:

- `docs/modules/api.md` for the new route
- `docs/modules/frontend.md` for `AgentsConfig`
- `docs/modules/library.md` for settings/discovery helpers
- `docs/integrations/README.md` for native `pi-subagents` settings and its distinction from Trellis routing
- `docs/architecture/overview.md` for the configuration boundary
- `docs/deployment/README.md`, `docs/operations/troubleshooting.md`, `README.md`, `README.zh-CN.md`, and `AGENTS.md` for port/config behavior

## 9. Compatibility and Rollback

- Existing `settings.json` content is preserved except for fields explicitly changed by the native manager.
- Existing `pi-web.json → trellis.subagents` is untouched.
- Existing live Pi sessions may need reload/restart before an extension sees on-disk settings changes; the UI will state that persistence is immediate but runtime reload follows Pi's normal lifecycle.
- Rollback is removal of the new route/component/helpers and restoration of port constants/docs. User settings written through the feature remain valid native Pi configuration and do not require migration.
