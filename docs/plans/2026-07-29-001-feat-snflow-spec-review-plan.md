---
title: "feat: Add SnFlow spec review command"
type: feat
status: completed
date: 2026-07-29
origin: docs/brainstorms/2026-07-29-snflow-spec-review-requirements.md
---

# feat: Add SnFlow spec review command

## Overview

Add a project-managed `/snflow-spec-review` extension command that binds to the current non-archived SnFlow task, performs deterministic preflight checks, and sends a task-specific review instruction into the current main chat. The resulting Agent turn is read-only: it inspects task documents, run results, the current diff, and existing project Spec, then presents structured candidates. Only a later explicit user confirmation allows the main Agent to update `.pi/snflows/spec/**`.

This extends the existing SnFlow project extension and current-chat orchestration model rather than adding a CLI semantic runner, panel flow, custom persistence schema, or new subagent (see origin: `docs/brainstorms/2026-07-29-snflow-spec-review-requirements.md`).

---

## Problem Frame

SnFlow already installs a project Spec skeleton and tells agents to capture reusable lessons before finishing, but that behavior is advisory only. There is no explicit review entrypoint, deterministic current-task binding, candidate format, or confirmation boundary. As a result, repaired mistakes and stable design conventions can remain trapped in a task conversation instead of improving future Implement/Check work.

---

## Requirements Trace

- R1. Expose an explicit `/snflow-spec-review` command; do not auto-trigger it after Check or task completion.
- R2. Resolve only the current physical task under `.pi/snflows/tasks/`; reject missing, stale, archived, malformed, or bootstrap-task context without guessing another task.
- R3. Run semantic analysis in the current main Agent turn; do not dispatch Implement/Check agents or hidden CLI/RPC workers.
- R4. Require analysis of task documents, available run results, relevant diff, and existing Spec while distinguishing reusable rules from task-specific observations.
- R5. Produce stable candidate IDs with type, root cause/context, proposed wording, applicability, target Spec path, code evidence, and relationship to existing rules.
- R6. Explicitly report “本任务无需更新规范” when no reusable candidate exists.
- R7. Keep the candidate-generation turn read-only and require a subsequent explicit user confirmation before Spec writes.
- R8. On confirmation, re-read current state, apply only accepted candidates, avoid duplication, preserve unrelated content, and synchronize affected indexes.
- R9. Report changed Spec files, applied/revised rules, rejected candidates, and residual uncertainty after writeback.

**Origin actors:** A1 (user), A2 (SnFlow main Agent), A3 (later Implement/Check agents)

**Origin flows:** F1 (generate spec candidates), F2 (confirm and write Spec)

**Origin acceptance examples:** AE1 (missing current task), AE2 (revision candidate without writes), AE3 (no reusable lesson), AE4 (partial candidate acceptance)

---

## Scope Boundaries

- Do not add automatic post-Check prompts or a mandatory workflow state between `checking` and `ready_to_commit`.
- Do not accept a task ID argument, inspect non-current completed tasks, or fall through to any archived task directory in v1.
- Do not add a panel button, task CLI command, API route, run-record schema, candidate sidecar, or custom session entry.
- Do not add a `snflow-spec-review` subagent; the current main Agent owns analysis and confirmed writeback.
- Do not automatically modify Spec, `AGENTS.md`, task metadata, task documents, product source, or Git state during candidate generation.
- Do not persist pending candidates outside the conversation in v1. If the relevant conversation context is unavailable, rerun `/snflow-spec-review`.
- Restrict confirmed writeback to `.pi/snflows/spec/**`; changes to SnFlow discovery guidance or `AGENTS.md` remain separate explicit work.

---

## Context & Research

### Relevant Code and Patterns

- `.pi/extensions/snflow/index.ts` is the installed project extension source used in this repository. It is self-contained, resolves session workspace from `ctx.cwd`, skips subagent children, and currently injects task-aware `before_agent_start` guidance.
- `lib/snflow-assets.ts` embeds the same extension, skill, and agent assets for production-safe initialization/update. `scripts/smoke-snflow-setup.ts` enforces byte equality between embedded assets and repository copies.
- `lib/workflow-current.ts` and `lib/workflow-store.ts` define current-task pointers, task identity, revisions, documents, runs, and archive boundaries. The managed extension cannot import them because installed target projects need a self-contained extension.
- `app/api/commands/route.ts` discovers registered extension commands through the Pi SDK; `components/ChatInput.tsx` already exposes them in Web autocomplete. Unknown extension commands default to full Web support in `lib/extension-command-web-support.ts`, so no feature-specific UI branch is required.
- `lib/rpc-manager.ts` sends Web prompts through `AgentSession.prompt()`, binds extension commands in RPC mode, and handles extension-command settlement. Pi’s official command pattern supports `pi.registerCommand()` plus `pi.sendUserMessage()` to trigger the current Agent.
- `.pi/skills/snflow-dev/SKILL.md` owns stable SnFlow lifecycle instructions. It should document the new review/confirmation protocol even though the generated task-bound instruction must remain complete enough to execute safely on its own.
- Existing targeted smoke scripts use temporary workspaces and assertion-style tests instead of a full application test framework.

