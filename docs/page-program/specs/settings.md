# settings — target-state spec

`/admin/settings` (9-tab org configuration) · `/admin/settings/billing` (own-org
subscription).

## 1. Purpose

Let an org admin configure everything that shapes the AI assistant's identity,
scope, and operating limits — branding, offered services, business facts,
custom Q&A, embed keys/allowed domains, conversation limits, after-hours
detection, auto-dispatch policy, and third-party integration credentials —
plus let the org's owner (super_admin) manage the org's own platform
subscription. One job: a single, safe place to make the bot and the back
office behave the way the business actually works, where every save either
takes real effect or doesn't exist as a field.

## 2. Brainstorm

Considered, and what shipped or got cut:

- **Per-panel save, not one giant form** — shipped (`use-org-settings.ts:73-95`,
  each panel owns local state + a Save button). Rejected: a single page-wide
  form, since 9 tabs of unrelated fields sharing one dirty/save state means
  an edit on one tab risks re-saving stale data from another. verified.
- **Self-hiding panels driven by the server, not a client role check** —
  shipped: `AiModelPanel`/`BillingLinkPanel`/`PlatformLinkPanel` probe their
  gated endpoint and render `null` on 403/401 (`ai-model-panel.tsx:53-77`,
  `billing-link-panel.tsx:20-38`). Rejected: branch on `session.role` in the
  page. Reason: the page has no session prop today, and a client check
  drifts from the server's real gate. verified.
- **Write-only integration credentials, live-validated before persisting** —
  shipped for Housecall Pro / Fieldpulse (`housecall-pro-panel.tsx:35-38`;
  server probes the real API before saving, `housecall/connect/route.ts:
  65-82`). Rejected: trust a pasted key unchecked — a typo'd key would
  silently break sync until someone noticed. verified.
- **Widget secret shown exactly once, never re-readable** — shipped
  (`widget-keys/route.ts:96-100`; list query selects `keyPrefix`, never
  `keyHash`, `key-queries.ts`). Rejected: let an admin re-view a key — a
  re-displayable secret is one a hijacked session can steal later. verified.
- **Structured business-info fields that personalize canned FAQ replies**,
  not a freeform bio fed to the LLM — shipped for `phone`/`serviceArea`/
  `businessHours`/`licensedInsured`/`paymentMethods`/`financingAvailable`
  (`router-config.ts:128-176`, one `case` per intent). Rejected: one
  freeform textarea — unstructured prose in the trusted identity block is
  exactly what the guardrail architecture (page-chat spec) keeps out.
  verified.
- **A real IANA-timezone, hour-of-day after-hours window**, not a parse of
  the display `businessHours` string — shipped (`after-hours.ts:25-35,
  76-91`, real `Intl.DateTimeFormat` math). Rejected: derive after-hours
  from `businessHours` prose, which has no parseable grammar. verified.
- **One generic PATCH endpoint for all non-FAQ config** — shipped
  (`api/admin/settings/route.ts:34-79`). Rejected: one endpoint per tab —
  every field shares the same tenancy scope, audit action, and partial-patch
  semantics (`org-config-queries.ts:66-92`); a 9-way split would be nine
  copies of the same boilerplate. verified.
- **`positioning`/`serviceScope`/`voiceCues` business-info extension** — NOT
  built. `system-prompt.ts:131-144` already reads these "opportunistically"
  for a *future* extension (its own doc comment) — no schema field, no UI.
  Rejected here: no evidence any org needs a bespoke brand voice today;
  wiring UI ahead of a real request is the speculative work YAGNI blocks.
- **Structured per-day business-hours editor, FAQ bulk import/export, and a
  per-tab "last edited by" trail** — all rejected. The after-hours window is
  already structured separately; `businessHours` is only echoed as prose in
  one FAQ reply. `MAX_CUSTOM_FAQS = 100` is hand-editable. The org-wide
  Audit log page already renders every settings/FAQ/integration action.

