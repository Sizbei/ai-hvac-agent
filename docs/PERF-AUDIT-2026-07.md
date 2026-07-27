# Performance & latency audit — 2026-07 (5-investigator sweep)

Evidence-grounded findings from a parallel read-only audit (DB indexes, query
waterfalls, customer hot path, admin aggregation, client bundle/render), several
EXPLAIN-verified on the dev DB. Ranked into a fix wave. Neon transport note: each
`db.select()` in a `Promise.all` is a **separate HTTPS round-trip**; only
`db.batch()` collapses reads into one call.

## Fix wave (sequenced buckets)

### A — Indexes (migration 0042; additive, EXPLAIN-verified) — HIGHEST ROI
- `invoices`: `(org, coalesce(issued_at,created_at) DESC)` expr; `(customer_id) WHERE NOT NULL`; `(org, state)` — default list Seq Scans 2,853 rows today (~13ms), full scan per customer panel.
- `service_requests`: `(org, arrival_window_start) WHERE NOT NULL` (board/calendar/conflict/signals); `(org, assigned_to, status) WHERE assigned_to NOT NULL` (signal aggregates); `(org, status)` (dashboard counts); exceptions partial `(org, created_at) WHERE assigned_to IS NULL AND auto_dispatch_outcome LIKE 'queued_%' AND status NOT IN ('completed','cancelled')`.
- `dispatch_decisions`: `(org, created_at)`.
- `request_status_events`: `(org, to_status, at)` (operations response-time).
- `payments`: `(org, created_at)` — **no org index exists today**.

### B — Chat hot path (chat/route.ts, provider.ts) — highest customer-facing
- `recordBotEvent` on the LLM path: bare `await` → `after()` (deterministic path already does).
- `resolveModelEntry` called twice (once for telemetry, once inside `getModel`) → resolve once, build model from the entry.
- Parallelize the independent per-turn reads (history + CRM context + after-hours) — **verify independence rigorously; hottest path in the app**.
- `enrichWithServiceHistory` (HCP HTTP) blocks first token for returning customers → defer to `after()` + cache the note in session metadata (one-turn lag). Voice already skips it.

### C — Booking path (submit-session-request.ts)
- `recordCustomerEquipment` + `recordStatusEvent`: bare `await` → `after()` (both already best-effort/catch).
- Start the org-settings (after-hours) read concurrently with the customer upsert.

### D — Dispatch queries (scheduling-queries.ts, signals.ts)
- `placeAndAssignRequest`: parallelize `checkScheduleConflict` + `getTechnicianAvailability` (2 call-sites) — runs per-tech in the auto-assign loop + every drag.
- `autoAssignBookedRequest`: merge `isExternallyScheduled` + `isAutoDispatchEnabled` into one settings read; parallelize techs read + `ensureEstimatedDuration`.
- `loadDispatchSignals`: merge `loadRows` (sameDayJobCount) + `bookedRows` (bookedMinutes) — identical WHERE, two scans → one grouped query; collapse the two Promise.all batches.

### E — Admin aggregation (reporting/ai-insights/ops-insights + routes)
- reports: inner `Promise.all` → `db.batch` in each of the 4 functions (18 round-trips → 4); route `unstable_cache` (5-min, org-tagged).
- ai-insights: `Promise.all` → `db.batch` (9→1); add 90-day date bound; `unstable_cache` 5-min. (LIKE `%vote%` on audit_log flagged for a later counter column.)
- ops-insights: date-bound the 5 unbounded all-time scans (90-day param); `unstable_cache` 5-min.

### F — Client wins
- `EstimateCreateDialog`: `new Map(items.map…)` over up to 20k items rebuilt every keystroke → `useMemo([items])`.
- `useAdminRequests` + `useAdminConversations`: skip `setState` when a poll returns semantically-identical data (total + first/last id sentinel) — stops 10s re-render storms.
- `useMonthCalendar`: `isFetchingRef` drop-guard → `runRef` latest-wins (rapid month-step drops the newer request today).
- Raw `fetch` → `adminFetch` in ops-insights-section, dispatch-map, insights page (401→login handling).
- maplibre CSS static import → load only on the map route.

## Deferred / needs decision (recorded, not in this wave)
- **Chat streaming vs output guardrail (VERY HIGH perceived latency).** The route buffers the full LLM reply before the first byte so `screenAssistantReply` can block unsafe replies (price quotes / false booking confirmations) before they're shown. Streaming would change the guarantee from "never shown" to "shown then replaced" — a **safety/product decision**, not a perf fix. Surfaced to the user; excluded from autonomous work.
- Voice incoming/gather parallelization + `.returning()` to drop a re-read (good; voice lower-traffic than chat).
- `addRequestNote` / `suggestTechnicians` parallelize (admin, low frequency).
- Dashboard correlated-subquery → JOIN (PK lookups at list-limit; micro).
- ai-insights feedback LIKE → dedicated counter/JSONB (needs schema).
