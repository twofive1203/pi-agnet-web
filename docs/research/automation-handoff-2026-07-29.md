# Handoff: Scheduled Agent Automation

date: 2026-07-29  
branch: `self-run`  
task: SnFlow `07-28-agent-automation`（`.pi/snflows/tasks/` 被 gitignore，仅本地）  
plan source: `SCHEDULED_AGENT_AUTOMATION_PLAN.md`

## Goal for the next session

把“定时 Agent Automation”从 **实现基本完成、终检未闭环** 推进到：

1. 独立 `snflow-check` 正式 `pass`
2. 用户确认后 `complete --hash <sha>` + `archive`
3. 如需再补 PR/发布说明

本会话已按用户要求提交当前实现；**不要重做主体功能**，先做终检与残留风险清理。

## Current status

| Item | State |
| --- | --- |
| Product implementation | Largely complete (store/schedule/security/runner/worker/API/tools/UI/docs/smokes) |
| Latest independent check | **Not completed** — last check failed with `Codex error: The usage limit has been reached`, not a code verdict |
| Known must-fix before last implement | 3 items; last implement claimed fixed and green validation |
| SnFlow task status at handoff | was `failed` after aborted check; restart with `npx tsx scripts/snflow-task.ts start 07-28-agent-automation` before check |
| Commit | see latest `git log -1` on branch `self-run` |

### What last implement claimed fixed

1. **SSRF IPv6 link-local**: full `fe80::/10` (`fe80`–`febf`), compressed/zone/bracket forms  
2. **Reviewed extension auth**: trusted registry exact digest → authorize/execute with real schema/hooks; no `unknown_extension_forbidden` false reject; drift still fail-closed  
3. **Real-path i18n**: AppDialog authority summary localized; `dispose_unconfirmed:<reason>` normalized; omission kinds / diagnostics localized  

Claimed validation: `test:automation` 15/15, browser/runtime/lint/tsc/build/pack, production catalog + run-now.

**These claims were not independently re-verified** because the final check hit usage limits.

## Architecture map (read first)

Primary docs:

- `SCHEDULED_AGENT_AUTOMATION_PLAN.md` — full product/tech plan  
- `docs/architecture/decisions/automation-scheduler.md`  
- `docs/architecture/overview.md` (Automation section)  
- `AGENTS.md` invariants for Automation  
- SnFlow task docs (local only):  
  - `.pi/snflows/tasks/07-28-agent-automation/requirements.md`  
  - `design.md` / `plan.md` / `task.json`

Core code:

| Area | Paths |
| --- | --- |
| Domain/store/locks | `lib/automation-types.ts`, `automation-store.ts`, `automation-lock.ts`, `automation-paths.ts`, `automation-default-cwd.ts` |
| Schedule | `lib/automation-schedule.ts` |
| Policy/network/secrets/registry | `automation-tool-policy.ts`, `automation-network-policy.ts`, `automation-secret-policy.ts`, `automation-resource-catalog.ts`, `automation-reviewed-web-tools.ts`, `automation-reviewed-extension-registry.ts` |
| Runner/worker/discovery | `automation-runner.ts`, `automation-worker-host.ts`, `automation-worker-runtime.cjs`, `automation-extension-*.ts`, `automation-extension-discovery-runtime.cjs`, `automation-token-budget.ts` |
| Scheduler | `automation-scheduler.ts`, `automation-run-registry.ts`, `automation-process-lifecycle.ts`, `instrumentation.ts` |
| Service/API/tools | `automation-service.ts`, `automation-api.ts`, `automation-tools.ts`, `automation-approval.ts`, `automation-local-access.ts`, `app/api/automations/**` |
| Session/promote/retention | `automation-session.ts`, `automation-promotion.ts`, `automation-retention.ts` |
| UI | `components/Automation*.tsx`, `hooks/useAutomations.ts`, `lib/automation-ui-state.ts`, `lib/automation-locale-format.ts`, `lib/i18n/messages/automation.ts`, `components/AppShell.tsx` |
| Smokes/E2E | `scripts/smoke-automation-*.ts`, `scripts/fault-inject-automation-*.ts`, `scripts/run-automation-smokes.*`, `scripts/e2e-automation-run-now.mjs`, `scripts/probe-production-catalog.mjs` |

Data roots:

- Control: `~/.pi/agent/automations/`  
- Default cwd: `~/pi-automation-cwd` (canonical absolute path persisted once)  
- Automation sessions must **not** appear in ordinary `/api/sessions`

## Next session procedure

### 0. Sanity

```bash
git status
git log -1 --oneline
npx tsx scripts/snflow-task.ts show 07-28-agent-automation
```