## 3. Current state

**Pages** (verified): `settings/page.tsx` — client page, `useOrgSettings()`
drives a 9-tab `Tabs` (`:61-99`); loading state is two `Skeleton`s while
`isLoading || !config` (`:55-59`); `integrations` tab stacks 6 panels, 3
self-hiding (`:139-152`). `settings/billing/page.tsx` — server component,
`getAdminSession()` then `isSuperAdmin || isPlatformAdmin` else
`redirect('/admin/settings')` (`:14-18`).

**Data flow** (verified): `use-org-settings.ts` fetches
`/api/admin/settings` + `/api/admin/settings/faqs` in parallel on mount
(`:42-45`, both eager regardless of active tab); every mutation surfaces a
human error string via `readError` (`:26-29`, reads `body.error.message`,
never `err.message`). `api/admin/settings/route.ts` `PATCH` validates the
full body against `orgConfigUpdateSchema.strict()` (`org-config-types.ts:
82-127`, every field optional so a partial save never clobbers unrelated
fields — `org-config-queries.ts:66-92` only writes present keys), then
`logAudit({action:"update_settings", details: {fields: Object.keys(...)}})`
(`route.ts:62-69`) — field NAMES only, never values. GET/PATCH are
rate-limited per-user and 401 on no session — no role gate beyond "is an
admin" (see Gsettings-2). FAQs have their own `GET`/`POST`/`PATCH`/`DELETE`,
same scoping/rate-limit/audit pattern (entity-id only, never question/answer
text), `MAX_CUSTOM_FAQS = 100` enforced at create (`faqs/route.ts:15,68-74`).
`updateOrgConfig` upserts on the org PK and eagerly invalidates a 60s
in-memory router-config cache on every write/FAQ-CRUD
(`org-config-queries.ts:119,135-137,216,241,258`) — the page-settings
skill's "changes go live immediately" claim is real at the cache layer, not
just an assumption.

**Every tab traced to a live consumer** (verified, not just a writer):
branding's `companyName`/`primaryColor`/`logoUrl`/`launcherPosition` feed
`api/widget/config/route.ts:77`; `welcomeMessage` drives the persisted first
session message (`system-prompt.ts:98-116` → `api/session/route.ts:
109-134`). Services' `disabledIssueTypes`/`disabledServiceTags` feed
`getRouterConfig` (`org-config-queries.ts:158-167`) and gate the router's
offer/decline logic. Business info's `serviceArea`/`businessHours`/`phone`/
`licensedInsured`/`paymentMethods`/`financingAvailable` each have a
`personalizeAnswer` case (`router-config.ts:138-172`); `phone`/`serviceArea`
additionally feed the LLM identity block via `brandInfoFromConfig`
(`system-prompt.ts:134-146`) — `website`/`email` do NOT, see Gsettings-1.
Custom Q&A's active FAQs feed `getRouterConfig`'s `customFaqs`, matched by
`matchCustomFaq` before the built-in KB (`router-config.ts:104-120`).
Embed's `allowedOrigins` gates `frame-ancestors` in `proxy.ts:25-49`
(page-chat spec); widget keys are created/revoked via
`api/admin/widget-keys` (secret shown once, `route.ts:96-100`). Limits'
`chatTokenBudget`/`chatMaxTurns` feed `resolveTokenBudget`/
`resolveMaxTurns` (`chat-limits.ts:26-46`) at session creation. After-hours'
full config is the direct input to `isAfterHours` (`after-hours.ts:76-91`),
consumed by the chat route for disclosure/flagging (`api/chat/route.ts:
594-604,1482,1775`). Dispatch's `autoDispatchEnabled` is read at
`scheduling-queries.ts:1271-1291` to switch scored-vs-first-fit assignment.
Integrations: Google/Housecall/Fieldpulse connect against separate
credential tables, write-only for the secret, live-validated before
persisting (`housecall/connect/route.ts:65-82`); `AiModelPanel` writes
`organizationSettings.aiModelId`, read by the model registry at chat time
(super_admin-gated both ways, `ai/model/route.ts:7,30-32,60`).