### Institutional Learnings

- No `docs/solutions/` knowledge base exists in this repository.
- Existing SnFlow architecture repeatedly favors fail-closed task/cwd/revision checks, one current-chat orchestrator, no hidden phase host, and no writes to legacy `.trellis/`; the command should preserve those boundaries.

### External References

- Pi SDK `docs/extensions.md`: extension commands are checked before skills/templates; `pi.registerCommand()` defines discoverable commands; `pi.sendUserMessage()` triggers an actual Agent turn; command handlers receive `ctx.cwd`, `ctx.isIdle()`, `ctx.waitForIdle()`, and RPC-capable UI notifications.
- Pi SDK `docs/prompt-templates.md`: templates expand text but cannot provide the deterministic current-task preflight required here, so a managed extension command is the better entrypoint.

External web research is unnecessary: the repository pins Pi SDK `0.82.1`, installed documentation and direct local command examples define the relevant contract, and the project already has the exact extension/Web-command integration pattern.

---

## Key Technical Decisions

- **Use a managed extension command, not a prompt template:** command registration gives deterministic preflight, current `ctx.cwd`, Web discovery, and a controlled handoff into the current Agent.
- **Keep the installed extension self-contained:** mirror existing asset architecture; do not import Snail Pi Web libraries from target-project `.pi/extensions/snflow/index.ts`.
- **Use a generated user message for semantic work:** after preflight, `pi.sendUserMessage()` starts the main Agent with exact task-relative paths and the full candidate/confirmation contract. The extension itself performs no model call and no mutation.
- **Keep pending candidates conversation-scoped:** candidates receive stable IDs (`C1`, `C2`, …); a later user message selects or edits IDs. This avoids a new persistence/state schema while preserving explicit approval.
- **Make candidate generation a hard read-only turn:** the instruction prohibits `edit`/`write`, source changes, task-state changes, commits, and subagent dispatch. Marker-specific `before_agent_start` guidance replaces ordinary phase guidance for that turn so `ready_to_commit` learning text cannot accidentally authorize an immediate write. The turn must end after candidates or the exact no-update result.
- **Revalidate before confirmed writeback:** the follow-up protocol requires re-reading the pointer, task metadata, target Spec files, and indexes before applying only accepted IDs. Drift becomes a reported conflict, not a blind write.
- **Reject command arguments in v1:** non-empty arguments receive a usage diagnostic so a task ID cannot silently expand scope to historical tasks.
- **Treat `00-bootstrap-spec` separately:** reject it with guidance to follow its bootstrap plan; its purpose and write rules differ from post-task learning review.
- **Bump managed asset SemVer:** changing the extension and skill advances the managed asset version from `1.5.0` to `1.6.0` and synchronizes the project `.version`, so initialized projects receive an Update recommendation.

---

## Open Questions

### Resolved During Planning

- **Command carrier:** use `pi.registerCommand("snflow-spec-review", ...)` in the managed project extension; templates and CLI do not satisfy deterministic task binding.
- **Candidate persistence:** retain candidates only in the current conversation for v1; no sidecar or custom session entry.
- **Spec target safety:** generated candidates may only name normalized repo-relative paths below `.pi/snflows/spec/`; confirmed writeback re-reads and deduplicates the selected targets before editing.
- **Web support:** rely on existing extension-command discovery and default `full` classification; no ChatInput component change is needed.
- **Current task meaning:** accept a valid physical non-archived task under `tasks/` regardless of lifecycle status, except the special bootstrap task. Do not fall through to `archived/`.

### Deferred to Implementation

