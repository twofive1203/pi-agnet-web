# Web Integration Design: Native pi-subagents Model Manager

## 1. Executive Summary

This document defines the implementation architecture for a dedicated **native pi-subagents model manager** in Snail Pi Web. The feature configures the `subagents` section of Pi's native `settings.json` independently of the existing Trellis-only routing controls in `pi-web.json`.

**Key decisions:**

- **Direct filesystem I/O** against `settings.json` files (user-scope: `~/.pi/agent/settings.json`, project-scope: `<cwd>/.pi/settings.json`), with surgical preservation of unrelated keys.
- **Reuse the existing `/api/models` endpoint** for model selection and validation; no new model-discovery plumbing.
- **A new API route pair** (`/api/pi-settings`) for read/write, gated by the existing allowed-roots security layer.
- **A new Settings tab ("Agents")** outside the Trellis section, with an explicit scope selector (user vs. project).
- **Agent discovery via filesystem** scanning of well-known directories, matching `pi-subagents`' own discovery logic, with optional enrichment from the live extension's `list` action when available.

---

## 2. Background: Existing Patterns

### 2.1 SettingsConfig (pi-web.json)

The existing settings UI manages `~/.pi/agent/pi-web.json` through:

| Layer | File | Pattern |
|-------|------|---------|
| API | `app/api/web-config/route.ts` | `GET` reads, `PUT` writes with `writePiWebConfigPatch()` |
| Library | `lib/pi-web-config.ts` | Strict read-normalize + strict write-validate + merge |
| UI | `components/SettingsConfig.tsx` | Tab-based sections, dirty tracking, save/reset |

**Key patterns to replicate:**

1. **Read-normalize**: `readRawConfigFile()` → `normalizePiWebConfig()` returns defaults for missing/invalid fields.
2. **Write-validate**: `validate*()` functions throw `PiWebConfigValidationError` on bad input (HTTP 400).
3. **Merge-preserve**: `writePiWebConfigPatch()` reads the current raw JSON, validates only the patched section, then spreads `nextRaw = { ...raw, [section]: { ...prevSection, ...normalizedPatch } }` before writing.
4. **Parse-error surfacing**: Malformed JSON is reported via `parseError` field; the UI shows a warning but still displays defaults and allows overwrite on save.
5. **Per-section dirty tracking**: Each section has a `savedX` mirror; dirty = any section differs.

### 2.2 Models API

`app/api/models/route.ts` returns:

```typescript
{
  models: Record<string, string>;           // "provider:id" → displayName
  modelList: { id: string; name: string; provider: string }[];  // sorted
  defaultModel: { provider: string; modelId: string } | null;
  thinkingLevels: Record<string, string[]>;  // "provider:id" → ["off","low","medium","high"]
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
}
```

This endpoint already calls `createAgentSessionServices({ cwd, agentDir })` to access the live `ModelRegistry`. It is the single source of truth for "which models does Pi know about."

### 2.3 Allowed-Roots Security

Two parallel security layers exist:

| Module | Purpose |
|--------|---------|
| `lib/allowed-roots.ts` | General path-access control; roots from sessions, `~/pi-cwd-*`, registered cwds |
| `lib/file-access.ts` | File-specific access control; same root set, adds `allowFileRoot()` for dynamic roots |

Both use `isPathAllowed(target, allowedRoots)` which checks if `target` is under any allowed root (case-insensitive on Windows, slash-normalized).

