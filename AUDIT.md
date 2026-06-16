# Fieldpulse Integration & Platform Security Audit — Executive Report

## 1. Overall Risk Assessment

The codebase is broadly sound on its core multi-tenancy contract (most reads/writes correctly use `withTenant`), but the newly-added Fieldpulse and communications subsystems introduce a cluster of confirmed, exploitable defects that bypass that contract. The most urgent issues are two functional dead-ends that silently break the entire outbound communications pipeline (a wrong-table column reference and a broken Twilio import), an unauthenticated/fail-open Fieldpulse webhook surface that can forge billing state when no secret is configured, and a cross-tenant write on `/api/admin/service-requests/[id]/reschedule` that lets any admin reschedule any org's request by UUID. These are compounded by structural gaps — no index on `fieldpulse_job_id`/`hcp_job_id`, a globally-unique `google_id` index being reused for per-org Fieldpulse IDs, and plaintext PII in `communication_jobs` — that turn coincidental collisions into silent cross-tenant corruption. None of the confirmed criticals require sophisticated attacker capability; several are reachable by any authenticated admin or, in the webhook case, any caller who can discover a Fieldpulse job ID.

## 2. Severity Summary (Confirmed)

| Severity | Count |
|----------|-------|
| CRITICAL | 3 |
| HIGH | 9 |
| MEDIUM | 11 |
| LOW | 6 |
| **Total** | **29** |

(CRITICAL/HIGH counts reflect adversarial-verification verdicts: two findings the auditor filed CRITICAL were confirmed but downgraded to HIGH; they are listed under HIGH below. Duplicates merged.)

## 3. Confirmed CRITICAL and HIGH Findings (deduplicated)

### C1. Every SMS/email send throws — wrong-table column in template lookup
- **Severity:** CRITICAL
- **File:** `src/lib/communication/job-queue.ts:165-167`
- **Explanation:** `sendCommunication()` queries `db.query.communicationTemplates.findFirst` but passes `eq(communicationJobs.templateId, job.templateId)` — a column from the *jobs* table — producing `WHERE communication_templates.template_id = ?`, which does not exist on that table. Every pending job throws, is retried to `maxAttempts`, then permanently fails. No SMS or email is ever delivered through the queue.
- **Fix:** Import `communicationTemplates` from schema and change the predicate to `eq(communicationTemplates.id, job.templateId)`.

### C2. Cross-tenant reschedule — no org filter on read or write
- **Severity:** CRITICAL
- **File:** `src/app/api/admin/service-requests/[id]/reschedule/route.ts:49-67`
- **Explanation:** The handler fetches with `eq(serviceRequests.id, serviceRequestId)` and updates with the same bare predicate — neither includes `organizationId`. Any authenticated admin from any org can reschedule (and the 404 path oracles the existence of) another org's request by supplying its UUID. The canonical `/api/admin/requests/[id]/reschedule` route correctly uses `withTenant`; this duplicate was never hardened.
- **Fix:** Add `eq(serviceRequests.organizationId, session.organizationId)` to both the fetch and update WHERE clauses, or delegate to the existing `withTenant`-scoped query helper.

### H1. Fieldpulse webhooks fail open + unauthenticated when no secret configured
- **Severity:** HIGH (filed CRITICAL by area; merges two findings on the same root cause)
- **File:** `src/lib/integrations/fieldpulse/webhook-signature.ts:81-85` (reached via `webhook/route.ts:225` and `invoice-webhook/route.ts:127`)
- **Explanation:** `verifySignature()` returns `{valid: true, reason: 'no_secret_configured'}` when no secret is set, and neither webhook route has an admin-session guard (no `middleware.ts` exists; `middleware-manifest.json` is empty). If `FIELDPULSE_WEBHOOK_SECRET` is unset and the org has no per-org secret, any caller who knows a valid `fieldpulseJobId` can forge `invoice.paid`/status events. The HCP webhook fails *closed* in the same situation — the asymmetry is real.
- **Fix:** Make the no-secret branch return `{valid: false}` (fail-closed) in production; gate any dev escape hatch on `NODE_ENV !== 'production'`. Add a startup assertion that `FIELDPULSE_WEBHOOK_SECRET` is set when Fieldpulse connections exist.