**Secret handling** (verified): widget secrets shown once, list endpoint
selects `keyPrefix` only, never `keyHash` (`key-queries.ts:119-132`);
Housecall/Fieldpulse keys are `type="password"`, cleared from component
state on success (`housecall-pro-panel.tsx:85`), never returned by status
endpoints; connect-route catch blocks skip logging the raw error body
"because it could echo the key" (`housecall/connect/route.ts:76`).

**Role gating** (verified): `AiModelPanel`'s endpoint requires
`isSuperAdmin` (`ai/model/route.ts:30-32`); billing/platform links require
`isSuperAdmin || isPlatformAdmin` (`platform/billing/route.ts:36-39`,
`billing/page.tsx:16`). Every OTHER settings write — branding through
dispatch, AND all three integration-credential connects/disconnects — needs
only `getAdminSession()` returning non-null (any admin-tier session;
technician never holds one, `authz.ts:14`). See Gsettings-2.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Gsettings-1: `businessInfo.website` is editable, saves successfully, and does nothing | P1 | `business-info-panel.tsx:111-119` renders a "Website" field, saves via `onSave({businessInfo})`, shows the same "Saved" checkmark as every other field (`:61-67`). It round-trips through the schema correctly (`org-config-types.ts:74`, `org-config-queries.ts:47`) but is never read: `personalizeAnswer`'s switch (`router-config.ts:138-175`) and `brandInfoFromConfig`'s `BrandInfo` mapping (`system-prompt.ts:134-146`) both omit it; grepping `src/lib/ai` for `businessInfo.website`/`biString(businessInfo, "website")` returns nothing. An admin who fills this in has no way to discover the bot never uses it — the UI gives an explicit success signal for a no-op write. |
| Gsettings-1b: `businessInfo.email` is a validated schema field with no way to set it and no consumer | P2 | `org-config-types.ts:70` defines `email` with a comment claiming it is "surfaced in canned replies / the LLM brand block" — but `business-info-panel.tsx` has no `email` state or field anywhere (`:31-41`), so no UI path sets it; like `website`, no consumer exists in `src/lib/ai`. Lower severity than Gsettings-1: unreachable through the product, so it's a false doc comment on dead schema, not an operator-facing lie. |
| Gsettings-2: Google Calendar / Housecall Pro / Fieldpulse credential connect+disconnect require only an admin session, not `super_admin` — inconsistent with this page's own precedent for equally sensitive actions | P1 | `housecall/connect/route.ts:8` ("Admin-session-gated") and `:41-44` (`getAdminSession()` only); `fieldpulse/connect/route.ts:8,44-47` identical; `google/route.ts:7,23-26,42-45` identical. Each lets ANY admin overwrite the org's external CRM/calendar credential — an encrypted secret that, once connected, syncs customers/jobs/invoices or writes calendar events for the whole org; disconnecting can silently stop that sync. Compare `ai/model/route.ts:7,30-32` (lower blast radius, IS `isSuperAdmin`-gated) and `platform/billing/route.ts:11-14,36-39` (docstring calls billing "an account-owner concern," gated on `isSuperAdmin \|\| isPlatformAdmin` for that reason). The same reasoning applies at least as strongly to swapping the org's CRM-of-record, but the code doesn't apply the same gate. |
| Gsettings-3: Embed snippet hardcodes the production domain instead of the app's own base-URL env var | P2 | `embed-panel.tsx:71` builds the copy-paste `<script>` snippet from a string literal (`ai-hvac-agent-lovat.vercel.app`), while the repo already has `NEXT_PUBLIC_APP_URL` for exactly this (`session-csrf.ts:47-49`, `money-triggers.ts:300`). Low impact today (single production deployment), but would silently misdirect every org's widget if the app ever moved domains or ran a staging widget-test flow. |

