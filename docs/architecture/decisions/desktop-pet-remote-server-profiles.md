# Desktop pet remote server profiles

Status: accepted
Date: 2026-08-21

## Context

Tauri Preview originally attached to a single loopback origin (`http://127.0.0.1:<port>`) with one DPAPI Access Key. The v1 observer and quick-session ADRs treated loopback-only as a hard security boundary. Users now need to save several Snail Pi Web servers and switch among them, including LAN/HTTPS hosts.

## Decision

- Tauri Preview stores a bounded, versioned profile list in `tauri-preview-server-profiles.json`. Each profile has a stable id, display name, normalized origin, explicit insecure-HTTP flag, and an independent DPAPI ciphertext. Plaintext keys never enter settings, WebView, logs, or fixtures.
- Only one profile is active. Switching increments a generation, drops Observer/Control tokens, snapshot, Quick Session catalog/request state, and notification baseline before connecting to the new origin. Late SSE from the old generation is ignored.
- Remote attach is server-mode only. Proxy skips browser cookies for the desktop namespace after a transport gate; route handlers still require Access Key mint plus short-lived namespace tokens. `authBypassCidrs` never skip mint.
- HTTPS is the default remote path. Remote HTTP requires both the profile `allowInsecureHttp` flag and server `--allow-insecure-http`. Certificate/hostname verification is never disabled.
- Electron stays loopback-only. Shared renderer shows the server card only when the Tauri optional bridge methods exist.

## Consequences

- Historical loopback-only ADRs remain true for Electron and for local-mode servers. This decision conditionally relaxes the Tauri remote path only.
- Direct IP HTTPS needs a certificate SAN for that IP and a Windows-trusted chain.
- Tokens behind a trusted reverse proxy bind to effective origin + proxy hop, not `X-Forwarded-For`.
- Follow-ups (multi-server aggregation, Electron remote profiles, custom CA files) stay out of scope.