If a stray `NUL` file appears (Windows artifact), **delete it; never commit it**.

### 1. Restart SnFlow task for check

```bash
npx tsx scripts/snflow-task.ts start 07-28-agent-automation
npx tsx scripts/snflow-task.ts show 07-28-agent-automation
```

Use the printed `revision` in the dispatch marker.

### 2. Independent check (mandatory)

Dispatch project agent `snflow-check` with:

- `context: fresh`
- `async: false`
- `clarify: false`
- first line exact:

```text
SNFLOW_DISPATCH {"v":1,"taskId":"07-28-agent-automation","phase":"check","revision":"<FROM_SHOW>","cwd":"D:\\workspace\\aiwork\\pi-agnet-web"}
```

Check must **reproduce**, not trust smokes, especially:

1. IPv6 `fe80/fe90/febf` denied; public/`fec0` policy as designed  
2. Reviewed-registry extension authorize → activate → preflight keeps actual schema/hooks; mutation/drift blocks before factory; unapproved catalog sentinel never executes  
3. AppDialog confirmation payload is locale-formatted; no raw English server summary / raw enums as labels  
4. Production `next start` catalog + run-now (invalid auth expected fail; worker artifacts present)  
5. No regression of earlier hardened areas: occurrence claim Windows filenames, fencing/reconcile, hard token ceiling, audit txn ids, merged inbox pagination, worker packaging

Required commands:

```bash
npm run test:automation
npm run test:browser
npm run test:runtime
npm run lint
node_modules/.bin/tsc --noEmit
npm run build
# optional but recommended:
node scripts/probe-production-catalog.mjs
node scripts/e2e-automation-run-now.mjs --mode start
```

Never run bare `next build`.

### 3. If check requests changes

- Only fix true `error` findings  
- Keep scope tight; re-run implement → check loop  
- Do not reopen deferred plan items (daemon/multi-host/RBAC/etc.) unless user asks

### 4. If check passes

Hand commit control to user if more edits landed; then:

```bash
npx tsx scripts/snflow-task.ts complete --hash <git-sha>
npx tsx scripts/snflow-task.ts archive
```

## Historical must-fix themes already addressed (do not regress)

These burned many review rounds; treat as regression-sensitive:

- Direct loopback trust (connection remote, not Host header spoof)  
- Scheduler reconcile of healthy long runs / lease heartbeat  
- Stale leader fencing on materialize/barrier/finalize  
- Abort-ignore isolation + killable worker; seal after dispose  
- Pre-import allowlist / reviewed immutable extension bytes  
- Atomic global concurrency under store lock  
- Windows-safe occurrence claim filenames  
- Atomic run-now gates  
- Terminal run snapshot immutability + separate retention projection  
- Hard total token budget (not post-hoc only)  
- Audit prepare→mutate→commit with transaction ids  
- Worker/discovery standalone runtime artifacts in build/pack  
- Catalog must not execute unapproved factories  

## Known residual risks (advisory unless check proves otherwise)

- Full multi-process dual-server matrix still lighter than ideal  
- Model `maxTokens` still partly provider-dependent; defense is budget wrapper + worker kill  
- Reviewed extension registry is operator-curated fail-closed; empty registry means no third-party extension tools until entries added  
- In-process secret isolation is worker-based; parent process still holds ambient secrets  
- Live model/extension long-running E2E beyond fake/auth-fail path may still be thin  
- SnFlow task docs/revision live only locally (gitignore)

## Explicit non-goals (still deferred)

From the plan — do not expand unless user asks:

- OS daemon execution while Web service is fully stopped  
- Multi-host DB/queue  
- Second-level cron / DAG / generic side-effect retry  
- Unrestricted bash / full OS sandbox  
- Multi-user RBAC / remote non-loopback mode  
- Merging Automation cost into default Usage panel  

## Suggested first message for the new session

```text
继续 SnFlow 任务 07-28-agent-automation。
先读 docs/research/automation-handoff-2026-07-29.md 与 SCHEDULED_AGENT_AUTOMATION_PLAN.md。
不要重做功能；对当前 self-run 最新 commit 跑独立 snflow-check 终检。
若 pass：把 commit hash 记回任务并指导我 complete/archive。
若 changes_requested：只修 error，再 check。
```

## Cleanup notes

- Do not commit Windows `NUL` files if recreated by tools  
- Built artifacts `lib/automation-worker-runtime.cjs` and `lib/automation-extension-discovery-runtime.cjs` (+ `.meta.json`) are part of runtime packaging; rebuild via `npm run build` / worker build scripts if missing  
- Feature is **local-only** first release; non-loopback must fail closed  