That's the full list. Everything else — the per-panel save model, the
after-hours/limits/dispatch/services/FAQ pipelines, secret handling for
widget keys and integration credentials, and the billing/AI-model role
gates that DO exist — is solid and evidenced above; this spec does not
invent additional work to pad it out.

## 5. Requirements

Only Gsettings-1 and Gsettings-2 clear the P0/P1 bar (Gsettings-1b and
Gsettings-3 are P2, recorded above, left in the backlog per METHOD.md).

- **Rsettings-1**: Every field the Business info panel lets an admin save
  must have a real, traceable consumer, or must not be presented as a
  working field. Wire `businessInfo.website` into `brandInfoFromConfig`'s
  `BrandInfo` mapping the same way `phone`/`serviceArea` already are (via
  the existing `biString` helper) — smaller and more surgical than a new
  FAQ intent. Remove the unreachable `email` field from
  `businessInfoSchema` (`org-config-types.ts:70`) and its false doc comment
  (Gsettings-1b) rather than build a UI + intent for a field with zero
  evidence of demand — matches the spec's own YAGNI stance on
  `positioning`/`serviceScope`/`voiceCues`.
  **Acceptance criterion**: `grep -rn "website" src/lib/ai` finds a live
  `BrandInfo` consumer; `businessInfoSchema`/`OrgConfigUpdate`/`OrgConfig`/
  `DEFAULT_ORG_CONFIG` no longer have an `email` key; a new pure-function
  vitest case proves a saved `website` value changes `brandInfoFromConfig`'s
  output for a representative input.
