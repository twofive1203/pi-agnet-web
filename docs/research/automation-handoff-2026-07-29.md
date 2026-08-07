# Handoff: Scheduled Agent Automation

Date: 2026-07-29

Status: superseded — implementation completed and SnFlow task archived

Final task commit: `d4621a6`

SnFlow task: `07-28-agent-automation` (`completed`, `archived: true`)

> This file is a historical handoff, not an active implementation or check procedure. Do not restart the archived SnFlow task or follow the former `complete/archive` instructions. The removed root file `SCHEDULED_AGENT_AUTOMATION_PLAN.md` is no longer an authoritative source.

## Current authoritative sources

- [`docs/architecture/decisions/automation-scheduler.md`](../architecture/decisions/automation-scheduler.md) — architecture, trust boundaries, scheduler and runner decisions.
- [`docs/architecture/overview.md`](../architecture/overview.md) — product runtime flow and invariants.
- [`docs/automation-user-guide.zh-CN.md`](../automation-user-guide.zh-CN.md) — setup and operation guide.
- [`docs/modules/api.md`](../modules/api.md), [`docs/modules/frontend.md`](../modules/frontend.md), and [`docs/modules/library.md`](../modules/library.md) — current code ownership and API surfaces.
- `AGENTS.md` — Automation invariants and validation entry points.
- `npm run test:automation` — focused Automation smoke suite.

## Final implementation outcome

Scheduled Agent Automation is implemented across:

| Area | Current paths |
| --- | --- |
| Domain/store/locks | `lib/automation-types.ts`, `lib/automation-store.ts`, `lib/automation-lock.ts`, `lib/automation-paths.ts`, `lib/automation-default-cwd.ts` |
| Schedule/scheduler | `lib/automation-schedule.ts`, `lib/automation-scheduler.ts`, `lib/automation-run-registry.ts`, `instrumentation.ts` |
| Policy/security | `lib/automation-tool-policy.ts`, `lib/automation-network-policy.ts`, `lib/automation-secret-policy.ts`, `lib/automation-reviewed-extension-registry.ts` |
| Runner/worker | `lib/automation-runner.ts`, `lib/automation-worker-host.ts`, `lib/automation-worker-runtime.cjs`, `lib/automation-extension-*.ts` |
| Service/API/tools | `lib/automation-service.ts`, `lib/automation-api.ts`, `lib/automation-tools.ts`, `app/api/automations/**` |
| Session/promote/retention | `lib/automation-session.ts`, `lib/automation-promotion.ts`, `lib/automation-retention.ts` |
| UI | `components/Automation*.tsx`, `hooks/useAutomations.ts`, `lib/i18n/messages/automation.ts` |
| Validation | `scripts/run-automation-smokes.cjs`, `scripts/smoke-automation-*.ts`, `scripts/fault-inject-automation-*.ts` |

Data remains isolated under `~/.pi/agent/automations/`; Automation JSONL does not appear in ordinary project-session lists. The default working directory is `~/pi-automation-cwd`, persisted as a canonical absolute path.

## Historical handoff context

At the time of the original handoff, the implementation commit was `dae36b3` and the final independent check had been interrupted by a provider usage limit. Later work closed the check loop, recorded commit `d4621a6`, completed the SnFlow task, and archived it. The original document's `failed` task state, restart commands, and missing-plan reference therefore described an intermediate state only.

Regression-sensitive themes from that work remain useful historical context:

- direct-loopback trust rather than Host-header trust;
- scheduler fencing, reconcile, lease heartbeat, and atomic run-now gates;
- abort-ignore isolation and killable workers;
- pre-import reviewed-extension allowlists and immutable reviewed bytes;
- hard total token ceilings and audit transaction identifiers;
- Windows-safe occurrence-claim filenames;
- standalone worker/discovery artifacts included in build and package output;
- fail-closed behavior for unapproved extension factories.

## Residual boundaries

These are product boundaries, not unfinished handoff steps:

- no execution while the Web service is fully stopped;
- no multi-host database/queue scheduler;
- no unrestricted shell or general OS sandbox;
- no multi-user RBAC or remote non-loopback mode;
- Automation cost remains separate from the default Usage panel;
- third-party extension tools require an operator-reviewed registry entry.

For current risks and operational troubleshooting, use the authoritative sources above rather than this historical note.
