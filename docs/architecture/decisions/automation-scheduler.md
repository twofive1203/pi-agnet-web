# ADR: Automation scheduler and isolated run sessions

- Status: Accepted
- Date: 2026-07-28

## Context

Snail Pi Web needed recurring, headless Agent jobs with UI and interactive-tool parity, without polluting ordinary project sessions or SnFlow storage.

## Decision

1. **Independent domain** under `getAgentDir()/automations/` (not `.pi/snflows/`, not ordinary `sessions/`).
2. **File store + locks**: versioned `tasks.json`, per-run snapshots, occurrence claim journal, `store.lock` and `scheduler.lock` with epoch fencing.
3. **Online execution model**: scheduler starts from Next `instrumentation.ts` Node runtime; schedules run only while the web service process is alive. Misfire uses a 5-minute fire-once window; older misses become aggregate omission records.
4. **Frozen authority snapshots ∩ live policy**: no dynamic `all` fallback; unapproved extensions are filtered before import/factory; bash/subprocess blocked in v1.
5. **Local-only HTTP**: `/api/automations/**` requires direct loopback, same-origin, and HttpOnly control session; browser mutations use two-step one-time approval challenges (summary → AppDialog → confirm → secret → consume). Ordinary localhost create+mutate without the confirm step fails closed. This is not multi-user identity auth — the realistic trust boundary is local process ownership of the Snail Pi Web service. Agent tool uses trusted `ctx.ui.confirm`.
6. **Isolated sessions + promote**: Automation JSONL lives under `automations/sessions/`; promote copies sealed transcripts into ordinary project session dirs without rewriting terminal run snapshots.

## Consequences

- Operators must keep Snail Pi Web running for timely cron execution.
- Multi-host/shared DB schedulers are out of scope for v1.
- Unrestricted subprocess tools remain blocked until a stronger isolation profile exists.
