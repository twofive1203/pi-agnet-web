# Smoke test: trellis-implement workflow

## Goal

Add a `formatRelativeTime` utility function to `lib/` that converts a `Date` or timestamp into a human-readable relative time string (e.g., "3 minutes ago", "2 hours ago"). This is a smoke test to verify the Trellis task lifecycle works correctly.

## Requirements

1. Create `lib/relative-time.ts` with an exported `formatRelativeTime(input: Date | number): string` function
2. Support time ranges: seconds, minutes, hours, days, months, years
3. Return `"just now"` for intervals under 10 seconds
4. Pure function with no external dependencies
5. Include a basic test file `lib/relative-time.test.ts` using the project's test patterns (if any exist)

## Acceptance Criteria

- [ ] `lib/relative-time.ts` exists and exports `formatRelativeTime`
- [ ] TypeScript type-check passes (`tsc --noEmit`)
- [ ] ESLint passes (`npm run lint`)
- [ ] Function handles edge cases: future dates, zero, very old dates

## Notes

- Keep it simple — this is a smoke test, not a production feature
- No i18n needed; English output only
