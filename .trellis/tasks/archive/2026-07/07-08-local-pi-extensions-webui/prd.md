# Local Pi extensions in WebUI

## Goal

Make yolk pi web behave consistently with the local `pi` runtime for user-installed Pi packages/extensions, while keeping the WebUI's in-process SDK architecture.

## Problem Statement

The WebUI embeds `@earendil-works/pi-coding-agent` through the SDK instead of shelling out to the local `pi` CLI. Users expect packages installed in the local Pi agent directory, such as `pi-subagents`, `pi-intercom`, and prompt-template extensions, to be discovered and usable in WebUI sessions the same way they are in the CLI.

## Confirmed Facts

- The WebUI uses the SDK in-process via `createAgentSession()` in `lib/rpc-manager.ts`.
- The SDK `DefaultResourceLoader` discovers user/global resources from `getAgentDir()` (`~/.pi/agent` by default) and project resources from the session `cwd`.
- The current WebUI passes `agentDir = getAgentDir()` into `createAgentSession()`, so it should discover the same global `settings.json`, `packages`, skills, prompts, and extension resources as the CLI when `PI_CODING_AGENT_DIR` is the same.
- Local evidence: `C:\Users\lichong\.pi\agent\settings.json` contains packages `npm:pi-subagents`, `npm:pi-intercom`, and `npm:pi-prompt-template-model`.
- Local SDK evidence: `DefaultResourceLoader({ cwd, agentDir })` discovers those package extensions, skills, prompts, and extension tools (`subagent`, `wait`, `intercom`) without invoking the CLI.
- Current WebUI tool startup intentionally does **not** pass a `tools` allow-list to `createAgentSession()`, then activates tools via `setActiveToolsByName()`, so extension tools are not filtered out by a built-in-only allow-list.
- Current WebUI prepares a local `pi` shim in `lib/pi-runtime-resolver.ts` for extension tools that spawn nested Pi processes, especially subagent packages.
- The slash-command listing route `app/api/commands/route.ts` uses `DefaultResourceLoader` but currently returns only skills and prompt templates; extension commands registered through `pi.registerCommand()` are not exposed in Web autocomplete/listing.
- Raw `createAgentSession()` defaults extension mode to `print` with a no-op UI context until a host calls `session.bindExtensions(...)`; current `lib/rpc-manager.ts` does not bind an RPC/Web UI context, command context actions, session lifecycle hooks, or extension error reporting.
- Therefore the likely remaining mismatch is not basic package discovery, but host integration gaps: extension UI prompts/notifications/widgets, extension slash-command visibility, lifecycle/resource events, session replacement actions, and diagnostics.

## Requirements

- Reuse Pi SDK resource discovery instead of shelling out to the local `pi` CLI for normal session operation.
- Keep `PI_CODING_AGENT_DIR` / `getAgentDir()` as the source of truth for global Pi settings, installed packages, auth, models, sessions, skills, prompts, and extensions.
- Surface user-installed package resources in WebUI: tools, skills, prompt templates, and extension commands.
- Preserve security boundaries: project-local `.pi` resources should still follow Pi trust behavior; global packages run with full local permissions just like in CLI.
- Provide useful diagnostics when an extension/package fails to load or depends on a newer Pi SDK than the WebUI embeds.
- Avoid relying on an external `pi` command for the main session; process isolation via `pi --mode rpc` may remain a fallback design, not the default.

## Acceptance Criteria

- [ ] A WebUI session can load globally installed package extension tools from `~/.pi/agent/settings.json` packages.
- [ ] WebUI slash-command discovery includes extension commands in addition to skills and prompt templates, with source/provenance metadata.
- [ ] Extension load errors and resource diagnostics are visible enough to debug mismatched versions or failed package imports.
- [ ] Extensions that require simple UI interactions have an explicit WebUI behavior: supported through browser-mediated dialogs/notifications, or clearly degraded/unsupported.
- [ ] Extension lifecycle events that affect resources (`session_start`, `resources_discover`, `/reload`) are handled consistently enough that package-provided dynamic resources work.
- [ ] Existing built-in tool presets (`all`, `read-only`, `none`) keep extension tools available in `all` mode and do not accidentally filter them out.

## Out of Scope Candidates

- Replacing the SDK integration with CLI subprocess RPC as the primary architecture.
- Implementing every TUI-specific extension rendering/component API in the browser in the first iteration.
- Building a full Pi package manager UI unless needed after the compatibility layer is in place.

## MVP Scope Decision

- Prioritize extension tools, extension commands, diagnostics, and simple Web-mediated UI interactions (`notify`, `confirm`, `select`, `input`).
- Do not attempt full TUI component parity in the first implementation; TUI-only APIs such as `custom()` should degrade explicitly with diagnostics.
