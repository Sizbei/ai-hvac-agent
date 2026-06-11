# Roadmap v2.0: Stealing Housecall Pro's Thunder

## Phase 5: Unbeatable Speed & UX
- **Goal**: Make the app feel instant, fixing the "slow" navigations that plague traditional SPA dashboards like Housecall Pro.
- **Tasks**:
  - [ ] Enable `cacheComponents` and `instantNavigationDevToolsToggle` in `next.config.ts`.
  - [ ] Implement `export const unstable_instant = { prefetch: 'static' }` on dynamic routes.
  - [ ] Wrap uncached async operations (like DB queries) in `<Suspense>` boundaries.

## Phase 6: Agentic Dispatch & Routing
- **Goal**: Autonomous routing and technician assignment.
- **Tasks**:
  - [ ] Add `skills` and `location` columns to technicians table.
  - [ ] Create an AI background worker that listens for new requests and assigns the best technician.

## Phase 7: Deep Customization (CRM)
- **Goal**: Flexible CRM that Housecall Pro lacks.
- **Tasks**:
  - [ ] Add `custom_fields` JSONB column to `organizations` and `customers`.
  - [ ] Dynamic forms based on organization configuration.