- **Rsettings-2**: Connecting or disconnecting a Google Calendar, Housecall
  Pro, or Fieldpulse credential requires `isSuperAdmin(session)`, mirroring
  the existing gate on AI model choice and billing. A non-super_admin admin
  gets a clean 403 (`errorResponse("Forbidden", "FORBIDDEN", 403)`, same
  shape `ai/model/route.ts` returns); the corresponding panel self-hides via
  the SAME probe-and-render-null pattern `AiModelPanel` already uses
  (`ai-model-panel.tsx:53-77`) — not a new client-side role branch.
  **Acceptance criterion**: `GET`/`POST`/`DELETE` connect/status/disconnect
  routes for all three integrations 403 for a non-super_admin admin session
  and succeed for a super_admin session, covered by request-level tests
  (new or extending each integration's existing route tests). The three
  panels render `null` for a non-super_admin admin — reuse `AiModelPanel`'s
  existing pattern verbatim, no new one to test.

## 6. Non-goals

- Not building UI for `positioning`/`serviceScope`/`voiceCues` — Brainstorm,
  YAGNI (documented future extension point, not broken behavior).
- Not building a structured per-day business-hours editor or FAQ bulk
  import/export — Brainstorm, YAGNI.
- Not adding a per-tab audit trail UI — Brainstorm, redundant with the
  existing Audit log page.
- Not touching after-hours time-math, the router's deterministic matching,
  or the guardrail/system-prompt architecture beyond the one additive
  `BrandInfo` field Rsettings-1 needs — see Invariants.
- Not extending Rsettings-2's role gate to branding/services/business-info/
  FAQs/embed-keys/limits/after-hours/dispatch — those are ordinary
  operational config any admin plausibly owns day-to-day (`authz.ts:69-85`:
  an admin manages operational things, only a super_admin manages other
  admins or account-owner concerns). Only the three integration-credential
  flows get the new gate, because only those are comparable in kind to the
  two surfaces (AI model, billing) that already have it.
- Gsettings-1b and Gsettings-3 (P2) stay in the backlog per METHOD.md's
  severity gate; not implementation work in this run.

## 7. Invariants

- Tenancy: every settings/FAQ/widget-key/integration read or write is
  scoped by `session.organizationId`, never a hardcoded org
  (`api/admin/settings/route.ts:26,60`). Rsettings-1/2 must not introduce an
  unscoped query.
- Audit logging stays field-names-only, never values: `update_settings`
  logs `Object.keys(parsed.data)` (`route.ts:69`); integration
  connect/disconnect audits log non-secret identifiers only. Any new audit
  entry Rsettings-2 needs must follow the same shape.
- Secrets are write-only and shown at most once (`widget-keys/route.ts:
  96-100`; `*-panel.tsx` clear-on-success). Rsettings-1/2 touch neither flow
  and must not add a path that echoes a stored secret back to the client.
- FROZEN safety text & guardrail regexes in `src/lib/ai`/
  `output-guardrail.ts` are untouchable. Rsettings-1's `BrandInfo` addition
  must go through the existing `biString`/`clean` sanitization
  (`system-prompt.ts:44-48,118-125`) like `phone`/`serviceArea` already do —
  never interpolate a raw, untrimmed value into the prompt.
- Self-hiding panels stay server-authoritative — a panel probes its real
  endpoint and renders `null` on 401/403 (`ai-model-panel.tsx:53-77`).
  Rsettings-2 extends this to three more panels; no client-side
  `session.role === …` branch in the page component.
- `organizationSettings.businessInfo` stays a `.strict()` zod-validated
  JSONB bag — Rsettings-1's removal of `email` must update
  `businessInfoSchema`, `BusinessInfo`, `DEFAULT_ORG_CONFIG`, and any test
  fixture that sets `businessInfo.email`.
- The 60s router-config cache is invalidated eagerly on every write
  (`org-config-queries.ts:119,135-137`) — any new write path must call
  `invalidateRouterConfig` too, though neither requirement here adds one.

## 8. Verification

- `npx tsc --noEmit` → 0.
- `npx eslint src/components/admin/settings/business-info-panel.tsx src/components/admin/settings/google-calendar-panel.tsx src/components/admin/settings/housecall-pro-panel.tsx src/components/admin/settings/fieldpulse-panel.tsx src/lib/admin/org-config-types.ts src/lib/admin/org-config-queries.ts src/lib/ai/system-prompt.ts src/app/api/admin/integrations/google/route.ts src/app/api/admin/integrations/housecall/connect/route.ts src/app/api/admin/integrations/housecall/disconnect/route.ts src/app/api/admin/integrations/fieldpulse/connect/route.ts src/app/api/admin/integrations/fieldpulse/disconnect/route.ts` → 0 errors.
- `npx vitest run` → must not drop below the live baseline recorded in
  `docs/page-program/README.md`.
- Regression pack: `npx vitest run src/lib/ai/system-prompt.test.ts src/lib/admin/org-config-queries.test.ts src/lib/admin/after-hours.test.ts` —
  extend whichever file already covers `brandInfoFromConfig` rather than
  adding a new one (no jsdom/RTL — pure-helper only).
- New pure-function unit tests: (a) a saved `website` value changes
  `brandInfoFromConfig`'s output (Rsettings-1); (b)
  `businessInfoSchema.safeParse({..., email: "x@y.com"})` now fails, proving
  the field is really gone (Rsettings-1).
- Route-level auth tests: a mocked non-super_admin admin session hitting
  `POST .../housecall/connect`, `POST .../fieldpulse/connect`,
  `DELETE /api/admin/integrations/google`, and their disconnect
  counterparts all return 403; a mocked `super_admin` session succeeds
  (Rsettings-2).
- Manual/visual: `npm run dev` (background) → mint a non-super_admin admin
  session, screenshot `/admin/settings` Integrations tab via
  `node scripts/agent/screenshot-page.mjs /admin/settings`, confirm the
  three integration panels are gone; mint a super_admin session and
  re-screenshot to confirm they reappear. Save the Business info panel's
  website field, confirm "Saved," then confirm the value is actually used.
