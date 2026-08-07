# Implementation Plans

This directory keeps implementation plans and delivery records. Treat `status` as the current execution signal; completed plans remain for traceability and are not active backlog.

Status vocabulary:

- `completed` — implementation delivery is closed; any broader manual regression explicitly delegated to another active plan does not reopen it.
- `active` — work or an acceptance gate remains open.
- `deferred` — intentionally postponed and not release-blocking.

## Status index

| Plan | Status | Delivery or remaining scope |
| --- | --- | --- |
| [`2026-03-10-001-feat-lightweight-browser-optimization-plan.md`](2026-03-10-001-feat-lightweight-browser-optimization-plan.md) | active | Parts 1–2 complete; Part 3 pending. U7 frame contexts are conditional/optional; U8 release hardening remains. |
| [`2026-07-29-001-feat-snflow-spec-review-plan.md`](2026-07-29-001-feat-snflow-spec-review-plan.md) | completed | `/snflow-spec-review` planning and implementation record. |
| [`2026-07-29-002-feat-mcp-configuration-settings-plan.md`](2026-07-29-002-feat-mcp-configuration-settings-plan.md) | completed | Delivered in `0ea5a5b`; current entries are `lib/mcp-config.ts`, `/api/mcp/config`, and `components/McpConfig.tsx`. |
| [`2026-08-01-001-refactor-frontend-visual-system-plan.md`](2026-08-01-001-refactor-frontend-visual-system-plan.md) | active | Iterations 1–7 complete; only the Iteration 8 browser/manual matrix remains. |
| [`2026-08-01-002-refactor-theme-foundation-plan.md`](2026-08-01-002-refactor-theme-foundation-plan.md) | completed | Theme foundation and semantic Token contract. |
| [`2026-08-01-003-refactor-workbench-shell-navigation-plan.md`](2026-08-01-003-refactor-workbench-shell-navigation-plan.md) | completed | Implementation delivered in `34a75f8`; cross-surface manual matrix delegated to Iteration 8. |
| [`2026-08-01-004-refactor-chat-visual-system-plan.md`](2026-08-01-004-refactor-chat-visual-system-plan.md) | completed | Implementation delivered in `18229fd`; cross-surface manual matrix delegated to Iteration 8. |
| [`2026-08-01-005-refactor-inspector-visual-system-plan.md`](2026-08-01-005-refactor-inspector-visual-system-plan.md) | completed | Inspector and developer-tool visual system. |
| [`2026-08-01-006-refactor-settings-primitives-plan.md`](2026-08-01-006-refactor-settings-primitives-plan.md) | completed | Shared Settings primitives and dialog shell. |
| [`2026-08-01-007-refactor-mcp-agents-settings-plan.md`](2026-08-01-007-refactor-mcp-agents-settings-plan.md) | completed | MCP and Agents visual migration. |
| [`2026-08-01-008-refactor-resource-config-surfaces-plan.md`](2026-08-01-008-refactor-resource-config-surfaces-plan.md) | completed | Models, Extensions, Skills, and resource surfaces. |
| [`2026-08-01-009-refactor-ui-quality-regression-plan.md`](2026-08-01-009-refactor-ui-quality-regression-plan.md) | active | Static contracts/docs complete; fixed browser matrix and representative-theme confirmation remain. |
| [`2026-08-07-001-refactor-i18n-coverage-plan.md`](2026-08-07-001-refactor-i18n-coverage-plan.md) | completed | Wave A–C product chrome coverage; residual typed keys/API codes remain ordinary backlog. |

The cross-cutting performance and functional backlog lives in [`../../PERFORMANCE_AND_POLISH_ROADMAP.md`](../../PERFORMANCE_AND_POLISH_ROADMAP.md). Historical investigations and implemented design inputs live under [`../research/`](../research/README.md).
