# Add subagent model management and update default port

## Goal

Add a dedicated Pi subagent model-management experience that configures the native `pi-subagents` settings independently of the existing Trellis-only routing controls, and change Snail Pi Web's default listening port from `30141` to `62666`.

## Confirmed Facts

- Pi core does not provide built-in subagents; this project loads the third-party `pi-subagents` Pi package/extension.
- Native persistent model configuration belongs in Pi `settings.json` under `subagents`, not in `pi-web.json`:
  - user scope: `~/.pi/agent/settings.json`
  - project scope: `<cwd>/.pi/settings.json`
- Native model precedence is per-run override, agent/frontmatter model, `subagents.agentOverrides.<name>.model`, `subagents.defaultModel`, then parent/default inheritance according to the installed extension's resolver.
- The installed `pi-subagents` package supports a global subagent model, per-agent `model`, `thinking`, and `fallbackModels` overrides, model-scope controls, and broader agent-definition management actions.
- The existing Settings → Trellis section only edits Web UI routing policy in `pi-web.json → trellis.subagents`; it is not the native `pi-subagents` configuration.
- Available Pi models are already exposed by `/api/models` and can be reused for selectors and validation.
- Current default port references exist in npm scripts, the published `spi` launcher, AGENTS/README/deployment/troubleshooting documentation, and examples.

## Requirements

### Native Agent Model Management

- Add a dedicated settings section outside the Trellis section so native agent model settings are available even when Trellis is disabled or absent.
- Clearly distinguish native Pi subagent settings from Trellis workflow routing settings.
- Read and write only the `subagents` section of the selected Pi settings file while preserving every unrelated Pi setting.
- Display the extension-discovered executable Agent list and enough source information to distinguish built-in/package/user/project agents where available; also retain settings-only override names so stale or hidden entries can be cleared.
- Show selected-scope and inherited user values without mislabeling them as the final runtime model, because per-run parameters and Agent frontmatter may take precedence.
- Reuse Pi's available model registry for model choices and model validation.
- Support inheriting/clearing a model override without writing misleading placeholder model ids.
- Surface malformed/unreadable settings safely; do not silently overwrite malformed JSON.
- Saving must provide clear success/error feedback and must not modify bundled package agent files.

### Default Port

- Change the default development, production, and published CLI listening port to `62666`.
- Preserve `--port`, `-p`, and `PORT` overrides.
- Update current product/deployment/operations documentation and maintained examples that describe the default port.
- Do not rewrite historical archived Trellis task artifacts or unrelated generated subagent artifacts.

## Acceptance Criteria

- [ ] Settings contains an Agent/Subagent model-management entry independent of Trellis.
- [ ] The page supports both user-global and selected-project scopes and loads native `pi-subagents` configuration plus discovered agents for the chosen workspace.
- [ ] A user can set or clear the default subagent model.
- [ ] A user can set or clear per-agent model overrides using models available to Pi.
- [ ] A user can set or clear per-agent thinking overrides and ordered fallback models using values/models supported by Pi.
- [ ] Saving preserves unrelated fields in the target `settings.json` and rejects malformed input/config safely.
- [ ] Existing Trellis model-routing configuration continues to work unchanged and remains clearly labeled as Trellis-specific.
- [ ] `npm run dev`, `npm run start`, and `spi` default to port `62666`; explicit port overrides still win.
- [ ] Relevant API/frontend/integration/deployment documentation is updated.
- [ ] `npm run lint` passes.
- [ ] `node_modules/.bin/tsc --noEmit` passes.

## Out of Scope Unless Explicitly Chosen

- Editing bundled/package agent Markdown files directly.
- Building a general-purpose agent prompt/tool/skill editor.
- Managing chains, async/concurrency budgets, worktrees, or extension `config.json` behavior.
- Changing historical archived task documents or generated `.pi-subagents/` artifacts.

## Confirmed Scope Decision

- Support both user-global and selected-project settings. The UI must make the active scope and target file explicit, and explain that project settings take precedence over user settings.

## Confirmed MVP Controls

- Default subagent model.
- Per-agent primary model override.
- Per-agent thinking override.
- Ordered per-agent fallback model list.
- Clear/reset semantics that remove the selected-scope field and restore normal inheritance.
- Agent prompt, tools, skills, enable/disable controls, chains, and extension runtime budgets remain out of scope.
