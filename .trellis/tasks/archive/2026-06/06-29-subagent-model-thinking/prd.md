# Show subagent model and thinking level

## Goal

Make the top-bar Subagents panel more informative by showing each child agent's execution model and thinking level in addition to the agent title/task summary.

## User Value

Users can quickly verify which model and reasoning/thinking setting a subagent used without opening raw tool output or inferring it from routing metadata.

## Confirmed Facts

- The relevant UI is `components/SubagentPanel.tsx`.
- Top-bar subagent state is produced by `hooks/useAgentSession.ts` as `SubagentRun` objects.
- `SubagentRun.routing` already carries optional routing metadata, including `model` and `thinking`.
- `SubagentPanel` currently renders agent name, task summary, status, and a compact verbose routing label when routing metadata exists.
- Nested child subagents are parsed by `lib/parse-subagent-children.ts`; existing parsed children currently do not preserve routing metadata.

## Requirements

- Display execution model for subagent runs when known.
- Display thinking level for subagent runs when known.
- Keep the primary title/task row readable and compact in the top panel.
- Apply the display consistently to running/completed top-level subagents and nested child subagents where metadata is available.
- Preserve existing status, output expansion, nested-child loading, and failure behavior.
- Avoid showing misleading metadata when model/thinking data is not available.

## Acceptance Criteria

- [x] A subagent run with routing model metadata visibly shows its model outside the expanded raw output area.
- [x] A subagent run with routing thinking metadata visibly shows its thinking level outside the expanded raw output area.
- [x] The panel remains usable when metadata is missing; missing values are hidden or clearly non-misleading.
- [x] Existing routing details needed for debugging remain accessible, at least via tooltip or equivalent compact presentation.
- [x] Nested subagent rows use the same model/thinking display pattern when metadata exists.
- [x] `npm run lint` passes.
- [x] `node_modules/.bin/tsc --noEmit` passes.

## Out of Scope

- Changing subagent execution or routing behavior.
- Adding new backend routing fields beyond data already emitted/stored.
- Redesigning the entire top-bar panel layout.

## Decisions

- Rows with missing model/thinking metadata hide those fields instead of showing unknown placeholders.
