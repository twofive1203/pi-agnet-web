# Implementation Plan: Grok CLI subscription usage

## Ordered Checklist

1. Add shared extension-command result types and a server-only runner in `lib/`.
   - Create an in-memory cwd-bound SDK session.
   - Bind `ExtensionWebUiBridge` in RPC mode.
   - Resolve the exact registered command and invoke its handler with Pi's generated command context.
   - Gate capture to the command-running window and collect ordered command-owned notify levels/messages and command errors.
   - Race execution against request cancellation and a bounded timeout.
   - Dispose the session and pending UI requests in `finally`.

2. Add `POST /api/auth/usage/[provider]`.
   - Validate JSON, provider allowlist and cwd.
   - Enforce allowed-root checks before loading project extensions.
   - Map only `grok-cli` to `grok-cli-usage`.
   - Normalize missing command, empty output and execution failure responses without exposing credentials or extension source paths.

3. Wire the active workspace into Models UI.
   - Pass cwd from `AppShell` to `ModelsConfig`, then `OAuthDetail`.
   - Preserve current behavior when no workspace is selected.

4. Add the Grok usage state and view in `ModelsConfig.tsx`.
   - Load on logged-in Grok detail activation.
   - Add a duplicate-safe manual refresh action.
   - Render ordered original text with preserved whitespace and notice severity.
   - Handle no-cwd, loading, missing command, not logged in and network failure states.
   - Clear state on provider change/logout.

5. Update project documentation.
   - Add the API route and frontend behavior to module maps.
   - Document `pi-grok-cli >= 0.5.0`, Pi >= 0.80.0, `pi install npm:pi-grok-cli`, and that usage comes from `/grok-cli-usage` rather than copied billing logic.

## Validation

Run the required checks:

```bash
npm run lint
node_modules/.bin/tsc --noEmit
```

Focused API/lifecycle checks:

- With the installed and authenticated `pi-grok-cli`, call the new route for the active cwd and verify ordered info notices contain the extension's monthly usage text and optional weekly text.
- Verify the API response contains no token, refresh credential, callback URL or raw auth payload.
- Verify an unsupported provider, missing cwd, disallowed cwd and unavailable command return browser-safe errors.
- Verify repeated requests do not create entries in `globalThis.__piSessions` or new session JSONL files.
- Verify command warning/error notices retain their original severity.
- Verify bind-time notifications are absent from command-unavailable responses and request timeout/abort paths dispose the temporary session.

Focused UI checks:

- Open Models -> Grok CLI while logged in and verify loading, output and refresh states.
- Verify multiline text wraps without overlapping controls at desktop and narrow widths.
- Verify logout clears the usage output.
- Verify ChatGPT Plus/Pro quota and other OAuth provider detail views are unchanged.

## Risk And Rollback Points

- `components/ModelsConfig.tsx` is large and contains Codex-specific account/quota logic. Keep Grok state isolated and do not generalize the Codex quota contract.
- Loading all cwd extensions can execute third-party code; enforce the existing allowed-workspace boundary and the fixed command allowlist.
- The extension command has no structured return contract. Do not parse or cache fields; render notices verbatim.
- If the command bridge causes lifecycle issues, rollback is limited to the new runner/route and Grok-only UI block; existing OAuth and chat extension behavior remains untouched.

## Before Start

- User approved original command text plus refresh button.
- No remaining product questions.
- Ask the user to review this plan before running `task.py start`.
