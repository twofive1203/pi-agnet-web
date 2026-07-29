# Automation conventions

- Keep Automation independent of SnFlow storage (`.pi/snflows/`).
- UI routes and `automation_tasks` must call `lib/automation-service.ts` only.
- Never load `automation_tasks` into scheduled-origin sessions.
- Persist `execution_may_have_started` before extension import/session/model side effects.
- Fail closed on tool drift; never fall back to dynamic `all`.
