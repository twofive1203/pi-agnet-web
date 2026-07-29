# MCP configuration conventions

## Ownership and runtime boundary

- `pi-mcp-adapter` native configuration files are the sole source of truth. Snail Pi Web may edit and diagnose them but must not mirror MCP data into `pi-web.json` or implement a second MCP runtime.
- Configuration reads must remain side-effect free: do not import/load the adapter, connect servers, start subprocesses, execute `!command` resolvers, or trigger OAuth.
- Saving configuration does not restart AgentSessions. Return/display reload guidance; new sessions load normally through the existing `DefaultResourceLoader` path.
- Scheduled Automation does not automatically inherit interactive MCP configuration or tools; any future support requires its own extension allowlist and network-policy design.

## Safe configuration editing

- Expose only fixed target identifiers resolved server-side. Never accept an arbitrary configuration path from the browser; project targets must pass canonical workspace authorization.
- Treat JSONC as user-authored source. Supported edits must preserve comments and unknown on-disk fields through field-level AST changes rather than whole-object stringify/replace.
- Hash original file bytes for revision checks, reject stale revisions and malformed files, and write atomically with a same-directory temporary file plus rename.
- Browser projections must redact explicit secret-bearing values (`env.*`, `headers.*`, bearer tokens, OAuth client secrets). Secret mutations use explicit preserve/replace/clear semantics; unrelated edits preserve existing secret bytes.
- Mutation payloads are a bounded protocol. Reject unknown operation discriminators, unknown operation keys, and unknown nested mutation fields with stable field paths. Use own-key-safe discriminator lookup and never echo supplied values in validation errors.
- Preserve unknown fields already on disk for forward compatibility even though unknown mutation payload fields are rejected.

## API and UI diagnostics

- Keep package-configured, configuration-present, and current-session-connected states distinct. Package metadata discovery must not execute package code, and configuration presence must never be labeled as a live connection.
- Parse, authorization, validation, and revision conflicts should have stable browser-safe error codes without request or secret values.
- Settings panels for non-`pi-web.json` stores own independent load/save/dirty/conflict state. Conflict reapply must submit the newly loaded revision, not a stale React closure value.
