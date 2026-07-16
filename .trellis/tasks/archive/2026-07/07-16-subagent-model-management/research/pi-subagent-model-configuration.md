# Pi-Subagent Model Configuration Research

**Package**: `pi-subagents` v0.34.0
**Source**: `C:\Users\lichong\.pi\agent\npm\node_modules\pi-subagents\`
**Date**: 2025-07-16

---

## 1. Configuration Locations (Layered)

Pi-subagents uses a **multi-layered configuration system** with clear precedence. Each layer serves a different purpose:

| Layer | Location | Scope | Mutable | Purpose |
|-------|----------|-------|---------|---------|
| Builtin agents | `<package>/agents/*.md` | Global | No | Shipped agent definitions with frontmatter |
| Package agents | Discovered via `package.json` `pi.subagents.agents` | Read-only | No | Third-party package agents |
| User agents | `~/.pi/agent/agents/*.md` or `~/.agents/*.md` | User | Yes | User-defined custom agents |
| Project agents | `<project>/.pi/agents/*.md` or `<project>/.agents/*.md` | Project | Yes | Project-specific custom agents |
| User settings | `~/.pi/agent/settings.json` → `.subagents` | User | Yes | User-wide overrides (defaultModel, overrides, modelScope) |
| Project settings | `<project>/.pi/settings.json` → `.subagents` | Project | Yes | Project-wide overrides |
| Extension config | `~/.pi/agent/extensions/subagent/config.json` | User | Yes | Extension behavior (async, concurrency, budgets) |
| Runtime overrides | Tool-call `model` parameter | Per-invocation | Yes | Caller-supplied model at execution time |

---

## 2. Model Configuration Precedence

The **effective model** for a subagent is resolved in this order (highest to lowest priority):

1. **Runtime tool-call override** — `model` field in the `subagent()` tool call (e.g., `{ model: "anthropic/claude-sonnet-4" }`)
2. **Chain step override** — `model` field in a chain step config
3. **Parallel task override** — `model` field in a parallel task item
4. **Agent frontmatter** — `model:` in the agent's `.md` YAML frontmatter
5. **Settings `subagents.agentOverrides.<name>.model`** — per-agent override in settings.json
6. **Settings `subagents.defaultModel`** — global default for all agents without their own model
7. **Parent session model** — inherited from the spawning pi session (`provider/id`)

### Resolution Logic (`resolveSubagentModelOverride`)

```typescript
// From src/runs/shared/model-fallback.ts

// "inherit" sentinel → use parent session model
// undefined/false/empty → use parent session model
// explicit string → resolve against model registry (exact then fuzzy)

function resolveSubagentModelOverride(
  requestedModel: string | boolean | undefined,
  parentModel: ParentModel | undefined,  // { provider, id }
  availableModels: ModelInfo[] | undefined,
  preferredProvider?: string,
): string | undefined
```

**Key behavior**: When no explicit model is set, the subagent inherits the **parent session's in-memory model** (`provider/id`), NOT the global default from `~/.pi/agent/settings.json`. This prevents cross-session contamination.

---

## 3. Supported Model Syntax

| Syntax | Example | Behavior |
|--------|---------|----------|
| `provider/id` | `anthropic/claude-sonnet-4` | Exact match against registry |
| Bare `id` | `claude-sonnet-4` | Fuzzy-resolved; prefers `preferredProvider` (parent session) |
| `inherit` | `"inherit"` | Sentinel to explicitly inherit parent session model |
| Thinking suffix | `claude-sonnet-4:high` | Base model + thinking level suffix |
| `false` or empty | — | Clears the model, falls through to parent |

### Fuzzy Resolution

The resolver tolerates:
- **Case differences** (`Claude-Sonnet-4` matches `claude-sonnet-4`)
- **Separator variants** (dots, underscores treated as dashes)
- **Date stamps** (`claude-sonnet-4-20251001` matches `claude-sonnet-4`)
- **Provider prefixes** with alternate separators (`anthropic:claude-sonnet-4`)

A qualified `provider/id` query **never silently switches providers** — this is a security/cost-safety measure.

---

## 4. Built-in Agent Model Behavior

All 8 built-in agents ship with **thinking levels but NO explicit model**, meaning they inherit the parent session model by default:

| Agent | Thinking | Model | Default Context | System Prompt Mode |
|-------|----------|-------|-----------------|-------------------|
| `scout` | `low` | _(none)_ | — | `replace` |
| `worker` | `high` | _(none)_ | `fork` | `replace` |
| `planner` | `high` | _(none)_ | `fork` | `replace` |
| `reviewer` | `high` | _(none)_ | — | `replace` |
| `oracle` | `high` | _(none)_ | `fork` | `replace` |
| `delegate` | _(none)_ | _(none)_ | — | `append` |
| `context-builder` | `medium` | _(none)_ | — | `replace` |
| `researcher` | `medium` | _(none)_ | — | `replace` |

### Thinking Levels

Supported thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`

The `subagents.disableThinking: true` setting in settings.json strips thinking from all built-in agents (unless individually overridden).

---

## 5. Settings.json Schema for Subagent Overrides

The `subagents` key in `settings.json` (user or project scope) has this structure:

```json
{
  "subagents": {
    "defaultModel": "anthropic/claude-sonnet-4",
    "disableBuiltins": false,
    "disableThinking": false,
    "modelScope": {
      "enforce": true,
      "allow": ["anthropic/*", "openai/gpt-4*"]
    },
    "agentOverrides": {
      "scout": {
        "model": "anthropic/claude-haiku-3",
        "thinking": "low",
        "disabled": false,
        "systemPromptMode": "replace",
        "inheritProjectContext": true,
        "inheritSkills": false,
        "defaultContext": "fresh",
        "fallbackModels": ["openai/gpt-4o"],
        "skills": ["trellis-before-dev"],
        "tools": ["read", "bash"],
        "completionGuard": true,
        "toolBudget": { "soft": 20, "hard": 30, "block": ["write"] }
      }
    }
  }
}
```

### Override Field Behaviors

| Field | Type | Special |
|-------|------|---------|
| `model` | `string \| false` | `false` clears the model (inherit parent) |
| `fallbackModels` | `string[] \| false` | Tried in order on retryable failures |
| `thinking` | `string \| false` | `false` strips thinking |
| `disabled` | `boolean` | Hides agent from runtime discovery |
| `systemPromptMode` | `"append" \| "replace"` | How system prompt interacts with parent |
| `inheritProjectContext` | `boolean` | Whether AGENTS.md etc. are injected |
| `inheritSkills` | `boolean` | Whether parent skills are available |
| `defaultContext` | `"fresh" \| "fork" \| false` | Fork inherits parent conversation |
| `skills` | `string[] \| false` | Skills available to this agent |
| `tools` | `string[] \| false` | Tool allow-list |
| `completionGuard` | `boolean` | Wait for completion before parent continues |
| `toolBudget` | `object \| false` | Tool call budget enforcement |

---

## 6. Model Scope Enforcement

The `subagents.modelScope` config enables allow-list enforcement:

```json
{
  "subagents": {
    "modelScope": {
      "enforce": true,
      "allow": ["anthropic/*", "openai/gpt-4*"]
    }
  }
}
```

- **Glob patterns**: `*` matches any segment, case-insensitive
- **Explicit models** (tool-call `model`): Hard error if out of scope
- **Inherited models** (frontmatter, defaultModel, parent): Warning only (non-breaking)
- **Project scope wins**: Project `modelScope` overrides user `modelScope`

---

## 7. Fallback Models

Agents can specify `fallbackModels` (comma-separated in frontmatter, array in settings):

```yaml
---
name: my-agent
model: anthropic/claude-sonnet-4
fallbackModels: openai/gpt-4o, google/gemini-2-pro
---
```

### Fallback Trigger Conditions

Retries occur on retryable failures matching patterns like:
- Rate limits (429)
- Auth/API key errors
- Model/provider unavailable
- Timeouts, network errors
- 502/503/504 errors

Each attempt is tracked in `modelAttempts[]` with model, success, exit code, error, and usage.

---

## 8. Agent Discovery and Scope Merging

### Discovery Order (precedence: project > user > package > builtin)

```
builtin agents  →  package agents  →  user agents  →  project agents
     ↓                  ↓                 ↓                 ↓
  (lowest)                                              (highest)
```

Same-named agents in higher scopes **shadow** lower ones. Project agents always win over user agents.

### Agent Sources

| Source | Where | Discovery |
|--------|-------|-----------|
| `builtin` | Package `agents/` directory | Always loaded |
| `package` | npm packages with `pi.subagents.agents` in package.json | Via node_modules scan |
| `user` | `~/.pi/agent/agents/`, `~/.agents/`, `PI_SUBAGENT_EXTRA_AGENT_DIRS` | User-scope |
| `project` | `<project>/.pi/agents/`, `<project>/.agents/` | Project-scope |

### Runtime Name Resolution

- Simple agents: `name` frontmatter → runtime name is the same
- Package agents: `name` + `package` frontmatter → `packageName.name` (e.g., `pi-subagents.scout`)

---

## 9. Custom Agent Frontmatter Fields

Agent `.md` files use YAML frontmatter with these known fields:

```yaml
---
name: my-agent                # Required. Local name.
package: my-package           # Optional. Creates dotted runtime name.
description: "..."            # Required. Shown in { action: "list" }.
model: anthropic/claude-sonnet-4  # Optional. Model for this agent.
fallbackModels: "openai/gpt-4o, google/gemini-2-pro"
thinking: high                # Optional. Thinking level.
tools: "read, write, bash"    # Optional. Tool allow-list.
skills: "trellis-before-dev"  # Optional. Skills to load.
systemPromptMode: replace     # "replace" (default) or "append"
inheritProjectContext: false  # Whether AGENTS.md is injected
inheritSkills: false          # Whether parent skills are available
defaultContext: fork          # "fresh" or "fork"
output: result.md             # Default output file path
defaultReads: "context.md"    # Files to read before running
defaultProgress: true         # Enable progress.md tracking
maxSubagentDepth: 2           # Recursion limit
completionGuard: true         # Wait for completion
toolBudget: '{"soft":20,"hard":30}'  # JSON tool budget
memory:                       # Cross-session memory
  scope: project
  path: .trellis/memory.md
---
```

The body after `---` is the **system prompt**.

---

## 10. Extension Config (config.json)

The extension config at `~/.pi/agent/extensions/subagent/config.json` controls **behavior**, not model selection:

```json
{
  "asyncByDefault": false,
  "forceTopLevelAsync": false,
  "waitTool": { "enabled": true },
  "defaultSessionDir": "/path/to/sessions",
  "maxSubagentDepth": 2,
  "maxSubagentSpawnsPerSession": 40,
  "globalConcurrencyLimit": 20,
  "control": {
    "enabled": true,
    "needsAttentionAfterMs": 60000,
    "activeNoticeAfterMs": 240000
  },
  "turnBudget": { "maxTurns": 50, "graceTurns": 2 },
  "toolBudget": { "soft": 50, "hard": 100 },
  "parallel": { "maxTasks": 8, "concurrency": 4 },
  "chain": { "dynamicFanout": { "maxItems": 20 } },
  "scheduledRuns": { "enabled": false }
}
```

This file does NOT contain model configuration. Models are configured through agent frontmatter, settings.json, or runtime overrides.

---

## 11. Web UI Integration (pi-agnet-web)

The web UI has its **own subagent model management layer** in `pi-web.json` that sits **above** the pi-subagents native config:

### pi-web.json Subagent Model Schema

```json
{
  "trellis": {
    "subagents": {
      "enabled": true,
      "defaultPolicy": {
        "model": { "mode": "followMain" },
        "thinking": "inherit"
      },
      "router": {
        "enabled": false,
        "model": { "mode": "piDefault" },
        "thinking": "minimal",
        "fallbackOnError": { "modality": "text", "tier": "standard" }
      },
      "routes": {
        "text": {
          "simple":   { "model": { "mode": "followMain" }, "thinking": "inherit" },
          "standard": { "model": { "mode": "followMain" }, "thinking": "inherit" },
          "complex":  { "model": { "mode": "followMain" }, "thinking": "high" },
          "critical": { "model": { "mode": "followMain" }, "thinking": "xhigh" }
        },
        "multimodal": { ... }
      },
      "agents": {
        "trellis-implement": { "strategy": "default", "minimumTier": "complex" },
        "trellis-check":     { "strategy": "default", "minimumTier": "standard" },
        "trellis-research":  { "strategy": "default" }
      }
    }
  }
}
```

### Model Reference Modes (`PiWebSubagentModelMode`)

| Mode | Behavior |
|------|----------|
| `followMain` | Use the current session's model |
| `piDefault` | Use pi's global default model from settings.json |
| `specific` | Use explicit `{ provider, modelId }` |
| `unset` | No opinion; pi-subagents decides |

### Agent Strategies (`PiWebSubagentAgentStrategy`)

| Strategy | Behavior |
|----------|----------|
| `default` | Use the default policy |
| `route` | Use the router (modality × tier) to select model |
| `fixed` | Use a fixed `{ model, thinking }` policy |
| `disabled` | Agent is not used |

### Key Insight: Two Config Systems

The web UI's `pi-web.json` and pi-subagents' native `settings.json` are **separate systems**:
- **pi-web.json** → Web UI's routing/policy layer for Trellis workflow subagents
- **settings.json → subagents** → Native pi-subagents model config (defaultModel, agentOverrides, modelScope)

The web UI must **translate** its `PiWebSubagentModelRef` into the format pi-subagents expects (typically a `provider/id` string or the `"inherit"` sentinel).

---

## 12. Management API (Tool Actions)

The `subagent` tool supports management actions for CRUD on agents:

| Action | Description |
|--------|-------------|
| `list` | Show executable agents and chains |
| `get` | Show full agent/chain detail |
| `models` | Show effective model per builtin agent |
| `create` | Create a new custom agent or chain |
| `update` | Modify an existing agent or chain |
| `delete` | Remove a custom agent or chain |
| `eject` | Copy a builtin/package agent to user/project scope for customization |
| `disable` | Hide an agent from runtime discovery |
| `enable` | Restore a disabled agent |
| `reset` | Remove custom overrides, restore bundled default |

### Safe Read/Write Requirements for UI

**Read operations** (safe, no side effects):
- `list`, `get`, `models` — discover and display agents, models, configs
- Reading `~/.pi/agent/settings.json` → `.subagents` for current overrides
- Reading agent `.md` files for frontmatter inspection

**Write operations** (need confirmation/validation):
- `create`/`update`/`delete` — modify agent `.md` files
- `eject` — copies agent definition to writable scope
- `disable`/`enable`/`reset` — modify settings.json overrides
- Writing `settings.json` → `.subagents.defaultModel`
- Writing `settings.json` → `.subagents.agentOverrides.<name>`
- Writing `settings.json` → `.subagents.modelScope`

**Validation the web UI should perform**:
1. Model string validation against the model registry (warn if not found)
2. Fallback model validation (warn if not in registry)
3. Agent name uniqueness check in target scope
4. Scope disambiguation when same name exists in user and project
5. Thinking level validation against supported levels for the model

---

## 13. Key Source File Map

| File | Purpose |
|------|---------|
| `src/agents/agents.ts` | Agent discovery, loading, settings parsing, override application |
| `src/agents/agent-management.ts` | CRUD management actions |
| `src/agents/agent-serializer.ts` | Serialize agent config to `.md` frontmatter |
| `src/agents/frontmatter.ts` | Parse YAML frontmatter from `.md` files |
| `src/agents/identity.ts` | Runtime name building (`packageName.name`) |
| `src/agents/agent-selection.ts` | Scope merging logic |
| `src/runs/shared/model-fallback.ts` | Model resolution, fuzzy matching, fallback candidates |
| `src/runs/shared/model-scope.ts` | Model scope enforcement (allow patterns) |
| `src/shared/model-info.ts` | Model info types, thinking level resolution |
| `src/shared/types.ts` | All type definitions, extension config schema |
| `src/extension/config.ts` | Extension config.json loading/saving |
| `src/extension/schemas.ts` | Tool parameter schemas (TypeBox) |

---

## 14. Summary of Findings

### Authoritative Config Location
The **authoritative** source for subagent model configuration is:
1. **Agent frontmatter** (`.md` files) — per-agent model
2. **`settings.json` → `subagents`** — global defaultModel, per-agent overrides, modelScope
3. **Extension `config.json`** — behavior only, not models

### What the Web UI Should Expose
For a subagent model management UI, the minimum viable feature should support:
1. **View**: List all agents with their effective model and source
2. **Override**: Set `subagents.defaultModel` in user/project settings.json
3. **Per-agent**: Set `subagents.agentOverrides.<name>.model` and `.thinking`
4. **Scope toggle**: User vs project scope for overrides
5. **Model validation**: Warn when model is not in the registry
6. **Eject**: Copy builtin agents to user scope for full customization

### What the Web UI Should NOT Do
- Directly edit builtin agent `.md` files (they're in the npm package)
- Bypass the settings.json override mechanism
- Confuse pi-web.json routing policies with native pi-subagents config
- Forget that `false` is a valid value meaning "clear/unset"