### H2. Cross-tenant invoice mutation — `syncInvoiceStatus` ignores org (and the invoice-webhook UPDATE)
- **Severity:** HIGH (filed CRITICAL by two areas; merged — same root cause)
- **File:** `src/lib/integrations/fieldpulse/invoice-sync.ts:87-93` (SELECT) and `:113-125` (UPDATE); same pattern at `src/app/api/admin/integrations/fieldpulse/invoice-webhook/route.ts:93-100, 159-170`
- **Explanation:** The lookup filters on `fieldpulseJobId` alone; the passed `organizationId` is used only for the audit log, never as a query filter. `fieldpulse_job_id` has no unique constraint at any scope, so a cross-tenant collision resolves and mutates the wrong org's `invoiceStatus` while the audit entry records the caller's org — a silent cross-tenant write with a misleading trail.
- **Fix:** Add `eq(serviceRequests.organizationId, organizationId)` (or `withTenant`) to both the SELECT and UPDATE in `syncInvoiceStatus` and in the invoice-webhook route, plus a UNIQUE partial index on `(organization_id, fieldpulse_job_id) WHERE fieldpulse_job_id IS NOT NULL`.

### H3. No index on `service_requests.fieldpulse_job_id` / `hcp_job_id` — webhook lookup is a full scan
- **Severity:** HIGH
- **File:** `src/lib/db/schema.ts:464-474`
- **Explanation:** The table indexes org_id, session_id, status, referenceNumber, customerId — but neither job-ID column. Every inbound Fieldpulse and HCP webhook resolves the row via `eq(serviceRequests.fieldpulseJobId, …)` / `hcpJobId`, producing a sequential scan per delivery. Under burst webhook volume this drives latency spikes and Neon connection exhaustion.
- **Fix:** Add partial indexes `requests_fieldpulse_job_id_idx` and `requests_hcp_job_id_idx` (`WHERE … IS NOT NULL`) via a migration; the per-org UNIQUE partial index from H2 also satisfies this.

### H4. `users.google_id` global unique index reused for per-org Fieldpulse IDs
- **Severity:** HIGH
- **File:** `src/lib/db/schema.ts:244-246`; write at `technician-sync.ts:94`
- **Explanation:** Technician sync writes the Fieldpulse user ID into `users.googleId`, which has a *global* unique partial index. Fieldpulse assigns sequential per-account IDs (1, 2, 3…), so any second org with overlapping IDs hits the constraint; the `onConflictDoUpdate` targets `(organizationId, email)` and does not catch it, so the violation throws and is swallowed at WARN — the entire org's technician sync fails silently every run.
- **Fix:** Add a dedicated nullable `fieldpulse_user_id` column with a per-org unique partial index `(organization_id, fieldpulse_user_id)`, and update `technician-sync.ts`/`availability-sync.ts` to use it. Leave `google_id` untouched for OIDC.

### H5. `communication_jobs` stores recipient phone/email as plaintext PII
- **Severity:** HIGH
- **File:** `src/lib/db/schema.ts:1387-1388`; bare `.select()` at `job-queue.ts:76-86`
- **Explanation:** `recipientPhone` and `recipientEmail` are cleartext while every other PII field in the schema is AES-256-GCM encrypted. Every queued SMS/email writes a job row, so any DB read, backup, or query-log leak exposes the phone/email corpus. The job processor's bare `SELECT *` loads all recipient PII into memory with no column projection.
- **Fix:** Encrypt both columns with the existing `encrypt()`/`decrypt()` pattern (or resolve recipient from `customerId` at send time), and project explicit columns in `processPendingJobs`.

### H6. Twilio delivery-status webhook — broken `validateRequest` import rejects every callback
- **Severity:** HIGH
- **File:** `src/lib/communication/twilio-adapter.ts:171`
- **Explanation:** `require('twilio/lib/jwt/taskrouter').validateRequest` resolves a directory with no `index.js` → `MODULE_NOT_FOUND` at runtime (verified by execution). The catch returns `false`, so every Twilio delivery webhook is rejected with 403 and `communication_jobs` is never updated with real delivery state. Correct path is `twilio/lib/webhooks/webhooks`.
- **Fix:** Use the existing, tested `validateTwilioSignature()` from `src/lib/voice/twilio-signature.ts` (or the correct `twilio/lib/webhooks/webhooks` import). Also pass the forwarded public URL, not `request.url`.

### H7. Resend webhook HMAC keyed on `RESEND_API_KEY` instead of a webhook signing secret
- **Severity:** HIGH
- **File:** `src/lib/communication/resend-adapter.ts:207`
- **Explanation:** `validateWebhookSignature()` computes the HMAC with `RESEND_API_KEY`, but Resend signs webhooks with a separate dashboard-issued secret. The computed signature never matches, so every legitimate Resend delivery webhook is rejected (403) and `communication_jobs` bounce/delivered statuses are never updated.
- **Fix:** Introduce a distinct `RESEND_WEBHOOK_SECRET` env var, use it as the HMAC key, and document it in `.env.example`.

