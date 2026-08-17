# Desktop Pet Quick Sessions

- **Status:** Accepted (U1–U6 implemented; real Windows DPI/IME/installer/signing matrix remains **未执行**)
- **Date:** 2026-08-17
- **Scope:** User-initiated first-message Agent session start from the existing Activity tray
- **Requirements:** `docs/brainstorms/2026-08-17-desktop-pet-quick-session-requirements.md`
- **Implementation plan:** `docs/plans/2026-08-17-001-feat-desktop-pet-quick-sessions-plan.md`
- **Related:** `desktop-pet-task-observer.md` (narrows the “WebUI is the only start surface” conclusion; does not reverse attach-only, pet-only packaging, or observer privacy)

## Decision Summary

The desktop pet may start one real Agent session from a compact in-tray composer: choose a server-known project, type the first text message, and submit. After success, the existing observer shows Running / Needs input / Ready / Blocked, and full conversation still happens in WebUI through the allowlisted `/?session=<id>` deep link.

This is a **narrow write surface**, not a second Chat client and not an observer-token upgrade:

- observer tokens stay read-only;
- a separate scoped `desktop-control` token lives only in Electron main;
- renderer never receives raw cwd, access keys, control/observer tokens, or historical Prompt;
- the first release sends only the first text message with WebUI default model/thinking/tool semantics.

## What this narrows

`desktop-pet-task-observer.md` treated WebUI as the only start surface. That remains true for continuous chat, model/tool configuration, attachments, and follow-ups. Quick session only adds a user-gesture path that creates a session and dispatches the first Prompt.

Unchanged observer ADR constraints:

- attach-only: the pet never starts, stops, restarts, or supervises `spi`;
- pet-only packaging: no Next/pi SDK/server runtime in the Electron package;
- observer snapshot/SSE stay read-only and must not carry cwd/Prompt;
- quitting the pet does not stop the created session.

## Architecture

```text
Pet renderer
  → narrow preload (list/create only)
  → Electron main (control token + access key)
  → /api/desktop-control/**
  → shared new-session starter
  → AgentSession registry
  → existing observer hub / Activity tray
  → optional allowlisted WebUI deep link
```

### Control access

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/desktop-control/session` | POST | Mint a 5-minute hashed control token with `quick_session` scope. |
| `/api/desktop-control/projects` | GET | Bounded path-free project catalog. |
| `/api/desktop-control/quick-sessions` | POST | Create one session and dispatch the first Prompt. |

Gate: proven IPv4 loopback + Host `127.0.0.1` + Origin exact/absent + server-mode access key at mint. Proxy may skip browser cookie/HTTPS only for proven loopback; routes still enforce their own Host/remote/token checks. Control namespace is never public.

Observer and control tokens are stored in separate hashed maps and rejected across namespaces.

### Compatibility

`GET /api/desktop-observer/protocol` adds an optional `capabilities: ["quick_session"]` field. Protocol version stays `1`.

- new desktop + old server: observer still attaches; composer entry stays hidden;
- old desktop + new server: extra field is ignored;
- server may ship first; desktop hides the feature until the capability is present.

### Project catalog

Project identity reuses `buildProjectKeyFromCwd()`. Public items contain only `projectRef`, basename `displayName`, collision-safe short disambiguator, recency, archived/worktree flags, and truncation metadata. Submit rebuilds the catalog and requires a unique existing canonical cwd. Collisions, deleted directories, unknown refs, and truncated refs fail closed.

### Session start

Browser `/api/agent/new` and desktop create share `lib/new-agent-session.ts`. Desktop always uses configured default model or the first available model, default thinking, and `all` tools. Empty model list returns `model_unavailable` before session creation.

Idempotency is process/instance scoped: same `requestId` + body hash shares one in-flight/terminal outcome for 10 minutes. Different hash with the same id is a conflict. Pure precheck failures do not occupy the registry. Instance change invalidates tokens and forbids automatic replay.

Success means “session created and Prompt dispatched”. Async provider failure continues through the existing observer outcome.

## Privacy

| Location | May hold first message? |
| --- | --- |
| Composer (renderer memory) | Yes, until cancel/success |
| Electron main request | Transiently, while forwarding |
| Control token / settings / logs / notifications / observer snapshot / project cache | No |
| Created Pi session JSONL | Yes (normal session record) |

Renderer-bound payloads are asserted free of cwd, Prompt, token, access key, and firstMessage.

## Consequences

Users can start a task from the pet without opening the browser first. Developers must keep observer and control tokens separate, and release server/desktop independently with additive capability negotiation. Real Windows DPI/IME/multi-monitor/installer/signing checks remain a manual matrix and must not be claimed from smoke output.
