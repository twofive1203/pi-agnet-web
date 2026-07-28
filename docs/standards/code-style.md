# Code, Comment, and Test Standards

This is the project standards entry point. Prefer existing local patterns over broad rewrites.

## Code Style

- TypeScript is strict (`tsconfig.json`); avoid `any` unless a boundary is truly dynamic and document why.
- Use the `@/*` path alias for project-root imports when it improves clarity.
- Keep route-specific logic in `app/api/.../route.ts`; move reusable parsing, validation, and cross-route behavior to `lib/`.
- Keep UI state orchestration in hooks, especially `hooks/useAgentSession.ts` for chat/session behavior.
- Follow nearby component style for React props, local state, and event handlers.
- Before changing constants, event kinds, JSONL fields, config fields, or shared helpers, search the repository for existing uses.

## Comment Style

- Comment non-obvious behavior: lifecycle invariants, external protocol compatibility, security/trust boundaries, or intentionally surprising workarounds.
- Do not add comments that only repeat what the next line of code says.
- Keep comments close to the code they explain and update them when behavior changes.
- Use TODO/FIXME only when there is a clear follow-up condition or owner/context.

## Validation Commands

```bash
npm run lint
node_modules/.bin/tsc --noEmit
```

Do not run `next build` directly during development. Use `npm run build` only for release/publish validation because it is wrapped by `scripts/build-next.js`.

## Tests

There is no full app test framework. Targeted smoke scripts cover high-risk flows:

```bash
npm run test:browser   # browser binding protocol/manager + chrome-tab-debug artifact harness
npm run test:runtime   # Next server externals + published launcher invariants
```

For other data-flow changes, use lint + type-check and manually verify the affected browser/API flow. Headed Chrome-only gaps for the tab-debug extension are listed in `docs/operations/troubleshooting.md`.

## SnFlow Specs

When a coding task uses SnFlow, load the project specification indexes under `.pi/snflows/spec/` (start at `index.md`, then the relevant frontend/backend/guides layer) before editing. Those specs guide implementation and review for the active workspace; durable user-facing project knowledge still belongs in `docs/`. Legacy `.trellis/` data is not the supported coding-spec source.