### H8. Process-communications cron authenticated only by spoofable User-Agent
- **Severity:** HIGH
- **File:** `src/app/api/cron/process-communications/route.ts:19-23`
- **Explanation:** The only check is `userAgent === 'vercel-cron/1.0'`. Any caller can set that header and trigger `processPendingJobs`/`retryFailedJobs`, dispatching bulk SMS/email across all tenants on demand. Every other cron route uses the timing-safe `verifyCronAuth()` Bearer check; this route is the outlier and is not even registered in `vercel.json`.
- **Fix:** Replace with `verifyCronAuth(request.headers.get('authorization'))`, failing closed when `CRON_SECRET` is unset.

### H9. `/api/upload` has no rate limiting
- **Severity:** HIGH
- **File:** `src/app/api/upload/route.ts:26-146`
- **Explanation:** The POST handler has no `slidingWindow()` call and no `upload` key in `RATE_LIMITS`. Any holder of a valid (easily obtained) session cookie can issue unbounded 5 MB uploads, amplifying cost against R2/S3 and Lambda simultaneously. Every other public mutation endpoint applies a sliding-window guard.
- **Fix:** Add a per-IP sliding window (e.g. 10/min) at the top of the handler, and consider a per-session lifetime cap.

## 4. MEDIUM / LOW Findings (condensed)

| Title | File:line | One-line fix |
|-------|-----------|--------------|
| `proxy.ts` middleware never registered (page/route edge gate inactive) | `src/proxy.ts:1-132` | Create `src/middleware.ts` re-exporting `proxy` as default + `config`; verify manifest is non-empty. |
| Reschedule writes unvalidated `newDate`/`newTime` to DB + audit | `src/app/api/admin/service-requests/[id]/reschedule/route.ts:37-77` | Validate with `isRealIsoDate()`; record structured (not raw) values in audit details. |
| Dead `pastSessions` query + N+1 message previews in history | `src/app/api/chat/history/route.ts:50-94` | Delete the dead query; replace per-session loop with one JOIN. |
| Compaction summary stores raw PII in plaintext `runningSummary` | `src/lib/ai/compact-session.ts:56-74` | Encrypt `runningSummary` or prompt for a PII-free summary. |
| `validateExtractionOutput` skips injection scan on extracted fields | `src/lib/ai/guardrails.ts:62-76` | Run `INJECTION_PATTERNS` per field; strip newlines/truncate slot values before prompt interpolation. |
| Availability sync delete+insert not atomic (two HTTP calls) | `src/lib/integrations/fieldpulse/availability-sync.ts:276-278` | Wrap delete+insert in `db.batch([...])` (guard on `rows.length > 0`). |
| `cron/cleanup` uses non-timing-safe `!==` for CRON_SECRET | `src/app/api/cron/cleanup/route.ts:31` | Replace with `verifyCronAuth()`. |
| `seedCommunicationTemplates` dedup ignores org → new orgs starved | `src/lib/communication/seeds.ts:214-215` | Add `eq(communicationTemplates.organizationId, organizationId)` to dedup check. |
| `blindIndex` uses raw AES master key as HMAC key (no key separation) | `src/lib/crypto.ts:97-102` | Derive a sub-key first (HMAC over domain label), then HMAC the value; recompute existing indexes via migration. |
| `ENCRYPTION_KEY`/`CRON_SECRET`/`AUTH_SECRET` absent from startup env validation | `src/lib/env-validation.ts:23-131` | Add all three as `required: true`. |
| Email address interpolated into thrown Error → `console.error` leaks PII | `src/lib/communication/resend-adapter.ts:51` | Drop the email from the message; log via redacted pino field if needed. |
| `chat/history` GET has no rate limit / data-scraping vector | `src/app/api/chat/history/route.ts:14-126` | Add a `slidingWindow` per-IP guard. |
| In-process `Map` rate limiter bypassed across Vercel instances | `src/lib/rate-limit.ts:5` | Move to a shared atomic store (Neon/Upstash/Vercel KV INCR). |
| Widget-config OPTIONS reflects any Origin pre-key-resolution | `src/app/api/widget/config/route.ts:15-24` | Read key via `X-HVAC-Widget-Key` header in preflight and gate origin, or document GET as authoritative gate. |
| `sync-fieldpulse-availability` cron implemented but unscheduled | `vercel.json:1-12` | Add the cron entry (e.g. `0 * * * *`); ensure `CRON_SECRET` set. |
| OIDC state/nonce cookies `secure:false` outside production | `src/app/api/auth/google/start/route.ts:54` | Set `secure: true` unconditionally (or gate on `!== 'development'`). |
| `communication_jobs.customerId`/`serviceRequestId` lack FK constraints | `src/lib/db/schema.ts:1408-1409` | Add `.references(... { onDelete: 'cascade' })` via migration. |
| Fieldpulse webhook job-ID enumeration oracle (200 vs 401 pre-verify) | `webhook/route.ts:178-233` + invoice-webhook | Return 401 uniformly (incl. no-secret), or verify signature before lookup. |
| Token budget checked against stale snapshot — concurrent 2× spend | `src/app/api/chat/route.ts:394-399` | Use atomic `UPDATE … WHERE tokensUsed+n <= budget RETURNING`. |
| `storageKey` (encodes org/session IDs) returned in session GET | `src/app/api/session/route.ts:224-230` | Remove `storageKey` from the response; `url` is sufficient. |
| Live DashScope API key in local `.env` (gitignored, not committed) | `.env:1` | Rotate key; use OS keychain/secret injection for local dev. |

