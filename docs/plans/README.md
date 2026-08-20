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
| [`2026-08-01-001-refactor-frontend-visual-system-plan.md`](2026-08-01-001-refactor-frontend-visual-system-plan.md) | completed | Iterations 1–8 complete; Iteration 8 matrix record in `docs/operations/ui-visual-validation-results-2026-08-10.md`. |
| [`2026-08-01-002-refactor-theme-foundation-plan.md`](2026-08-01-002-refactor-theme-foundation-plan.md) | completed | Theme foundation and semantic Token contract. |
| [`2026-08-01-003-refactor-workbench-shell-navigation-plan.md`](2026-08-01-003-refactor-workbench-shell-navigation-plan.md) | completed | Implementation delivered in `34a75f8`; cross-surface manual matrix delegated to Iteration 8. |
| [`2026-08-01-004-refactor-chat-visual-system-plan.md`](2026-08-01-004-refactor-chat-visual-system-plan.md) | completed | Implementation delivered in `18229fd`; cross-surface manual matrix delegated to Iteration 8. |
| [`2026-08-01-005-refactor-inspector-visual-system-plan.md`](2026-08-01-005-refactor-inspector-visual-system-plan.md) | completed | Inspector and developer-tool visual system. |
| [`2026-08-01-006-refactor-settings-primitives-plan.md`](2026-08-01-006-refactor-settings-primitives-plan.md) | completed | Shared Settings primitives and dialog shell. |
| [`2026-08-01-007-refactor-mcp-agents-settings-plan.md`](2026-08-01-007-refactor-mcp-agents-settings-plan.md) | completed | MCP and Agents visual migration. |
| [`2026-08-01-008-refactor-resource-config-surfaces-plan.md`](2026-08-01-008-refactor-resource-config-surfaces-plan.md) | completed | Models, Extensions, Skills, and resource surfaces. |
| [`2026-08-01-009-refactor-ui-quality-regression-plan.md`](2026-08-01-009-refactor-ui-quality-regression-plan.md) | completed | Browser matrix + representative themes accepted 2026-08-11; mobile tool-only observation passed by product owner. |
| [`2026-08-07-001-refactor-i18n-coverage-plan.md`](2026-08-07-001-refactor-i18n-coverage-plan.md) | completed | Wave A–C product chrome coverage; residual typed keys/API codes remain ordinary backlog. |
| [`2026-08-07-002-feat-server-access-authentication-plan.md`](2026-08-07-002-feat-server-access-authentication-plan.md) | completed | Safe loopback defaults, server access key/session gate, global Proxy protection, production E2E, and deployment docs delivered. |
| [`2026-08-11-001-feat-session-performance-metrics-plan.md`](2026-08-11-001-feat-session-performance-metrics-plan.md) | completed | U1–U5 delivered: domain/sidecar, raw AgentSession recording, session-detail/SSE/client state, SessionResourcePanel + estimated live TPS, docs and targeted validation. |
| [`2026-08-11-002-feat-usage-token-charts-plan.md`](2026-08-11-002-feat-usage-token-charts-plan.md) | completed | U1–U5 delivered: server auto day/week/month timeline, resilient presets/refresh, dependency-free Token structure chart, modal integration, docs + targeted validation. Browser/manual theme-viewport matrix remains ordinary follow-up. |
| [`2026-08-12-001-feat-desktop-pet-task-observer-plan.md`](2026-08-12-001-feat-desktop-pet-task-observer-plan.md) | completed | U1–U8 complete: observer API, deep links, attach-only connection, pet/Activity tray/notifications, pet-only packaging contract + validation matrix. Manual Windows installer/signing gates remain in [`../operations/desktop-pet-validation.md`](../operations/desktop-pet-validation.md). Handoff: [`desktop-pet-handoff-prompts.md`](desktop-pet-handoff-prompts.md). |
| [`2026-08-14-001-feat-desktop-pet-competitive-optimization-plan.md`](2026-08-14-001-feat-desktop-pet-competitive-optimization-plan.md) | active | Fact-checked Codex/Claude/Clawd backlog. P1 U1/U2 delivered: Running cue + primary-activity context ring. Remaining: P2 DND/i18n、渐进式睡眠、声音/趣味交互；独立安全设计：U5 needs_input 桌面响应、U6 自定义宠物包；P3 迷你模式。启动/reconnect baseline 已有，只补验证。 |
| [`2026-08-17-001-feat-desktop-pet-quick-sessions-plan.md`](2026-08-17-001-feat-desktop-pet-quick-sessions-plan.md) | active | Scoped desktop-control token、path-free 项目 catalog、幂等首条消息启动、Electron main/IPC 与 Activity tray composer；完整对话仍回到 WebUI。 |
| [`2026-08-18-001-feat-codex-pet-resource-compatibility-plan.md`](2026-08-18-001-feat-codex-pet-resource-compatibility-plan.md) | completed | U1–U6 delivered: dual-format catalog, lazy Codex v1/v2 playback, v2 look/drag overlays, namespaced selection keys, docs + contract smokes. Local visual matrix remains in [`../operations/desktop-pet-validation.md`](../operations/desktop-pet-validation.md). ZIP import is a follow-up. |
| [`2026-09-17-001-refactor-tauri-desktop-pet-migration-plan.md`](2026-09-17-001-refactor-tauri-desktop-pet-migration-plan.md) | active | Phase A–B code delivered (isolated shell + secure Observer/renderer bridge). Remaining: U5–U8 feature/native/quick-session/package qualification. Electron stays the default. |

This status table is the active implementation, performance, and functional-polish backlog index. Historical investigations and implemented design inputs live under [`../research/`](../research/README.md).
