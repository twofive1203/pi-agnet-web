# Implement: Model Pricing Manual Sync

## Checklist

1. Add shared pricing cache types, validation, atomic persistence, and lookup logic in `lib/model-pricing.ts`.
2. Add `GET`/`POST` route at `app/api/model-pricing/route.ts`.
3. Add pricing summary/manual-sync state and controls to `components/ModelsConfig.tsx`.
4. Auto-apply cached prices for manually entered and discovered models without overwriting manual values.
5. Return ambiguous provider/model/cost candidates and add a manual pricing match dialog.
6. Add a searchable, provider-filterable local pricing catalog viewer.
7. Update API/frontend/integration/top-level docs.
8. Validate helper behavior, `npm run lint`, and `node_modules/.bin/tsc --noEmit`.

## File Touch List

- `lib/model-pricing.ts` (new)
- `app/api/model-pricing/route.ts` (new)
- `components/ModelsConfig.tsx`
- `components/ModelPricingCatalog.tsx` (new)
- `docs/modules/api.md`
- `docs/modules/frontend.md`
- `docs/integrations/README.md`
- `AGENTS.md`