## 5. Refuted / False Positives

- **`updateFieldDefinition`/`deleteFieldDefinition` TOCTOU cross-tenant write** — `organization_id` is immutable (never updated anywhere), so there is no moving target to race; both callers are behind `getAdminSession` + an explicit ownership pre-check. Latent design smell, not exploitable.
- **DELETE `/api/admin/communications/templates/[id]` omits org filter on final query** — DELETE is keyed on the immutable, globally-unique UUID PK that already passed an org-scoped pre-check; no row can move between orgs. Defense-in-depth only.
- **Admin `businessInfo`/custom-FAQ flow unescaped into system prompt** — only authenticated admins of the same org can write these fields; no privilege escalation or cross-tenant impact. Self-inflicted, within intended permission scope.
- **`chat/history` messages query missing org filter (cross-tenant leak)** — session IDs feeding the inner query are already filtered by `customerId` AND `organizationId`; UUID PKs are globally unique and FK-constrained, so no cross-tenant message can be reached. (Filed twice; both refuted — the performance/dead-code aspect is captured separately as MEDIUM.)
- **Fieldpulse `webhook/route.ts` job-status UPDATE missing org guard** — in a correctly-configured deployment the per-org HMAC signature gate blocks cross-tenant forgery, and the UPDATE is keyed on the unique PK. The only residual risk is the no-secret path, already captured by H1.
- **`cancelPendingJobsForServiceRequest` missing org filter** — function is unexported, called only with UUIDs the current org owns; UUID v4 global uniqueness eliminates the collision vector. Code-hygiene only.

## 6. Top 10 Fixes (by risk-reduction per effort)

1. **C1 — Fix template column reference** (`job-queue.ts:165`): one-line predicate + import; unbreaks 100% of outbound comms. Highest impact, lowest effort.
2. **C2 — Add org filter to service-requests reschedule** (`reschedule/route.ts:49-67`): two-clause change closes a trivially-exploitable cross-tenant write.
3. **H8 — Swap process-communications cron to `verifyCronAuth()`**: a few lines; closes an unauthenticated bulk-send trigger.
4. **H1 — Fail-closed Fieldpulse webhook signature** (`webhook-signature.ts:81-85`): invert one branch + add prod startup assert; removes unauthenticated billing-state forgery.
5. **H2 — Org-scope `syncInvoiceStatus` + invoice-webhook UPDATE/SELECT**: add `organizationId` predicate to both sites; closes cross-tenant invoice mutation.
6. **H6 + H7 — Fix Twilio + Resend webhook verification**: correct one import (use existing `validateTwilioSignature`) and introduce `RESEND_WEBHOOK_SECRET`; restores delivery-status tracking for both channels.
7. **H9 — Rate-limit `/api/upload`**: add one `slidingWindow` call; closes cost-amplification vector.
8. **H3 + H2 index — Add partial indexes on `fieldpulse_job_id`/`hcp_job_id`** (UNIQUE per-org for FP): one migration fixes both the full-scan performance issue and the collision root cause.
9. **H4 — Dedicated `fieldpulse_user_id` column + per-org index**: migration + two call-site edits; stops silent technician-sync failure for every org after the first.
10. **H5 — Encrypt `communication_jobs` recipient PII**: apply existing `encrypt()`/`decrypt()` + column projection; aligns the table with the system's stated at-rest encryption posture.