**For pi-settings access**, the target files are:
- `~/.pi/agent/settings.json` — always accessible (agent dir is the process's own config)
- `<cwd>/.pi/settings.json` — must be under an allowed root (the session cwd)

### 2.4 Pi SDK APIs Available

From `@earendil-works/pi-coding-agent`:

| Export | Use |
|--------|-----|
| `getAgentDir()` | Returns `~/.pi/agent/` or `PI_CODING_AGENT_DIR` |
| `createAgentSessionServices({ cwd, agentDir })` | Returns `{ modelRegistry, settingsManager, ... }` |
| `SettingsManager.getDefaultProvider()` | Current default provider |
| `SettingsManager.getDefaultModel()` | Current default model id |
| `ModelRegistry.getAvailable()` | List of all configured models |
| `ModelRegistry.find(provider, modelId)` | Lookup a specific model |

---

## 3. Native pi-subagents Settings Shape

### 3.1 Settings File Locations

| Scope | Path | Precedence |
|-------|------|------------|
| User | `~/.pi/agent/settings.json` | Lower |
| Project | `<cwd>/.pi/settings.json` | Higher (overrides user) |

Both files are standard Pi settings files. The `subagents` key is a namespace within the broader settings object. Pi core also stores `defaultModel`, `defaultProvider`, `packages`, `skills`, etc. in the same file.

### 3.2 Subagents Settings Schema

Based on `pi-subagents/src/agents/agents.ts` (lines 543–1126), the native `subagents` object has this shape:

```typescript
interface NativeSubagentsSettings {
  // Global default model for all subagents without an explicit model
  defaultModel?: string;  // "provider/modelId" or bare "modelId"

  // Disable all builtin agents
  disableBuiltins?: boolean;

  // Clear bundled builtin thinking defaults globally
  disableThinking?: boolean;

  // Per-agent overrides (keyed by runtime agent name)
  agentOverrides?: Record<string, NativeAgentOverride>;

  // Model scope enforcement
  modelScope?: {
    enforce: boolean;
    allow: string[];  // glob patterns
  };
}

interface NativeAgentOverride {
  model?: string;           // "provider/modelId" or bare id
  fallbackModels?: string[];
  thinking?: string | false;
  systemPromptMode?: "replace" | "append";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  defaultContext?: "fresh" | "fork" | false;
  disabled?: boolean;
  systemPrompt?: string;
  skills?: string[] | false;
  tools?: string[] | false;
  // ... more fields exist but are out of MVP scope
}
```

### 3.3 Settings Read/Write Semantics in pi-subagents

The extension uses these functions (from `agents.ts`):

| Function | Behavior |
|----------|----------|
| `readSettingsFileStrict(path)` | Reads JSON; throws on missing file, invalid JSON, or non-object root |
| `writeSettingsFile(path, settings)` | `JSON.stringify(settings, null, 2) + "\n"` |
| `readSubagentOverrides(path)` | Reads `settings.subagents`, validates structure |
| `mergeBuiltinAgentOverride(cwd, name, scope, patch)` | Merges an override into `settings.subagents.agentOverrides[name]` |
| `removeBuiltinAgentOverride(cwd, name, scope)` | Deletes `settings.subagents.agentOverrides[name]` |
| `removeBuiltinAgentOverrideFields(cwd, name, scope, fields)` | Deletes specific fields from an override |

**Critical observation**: `readSettingsFileStrict` throws on missing files. The web API must handle this gracefully (missing file = empty settings).

### 3.4 Agent Discovery

`discoverAgentsAll(cwd)` returns:

```typescript
{
  builtin: AgentConfig[];     // ~/.pi/agent/extensions/subagent/agents/
  package: AgentConfig[];     // from installed Pi packages
  user: AgentConfig[];        // ~/.pi/agent/agents/**/*.md
  project: AgentConfig[];     // <cwd>/.pi/agents/**/*.md or .agents/**/*.md
  chains: ChainConfig[];
  chainDiagnostics: ...;
  userDir: string;
  projectDir: string | null;
  userChainDir: string;
  projectChainDir: string | null;
  projectSettingsPath: string | null;
}
```

Each `AgentConfig` includes: `name`, `source` (builtin|package|user|project), `filePath`, `model`, `thinking`, `fallbackModels`, `systemPrompt`, `disabled`, `override` info, etc.

---

## 4. Architecture: Three Approaches Compared

### 4.1 Approach A: Direct Filesystem Discovery + Direct Settings I/O

**How it works:**
- Read `settings.json` directly with `fs.readFileSync` + `JSON.parse`
- Discover agents by scanning well-known directories on the filesystem
- Write settings with surgical JSON merge

**Pros:**
- No dependency on a running Pi session or extension runtime
- Works even when pi-subagents is not installed
- Fast, deterministic, no IPC
- Full control over merge/preserve semantics
- Matches existing `pi-web-config.ts` patterns exactly

**Cons:**
- Must replicate agent discovery logic (directory scanning, frontmatter parsing)
- Cannot see runtime state (e.g., which agents are actually loaded, live model resolution)
- Frontmatter parsing requires importing or reimplementing YAML parsing

**Risk:** Medium. Agent discovery is straightforward directory scanning. Frontmatter parsing for the MVP only needs `name`, `model`, `thinking`, `description` — not full YAML.

### 4.2 Approach B: Invoke pi-subagents Management Tool

**How it works:**
- Spawn a Pi process or use the extension RPC bus to call `subagent({ action: "list" })` and `subagent({ action: "models" })`
- Use management actions for reads

**Pros:**
- Gets exact runtime state including overrides, disabled agents, model resolution
- No need to reimplement discovery logic

**Cons:**
- Requires a running Pi session (not always available in the web UI)
- Management actions are designed for AI agent consumption, not programmatic API use
- Spawning Pi processes is slow (seconds per call)
- The RPC bus (`subagents:rpc:v1:*`) requires an active extension context
- Write operations still need direct filesystem I/O (management actions write agent files, not settings)
- Tight coupling to pi-subagents internals

**Risk:** High. The management tool is not designed for external programmatic use. It would require significant adaptation.

### 4.3 Approach C: Import pi-subagents TypeScript Internals

**How it works:**
- Import `discoverAgentsAll`, `readSubagentOverrides`, etc. directly from `pi-subagents/src/`
- Use the extension's own functions for discovery and settings I/O

**Pros:**
- Exact same discovery and merge logic as the extension
- Gets full agent metadata without reimplementing frontmatter parsing

**Cons:**
- pi-subagents is a peer dependency, not a direct dependency of the web app
- The web app runs in Next.js (Node.js), but pi-subagents uses `node:fs`, `node:path` imports with `.ts` extensions (ESM with `--experimental-strip-types`)
- Importing would require `jiti` or similar runtime TypeScript loader
- Tight coupling to pi-subagents internal API surface (no stability guarantee)
- The web app's `package.json` does not declare pi-subagents as a dependency
- Breaking changes in pi-subagents would silently break the web UI

**Risk:** Very high. This violates the boundary between the web UI and the extension runtime.

### 4.4 Recommendation: Approach A (Direct Filesystem)

**Rationale:**
1. The web app already reads/writes `pi-web.json` and `models.json` directly. Adding `settings.json` follows the same pattern.
2. Agent discovery for the MVP only needs names, sources, and basic metadata — not full frontmatter parsing.
3. The settings write contract is simple: read-modify-write the `subagents` key, preserving everything else.
4. No runtime dependency on pi-subagents being installed or a Pi session being active.
5. The existing allowed-roots security layer already gates file access.

**Enhancement:** Optionally enrich the agent list with a "live" indicator when a Pi session is active and the `/api/pi/resources` endpoint can report loaded agents.

---

## 5. Detailed Design

### 5.1 New Library Module: `lib/pi-settings.ts`

This module handles reading and writing the native Pi `settings.json` `subagents` section.

```typescript
// lib/pi-settings.ts

export interface PiSettingsReadResult {
  settings: Record<string, unknown>;      // full settings object (for merge)
  subagents: NativeSubagentsSettings;     // parsed subagents section
  path: string;
  exists: boolean;
  parseError?: string;
}

export interface PiSettingsWriteResult {
  settings: Record<string, unknown>;
  subagents: NativeSubagentsSettings;
  path: string;
  exists: true;
}

// Scope resolution
export function getUserSettingsPath(): string;
export function getProjectSettingsPath(cwd: string): string | null;

// Read
export function readPiSettings(path: string): PiSettingsReadResult;

// Write (surgical merge of subagents section only)
export function writeSubagentsPatch(
  path: string,
  patch: Partial<NativeSubagentsSettings>,
  options: { clearFields?: string[] }
): PiSettingsWriteResult;
```

**Key design decisions:**

1. **Read contract:**
   - Missing file → `{ settings: {}, subagents: {}, exists: false }`
   - Malformed JSON → `{ settings: {}, subagents: {}, exists: true, parseError: "..." }`
   - Valid JSON without `subagents` → `{ subagents: {} }`
   - The full `settings` object is returned for merge-on-write

2. **Write contract:**
   - Always reads the current file first (or starts from `{}` if missing)
   - If `parseError` exists, refuse to write and return HTTP 409 Conflict
   - Validates only the `subagents` patch fields
   - Merges: `nextSettings = { ...currentSettings, subagents: { ...currentSubagents, ...patch } }`
   - For "clear" operations: deletes specific keys from the subagents object
   - Writes with `JSON.stringify(settings, null, 2) + "\n"`
   - Creates parent directories if needed

3. **Field-level clear semantics:**
   - Setting `defaultModel` to `null` or `undefined` in the patch → `delete subagents.defaultModel`
   - Setting `agentOverrides[name].model` to `null` → `delete agentOverrides[name].model`
   - Setting `agentOverrides[name]` to `null` → `delete agentOverrides[name]`
   - If `agentOverrides[name]` becomes empty after field deletions → `delete agentOverrides[name]`
   - If `agentOverrides` becomes empty → `delete subagents.agentOverrides`
   - If `subagents` becomes empty → `delete settings.subagents`

### 5.2 New Library Module: `lib/pi-agent-discovery.ts`

This module discovers available agents by scanning well-known directories.

```typescript
// lib/pi-agent-discovery.ts

export interface DiscoveredAgent {
  name: string;            // runtime name (e.g., "reviewer", "code-analysis.scout")
  source: "builtin" | "package" | "user" | "project";
  filePath: string;
  description: string;
  model?: string;          // from frontmatter
  thinking?: string;       // from frontmatter
  disabled?: boolean;      // from settings override
}

export interface AgentDiscoveryResult {
  agents: DiscoveredAgent[];
  builtinDir: string;
  userDir: string;
  projectDir: string | null;
  projectSettingsPath: string | null;
}

export function discoverAgents(cwd: string): AgentDiscoveryResult;
```

**Discovery logic (replicating pi-subagents' `discoverAgentsAll` at a simplified level):**

1. **Builtin agents**: Scan `~/.pi/agent/extensions/subagent/agents/*.md`
   - These are the pi-subagents bundled agents
   - Parse minimal frontmatter: `name`, `description`, `model`, `thinking`

2. **Package agents**: Scan installed Pi packages for `pi-subagents.agents` or `pi.subagents.agents` directories
   - Read `package.json` from each package under `~/.pi/agent/npm/node_modules/` and `~/.pi/agent/extensions/`
   - Look for the `pi.subagents.agents` or `pi-subagents.agents` key

3. **User agents**: Scan `~/.pi/agent/agents/**/*.md` recursively

4. **Project agents**: Scan `<cwd>/.pi/agents/**/*.md` and `<cwd>/.agents/**/*.md` recursively

**Frontmatter parsing**: Use a minimal regex-based parser for the YAML frontmatter block:

```typescript
function parseMinimalFrontmatter(content: string): {
  name?: string;
  description?: string;
  model?: string;
  thinking?: string;
  package?: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const yaml = match[1];
  // Simple key: value parsing for the fields we need
  // ...
}
```

This avoids importing a YAML parser. For the MVP, we only need `name`, `description`, `model`, `thinking`, and `package` fields.

### 5.3 New API Route: `app/api/pi-settings/route.ts`

```typescript
// GET /api/pi-settings?scope=user|project&cwd=...
// Returns: { settings, subagents, agents, path, exists, parseError, scope }

// PUT /api/pi-settings?scope=user|project&cwd=...
// Body: { patch: Partial<NativeSubagentsSettings>, clearFields?: string[] }
// Returns: { settings, subagents, path, exists, success }
```

**Security:**

1. **User scope** (`~/.pi/agent/settings.json`):
   - Always accessible. The agent dir is the process's own config directory.
   - No allowed-roots check needed (it's the server's own config).

2. **Project scope** (`<cwd>/.pi/settings.json`):
   - `cwd` must be provided and must be a valid directory.
   - `cwd` must pass `isPathAllowed(cwd, allowedRoots)` or be the current session cwd.
   - The resolved settings path must be under the allowed `cwd`.

**Validation:**

- `scope` must be `"user"` or `"project"`
- For `project` scope, `cwd` is required
- The `patch` is validated field-by-field before writing
- If the target file has a `parseError`, refuse to write (HTTP 409)

**Response shape:**

```typescript
interface PiSettingsResponse {
  // Current state
  subagents: {
    defaultModel?: string;
    disableBuiltins?: boolean;
    disableThinking?: boolean;
    agentOverrides?: Record<string, {
      model?: string;
      thinking?: string | false;
      fallbackModels?: string[];
      disabled?: boolean;
      // ... other override fields
    }>;
  };
  // Discovered agents (for the UI to show the agent list)
  agents: DiscoveredAgent[];
  // Metadata
  path: string;
  exists: boolean;
  scope: "user" | "project";
  parseError?: string;
  // Effective merge (for project scope: what the user scope provides)
  userSubagents?: NativeSubagentsSettings;  // only in project scope response
}
```

### 5.4 Frontend Component: `components/AgentsConfig.tsx`

A new settings section, rendered as a tab in the existing `SettingsConfig` modal.

**Layout:**

```
┌─────────────────────────────────────────────────────────┐
│  Scope: [User Global ▼]  │  ~/.pi/agent/settings.json  │
│                          │  (or project scope info)     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Default Subagent Model                                 │
│  ┌─────────────────────────────────────────────────┐    │
│  │ [model selector dropdown from /api/models]      │    │
│  │ Inherit from parent session  (default)           │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  Agent Overrides                                        │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Agent Name │ Model │ Thinking │ Fallback │ Actions│    │
│  │────────────│───────│──────────│──────────│───────│    │
│  │ scout      │ [sel] │ [sel]    │ [list]   │ [clr] │    │
│  │ reviewer   │ [sel] │ [sel]    │ [list]   │ [clr] │    │
│  │ worker     │ [sel] │ [sel]    │ [list]   │ [clr] │    │
│  │ oracle     │ [sel] │ [sel]    │ [list]   │ [clr] │    │
│  │ ...        │       │          │          │       │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  [Save]  [Reset to Inherited]                           │
│                                                         │
│  Status: ✓ Saved  │  Last saved: 2025-07-16 19:30      │
└─────────────────────────────────────────────────────────┘
```

**Key UI behaviors:**

1. **Scope selector**: Toggle between "User Global" and "Project" (only available when a cwd is selected). Show the target file path.

2. **Effective settings display**: For project scope, show a subtle indicator of what the user scope provides (inherited values).

3. **Model selector**: Reuse the existing `ModelPolicySelect` pattern from `SettingsConfig.tsx`, but with Pi-native model ids (`provider/modelId` strings) instead of the Trellis `PiWebSubagentModelRef` structure.

4. **Thinking selector**: Options from the model's `thinkingLevels` plus "inherit" (default) and "off".

5. **Fallback models**: An ordered list with add/remove/reorder controls. Each entry uses the same model selector.

6. **Clear/reset**: Each override field has a "clear" button that removes just that field from the override. If all fields of an agent override are cleared, the entire override is removed.

7. **Dirty tracking**: Track loaded vs. current state; enable Save button only when dirty.

8. **Error handling**: Show parse errors prominently; disable Save when the file is malformed.

### 5.5 Integration with SettingsConfig

Add a new section to the existing `SettingsConfig` component:

```typescript
type SettingsSection = "worktree" | "usage" | "terminal" | "chatgpt" | "editor" | "agents" | "trellis";
```

The "Agents" section sits between "Editor" and "Trellis" in the sidebar, making it clear that:
- It is a **native Pi setting** (not Trellis-specific)
- It is available **regardless of whether Trellis is enabled**

The `AgentsConfig` component is rendered inline within the settings modal, receiving `cwd` and the model list as props.

---

## 6. Settings Read-Write Contract

### 6.1 Read Contract

```
Input:  scope ("user" | "project"), cwd (required for project)
Output: { subagents, agents, path, exists, parseError }

Steps:
1. Resolve path:
   - user → getAgentDir() + "/settings.json"
   - project → cwd + "/.pi/settings.json" (or null if no .pi dir)

2. Read file:
   - Not exists → { subagents: {}, exists: false }
   - Exists, valid JSON, has subagents → { subagents: parsed, exists: true }
   - Exists, valid JSON, no subagents → { subagents: {}, exists: true }
   - Exists, invalid JSON → { subagents: {}, exists: true, parseError: "..." }

3. Discover agents (for the agent list):
   - Scan builtin, user, project directories
   - Parse minimal frontmatter for name, description, model, thinking

4. Return combined result
```

### 6.2 Write Contract

```
Input:  scope, cwd, patch (Partial<NativeSubagentsSettings>), clearFields
Output: { subagents, path, exists, success }

Steps:
1. Resolve path (same as read)

2. Read current file:
   - Not exists → start from {}
   - Exists, valid JSON → use as base
   - Exists, invalid JSON → REFUSE (HTTP 409 Conflict)

3. Apply patch:
   - For each key in patch:
     - If value is null/undefined → delete key from subagents
     - Otherwise → set key in subagents
   - For clearFields:
     - Parse dotted paths like "agentOverrides.review.model"
     - Delete the specified field
     - Clean up empty parent objects

4. Validate patch fields:
   - defaultModel: must be string or null
   - agentOverrides: must be Record<string, object> or null
   - Each override field: validate type
   - thinking: must be valid thinking level or false or null

5. Write:
   - Create parent directories if needed
   - JSON.stringify(settings, null, 2) + "\n"
   - writeFileSync

6. Return updated state
```

### 6.3 Clear/Reset Semantics

| Action | API Call | Effect on settings.json |
|--------|----------|------------------------|
| Clear default model | `clearFields: ["defaultModel"]` | `delete subagents.defaultModel` |
| Clear agent model | `clearFields: ["agentOverrides.review.model"]` | `delete subagents.agentOverrides.review.model` |
| Clear all agent overrides | `clearFields: ["agentOverrides.review"]` | `delete subagents.agentOverrides.review` |
| Clear all subagents | `patch: { defaultModel: null, agentOverrides: null }` | `delete settings.subagents` |

After any deletion, if a parent object becomes empty, it is also deleted. This prevents writing misleading empty objects like `"agentOverrides": {}`.

---

## 7. Security Considerations

### 7.1 Path Traversal

- User scope path is always `getAgentDir() + "/settings.json"` — no user input in the path.
- Project scope path is `cwd + "/.pi/settings.json"` where `cwd` is validated against allowed roots.
- No `..` or symlink traversal is possible because the path is constructed from known-safe components.

### 7.2 Allowed Roots

- User scope: No check needed (server's own config).
- Project scope: `cwd` must pass `isPathAllowed()` check. This ensures the web UI can only read/write settings in workspaces the user has already opened sessions in.

### 7.3 Malformed JSON Protection

- If `settings.json` contains invalid JSON, the API returns `parseError` and refuses to write.
- The UI shows a warning: "Settings file contains invalid JSON. Fix it manually or overwrite with valid settings."
- An explicit "overwrite" action can replace the file with a clean settings object.

### 7.4 Concurrent Access

- The read-modify-write cycle is not atomic. If another process (Pi CLI, another web tab) modifies `settings.json` between read and write, changes could be lost.
- **Mitigation**: The web UI reads immediately before writing, minimizing the window. This matches the existing `pi-web-config.ts` pattern which has the same limitation.
- **Future**: Could add file-lock or mtime-based optimistic concurrency control.

---

## 8. API Endpoint Specification

### 8.1 GET /api/pi-settings

**Query parameters:**
- `scope`: `"user"` | `"project"` (default: `"user"`)
- `cwd`: string (required when scope is `"project"`)

**Response (200):**
```json
{
  "subagents": {
    "defaultModel": "anthropic/claude-sonnet-4",
    "agentOverrides": {
      "reviewer": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high",
        "fallbackModels": ["openai/gpt-5-mini"]
      }
    }
  },
  "agents": [
    { "name": "scout", "source": "builtin", "filePath": "...", "description": "..." },
    { "name": "reviewer", "source": "builtin", "filePath": "...", "description": "..." }
  ],
  "path": "/home/user/.pi/agent/settings.json",
  "exists": true,
  "scope": "user",
  "userSubagents": null
}
```

**Response (400):**
```json
{ "error": "cwd is required for project scope" }
```

### 8.2 PUT /api/pi-settings

**Query parameters:** Same as GET.

**Request body:**
```json
{
  "patch": {
    "defaultModel": "anthropic/claude-sonnet-4"
  },
  "clearFields": []
}
```

Or for clearing:
```json
{
  "patch": {},
  "clearFields": ["agentOverrides.review.model"]
}
```

**Response (200):**
```json
{
  "success": true,
  "subagents": { ... },
  "path": "...",
  "exists": true
}
```

**Response (409):**
```json
{ "error": "Settings file contains invalid JSON: Unexpected token..." }
```

---

## 9. Frontend Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│  SettingsConfig (parent)                                     │
│  ├── Section tabs: WorkTree, Usage, Terminal, ChatGPT,      │
│  │   Editor, **Agents**, Trellis                             │
│  │                                                           │
│  └── AgentsConfig (new component)                            │
│      ├── scope: "user" | "project"                          │
│      ├── cwd: from parent                                    │
│      ├── modelList: from /api/models (shared with Trellis)   │
│      │                                                       │
│      ├── onLoad:                                             │
│      │   GET /api/pi-settings?scope=...&cwd=...              │
│      │   → populate form state                               │
│      │                                                       │
│      ├── onSave:                                             │
│      │   PUT /api/pi-settings?scope=...&cwd=...              │
│      │   body: { patch, clearFields }                        │
│      │   → update saved state                                │
│      │                                                       │
│      └── onClear(field):                                     │
│          PUT /api/pi-settings?scope=...&cwd=...              │
│          body: { patch: {}, clearFields: [field] }           │
└──────────────────────────────────────────────────────────────┘
```

---

## 10. Agent Discovery: Simplified Frontmatter Parser

For the MVP, the agent list only needs to display:
- Agent name (for the override key)
- Source (builtin/package/user/project)
- Description (for the UI label)
- Current model/thinking (to show inherited values)

A minimal frontmatter parser:

```typescript
function parseMinimalFrontmatter(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key && value) result[key] = value;
  }
  return result;
}
```

This handles the simple `key: value` lines that cover `name`, `description`, `model`, `thinking`, and `package`. It does not handle multi-line YAML, arrays, or nested objects — which is fine for the MVP display.

---

## 11. Model Validation Strategy

When the user selects a model for an override:

1. **At selection time**: The model selector dropdown is populated from `/api/models`, so only known models can be selected.
2. **At save time**: The API validates that the model id exists in the current model registry (using `ModelRegistry.find()`). If not, it returns a warning (not an error, since the model might be valid in a different Pi configuration).
3. **Fuzzy matching**: The API does NOT fuzzy-match model ids. It stores the exact `provider/modelId` string. pi-subagents handles fuzzy matching at runtime.

---

## 12. File Manifest

| File | Type | Purpose |
|------|------|---------|
| `lib/pi-settings.ts` | New library | Read/write native Pi settings.json subagents section |
| `lib/pi-agent-discovery.ts` | New library | Discover agents from filesystem |
| `app/api/pi-settings/route.ts` | New API route | GET/PUT pi-settings endpoint |
| `components/AgentsConfig.tsx` | New component | Agents settings tab UI |
| `components/SettingsConfig.tsx` | Modified | Add "Agents" section tab, render AgentsConfig |

---

## 13. Implementation Order

1. **`lib/pi-settings.ts`** — Settings read/write with full test coverage
2. **`lib/pi-agent-discovery.ts`** — Agent discovery
3. **`app/api/pi-settings/route.ts`** — API endpoint
4. **`components/AgentsConfig.tsx`** — UI component
5. **`components/SettingsConfig.tsx`** — Integration
6. **Default port change** — Separate, straightforward find-and-replace

---

## 14. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| pi-subagents changes settings schema | Low | Medium | Read-only fields are passed through; only validated fields are checked |
| Agent frontmatter format changes | Low | Low | Minimal parser only reads simple key:value; unknown fields are ignored |
| Concurrent settings modification | Low | Low | Read-before-write minimizes window; matches existing patterns |
| Project .pi directory doesn't exist | Medium | Low | API returns `exists: false`; UI offers to create on save |
| Settings file has unrelated keys | High | None | Surgical merge preserves all non-subagents keys |
| User has no Pi models configured | Medium | Low | Model selector shows empty state; user can still type model ids |

---

## 15. Testing Strategy

### Unit Tests

- `lib/pi-settings.ts`: Read/write with various JSON shapes, malformed input, missing files, clear semantics
- `lib/pi-agent-discovery.ts`: Directory scanning with mock filesystem

### Integration Tests

- API route: GET/PUT with various scopes, cwd validation, parse error handling
- End-to-end: Save a model override, verify it appears in settings.json, verify unrelated keys are preserved

### Manual Testing Checklist

- [ ] User scope: set/clear default model
- [ ] User scope: set/clear per-agent model override
- [ ] User scope: set/clear per-agent thinking override
- [ ] User scope: set/clear per-agent fallback models
- [ ] Project scope: same operations
- [ ] Project scope: verify user scope values shown as inherited
- [ ] Malformed settings.json: verify error display and write refusal
- [ ] Missing .pi directory: verify create-on-save behavior
- [ ] Unrelated settings keys: verify preservation after save
- [ ] Trellis settings: verify unchanged after agents settings save