- **Exact helper names and prompt wording:** keep them readable and testable while preserving the behavioral contract; they do not affect public product behavior.
- **Whether existing run evidence is sparse:** the Agent should state reduced confidence and continue when run records or diff evidence are unavailable, but missing task documents or Spec root/index should fail preflight.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
sequenceDiagram
    participant U as User
    participant E as SnFlow extension command
    participant A as Current main Agent
    participant S as .pi/snflows/spec

    U->>E: /snflow-spec-review
    E->>E: Resolve ctx.cwd and current active task
    alt invalid current task / docs / Spec / args
        E-->>U: Web/TUI diagnostic; no Agent turn
    else valid context
        E->>A: sendUserMessage(task-bound read-only review instruction)
        A->>A: Read task docs, runs, diff, and existing Spec
        A-->>U: C1..Cn candidates or “本任务无需更新规范”
        Note over A,S: No writes in candidate-generation turn
        U->>A: Accept/edit selected candidate IDs
        A->>A: Revalidate task pointer and current Spec
        A->>S: Apply only confirmed changes and sync indexes
        A-->>U: Changed files, applied/ignored candidates, uncertainty
    end
```

---

## Implementation Units

- [x] U1. **Add the task-bound spec-review command and protocol**

**Goal:** Register `/snflow-spec-review` in the managed SnFlow extension, fail closed before dispatch, and define a complete two-turn candidate/confirmation protocol for the current main Agent.

**Requirements:** R1, R2, R3, R4, R5, R6, R7, R8, R9; A1, A2, A3; F1, F2

**Dependencies:** None

**Files:**
- Modify: `.pi/extensions/snflow/index.ts`
- Modify: `.pi/skills/snflow-dev/SKILL.md`
- Modify: `lib/snflow-assets.ts`
- Modify: `.pi/snflows/.version`
- Test: `scripts/smoke-snflow-spec-review.ts`
- Test: `scripts/smoke-snflow-setup.ts`

**Approach:**
- Extend the extension’s minimal local Pi API typing only with the command and user-message capabilities it consumes; keep the asset free of imports from WebUI libraries.
- Register `snflow-spec-review` with a concise description so it appears naturally in both Pi and Snail Pi Web command autocomplete; do not register it in `PI_SUBAGENT_CHILD` runtimes.
- Resolve workspace exclusively from command `ctx.cwd`. Reject child-agent environments, disabled/uninitialized SnFlow, non-empty arguments, busy Agent state, missing/stale current pointer, archived-only task, malformed or archived task metadata, bootstrap task, missing canonical task documents, and missing/unusable Spec index with a clear notification and no Agent message.
- Build one task-bound instruction containing the current task ID/title/status/revision and repo-relative paths for task metadata, requirements/design/plan, runs, and Spec index. Run records and Git diff are evidence sources but may be absent; the prompt must require confidence disclosure instead of invented evidence.
- Require an observation pass that classifies reusable and non-reusable lessons, then emits stable candidate IDs and all R5 fields. Target paths must stay below `.pi/snflows/spec/`, evidence paths must be real and repo-relative, and duplicate/conflicting existing rules must be identified.
- Prohibit all writes and subagent calls in the candidate-generation turn. Detect the `SNFLOW_SPEC_REVIEW v1` prompt in `before_agent_start` and inject dedicated read-only candidate guidance instead of ordinary task-phase guidance. End after candidates or the exact no-update statement, and ask the user to accept, edit, or reject candidate IDs in a later message.
- Define the follow-up writeback contract in both the generated prompt and `snflow-dev`: revalidate task/current Spec, apply only explicitly accepted IDs, preserve unrelated content, synchronize affected layer/root indexes, and provide the R9 report. Do not change workflow status or `AGENTS.md`.
- Update the embedded extension/skill assets and repository copies together, bump the managed asset version, and preserve update behavior that never overwrites project-owned Spec content.

**Patterns to follow:**
- `.pi/extensions/snflow/index.ts` for `ctx.cwd` resolution, best-effort guidance, task-path handling, and subagent-child exclusion.
- `node_modules/@earendil-works/pi-coding-agent/examples/extensions/send-user-message.ts` for command-to-current-Agent handoff.
- `lib/snflow-assets.ts` and `scripts/smoke-snflow-setup.ts` for managed source parity and version checks.
- `.pi/skills/snflow-dev/SKILL.md` for main-session write ownership and fail-closed workflow guidance.

**Test scenarios:**
- **Covers AE1. Error path:** no `current.json` → command emits a missing-current-task diagnostic, sends no Agent message, and mutates no files.
- **Covers AE1. Error path:** pointer references a missing task or a task present only under `archived/` → command refuses fallback and sends no review instruction.
- **Error path:** non-empty command argument, malformed task metadata, `archived:true` metadata, missing requirements/design/plan, missing Spec index, bootstrap task, or busy Agent → precise diagnostic and zero Agent messages.
- **Covers AE2. Happy path:** valid current task → exactly one user message contains exact task identity and paths, current-main-Agent/no-subagent constraints, candidate fields, read-only boundary, and later-confirmation instructions.
- **Covers AE3. Contract path:** generated instruction requires the exact no-update result when no reusable lesson exists and forbids manufactured candidates.
- **Covers AE4. Contract path:** generated instruction requires stable candidate IDs, partial selection, revalidation, accepted-only writeback, deduplication, index synchronization, and final applied/ignored/risk reporting.
- **Safety path:** snapshot the temporary task and Spec trees before invoking the command and confirm command execution itself performs no writes.
- **Asset integration:** repository extension/skill content remains byte-equal to embedded managed assets; updated asset/version status causes older initialized projects to recommend Update without touching their Spec.

**Verification:**
- `/snflow-spec-review` is registered by initialized projects and generates a single task-bound main-Agent turn only after all preconditions pass.
- Candidate generation cannot be mistaken for approval, and the documented next-turn protocol fully covers selective writeback.
- Fresh init/update installs the new command and skill guidance while preserving user-owned `.pi/snflows/spec/**`.

---

- [x] U2. **Add a repeatable SnFlow command smoke suite**

**Goal:** Make the new command contract and existing SnFlow asset lifecycle easy to validate as a supported project test surface.

**Requirements:** R1, R2, R3, R7, R8; AE1, AE2, AE3, AE4

**Dependencies:** U1

**Files:**
- Create: `scripts/smoke-snflow-spec-review.ts`
- Modify: `package.json`
- Modify: `AGENTS.md`
- Modify: `docs/standards/code-style.md`
- Test: `scripts/smoke-snflow-spec-review.ts`
- Test: `scripts/smoke-snflow-setup.ts`
- Test: `scripts/smoke-workflow-store.ts`
- Test: `scripts/smoke-workflow-session-link.ts`

**Approach:**
- Build a deterministic fake Extension API around the repository SnFlow extension, capturing registered command metadata, notifications, and user messages without invoking a model.
- Create temporary workspace fixtures for valid and invalid current-task states and assert both the generated instruction contract and zero-mutation boundary.
- Include a Web classification assertion showing `snflow-spec-review` remains `full` support under `lib/extension-command-web-support.ts` without adding a name-specific exception.
- Add a `test:snflow` npm script that runs the setup, store, session-link, and new command smokes as one documented validation entrypoint. Keep the current-chat lifecycle smoke independently runnable because its existing ESM-only SDK host path is not stable under the aggregate tsx invocation on this Windows/Node runtime.
- Add the command to the repository’s validation/navigation docs without changing production build guidance.

**Patterns to follow:**
- `scripts/smoke-snflow-setup.ts` for temporary projects, plain assertions, managed asset parity, and cleanup.
- `scripts/smoke-workflow-chat-lifecycle.ts` for fail-closed workflow cases and contract-level result assertions.
- `AGENTS.md` and `docs/standards/code-style.md` for concise supported validation commands.

**Test scenarios:**
- **Happy path:** `npm run test:snflow` executes every listed smoke and exits successfully when all contracts hold.
- **Failure path:** changing the command name, removing required candidate fields, permitting archived fallback, or breaking source/embedded parity makes a focused assertion fail with a useful label.
- **Integration:** an initialized temporary project contains an extension whose registered command is discoverable as `snflow-spec-review`, classified as Web-supported, and whose valid handler emits the expected Agent instruction.
- **Regression:** ordinary SnFlow setup, task storage, and session binding smokes continue to pass after the extension API shape changes; the existing Implement/Check lifecycle smoke remains a separate focused check.

**Verification:**
- Contributors have one documented SnFlow validation command and failures point to the affected lifecycle layer.
- No model credentials, browser session, running Next server, or external network is required for command tests.

---

- [x] U3. **Document the explicit Spec maintenance lifecycle**

**Goal:** Make the command’s purpose, safety boundary, managed-asset behavior, and relationship to normal SnFlow phases discoverable to maintainers and users.

**Requirements:** R1, R3, R6, R7, R8, R9; F1, F2

**Dependencies:** U1, U2

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/integrations/README.md`
- Modify: `docs/modules/library.md`
- Modify: `docs/standards/code-style.md`
- Modify: `AGENTS.md`

**Approach:**
- Describe `/snflow-spec-review` as an optional explicit current-chat review, not a new task phase or automatic completion gate.
- Document deterministic current-task preflight, candidate-only first turn, explicit selective confirmation, conversation-scoped pending candidates, and accepted-only Spec/index writes.
- Update managed asset documentation and version/update expectations so target projects know they must run SnFlow Update to receive the command.
- Document the new smoke-suite entrypoint and preserve the existing separation between durable product docs (`docs/`) and project conventions (`.pi/snflows/spec/`).

**Patterns to follow:**
- `docs/architecture/overview.md` SnFlow section for lifecycle and invariants.
- `docs/integrations/README.md` configuration boundary and managed project asset description.
- `docs/modules/library.md` concise source-module ownership table.

**Test scenarios:**
- Test expectation: none — documentation-only unit; verify terminology and paths against the implemented command and test suite.

**Verification:**
- A maintainer can tell when the command runs, what it reads, when writes become legal, where candidate state lives, and how initialized projects receive it.
- Documentation does not imply automatic review, historical task support, CLI analysis, subagent dispatch, or persisted candidates.

---

## System-Wide Impact

- **Interaction graph:** ChatInput discovers the registered extension command through `/api/commands`; AgentSession executes the command; the extension validates `ctx.cwd` and current task; `pi.sendUserMessage()` starts the normal current-Agent lifecycle; confirmed follow-up uses existing file tools. No new API endpoint or panel state is introduced.
- **Error propagation:** deterministic preflight failures surface through extension UI notifications and do not start an Agent turn. Agent-side evidence gaps are reported as reduced confidence; unsafe/missing task or Spec roots stop the flow.
- **State lifecycle risks:** candidates exist only in conversation context. Session loss or switching requires rerunning the command. The command does not mutate task status, run records, current pointers, or Spec files.
- **API surface parity:** Pi TUI and Snail Pi Web both consume the same registered command. Web autocomplete and RPC extension bindings already support this path; the CLI task manager remains unchanged.
- **Integration coverage:** fake-extension smoke proves command registration/preflight/prompt contract; setup smoke proves embedded deployment/version parity; existing lifecycle smokes protect ordinary SnFlow execution.
- **Unchanged invariants:** initialization remains availability-only; SnFlow entry stays opt-in; Implement/Check remain foreground native subagents; one-writer rules remain; Check severity gating remains; `.trellis/` is never read or written; user controls commit/push/PR.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| The generated Agent ignores the no-write boundary | Make the instruction explicit, complete, and smoke-asserted; require the first turn to end after candidates. Keep the extension handler itself read-only. A future hard tool gate is out of v1 scope. |
| `pi.sendUserMessage()` causes Web lifecycle races | Follow the pinned SDK’s official extension-command pattern and cover command registration/message emission without network; retain existing `prompt_settled` behavior and manually verify one Web invocation during implementation. |
| Managed repository and embedded assets drift | Keep the existing byte-parity smoke, update both copies in one unit, and bump the asset version. |
| Candidate rules become noisy or overgeneralized | Require evidence paths, applicability, existing-rule comparison, `do_not_capture`, and explicit user selection. |
| Spec changes race with later conversation turns | Re-read pointer, task metadata, target files, and indexes before confirmed writeback; report drift instead of applying stale wording. |
| Initialized target projects do not see the command immediately | Version bump makes setup status recommend SnFlow Update; documentation calls this out. |
| Current task has no useful run or diff evidence | Allow analysis with an explicit confidence warning, but never invent evidence; task docs and Spec index remain mandatory. |

---

## Documentation / Operational Notes

- This is a managed-asset feature: existing initialized projects receive it only after SnFlow Update.
- No migration is required for task.json, current.json, run records, or existing Spec files.
- Manual Web verification should confirm command autocomplete, command submission, one generated Agent turn, candidate-only output, and a selected-candidate follow-up write.
- Routine validation is `npm run lint`, `node_modules/.bin/tsc --noEmit`, and the new `npm run test:snflow`; production validation must continue to use `npm run build`, never direct `next build`.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-29-snflow-spec-review-requirements.md](../brainstorms/2026-07-29-snflow-spec-review-requirements.md)
- Related code: `.pi/extensions/snflow/index.ts`
- Related code: `.pi/skills/snflow-dev/SKILL.md`
- Related code: `lib/snflow-assets.ts`
- Related code: `app/api/commands/route.ts`
- Related code: `lib/rpc-manager.ts`
- Related tests: `scripts/smoke-snflow-setup.ts`
- Pi SDK docs: `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Pi prompt-template docs: `node_modules/@earendil-works/pi-coding-agent/docs/prompt-templates.md`
