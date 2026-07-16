# Adversarial Review — Round 2 (2026-07-16)

Three auditors: public/unauth, tech-app + money-concurrency, admin re-probe (perf/error/a11y/mobile). Big **safe** confirmations: **money concurrency is atomic** (concurrent pay/refund/void/estimate→invoice all correct under live race probes); token entropy 256-bit; OIDC CSRF-safe; no open-redirect; portal PII minimal; tech privilege boundary + job IDOR safe.

## HIGH — Security
- **XFF rate-limit bypass (5 auth routes).** `login/tech-login/google-start/signup-start/signup-callback` key the limiter on the raw `x-forwarded-for` header → rotate it for unlimited brute-force (verified: 20 spoofed attempts, 0 × 429). Fix: extract `clientIp()` (leftmost addr + `.slice(0,45)`, already correct in `invite/accept`) and apply to all 5.
- **XFF bypass on chat/session** → unmetered LLM cost-DoS. Same leftmost-IP fix now; persistent store (Upstash) is the durable fix → **NOTE/defer** (infra).

## HIGH — Perf (all `Promise.all`, zero schema risk)
- **ai-insights 9 sequential queries → 4.1s.** `ai-insights-queries.ts getAiInsights` → wrap in `Promise.all`.
- **dispatch/map 3 sequential + 500-row JS dedup → 2.2s.** → `Promise.all` the 3 queries; `SELECT DISTINCT ON (technician_id)` instead of 500-row fetch + JS dedup.
- **search 15k decrypt-scan → 1.6s.** Reduce `SCAN_LIMIT_*` 5000→1500 (durable = blind index, defer).

## HIGH — Error resilience
- **No admin `error.tsx`** → a thrown admin component renders the chat-widget error screen. Add `src/app/admin/(dashboard)/error.tsx` (admin-branded, retry).
- **Client hooks never handle 401** → expired session shows an error banner, not a login redirect. Add a shared `adminFetch` (401 → `window.location.href='/admin/login'`) and use it in the main list hooks.

## HIGH — a11y / mobile
- **Sidebar section labels `text-white/35` ≈1.9:1** (WCAG fail) + email `/50`. Raise to `/70`.
- **Invoices 6-col grid in `overflow-hidden`** clips on mobile (scrollWidth 866 vs 340). → `overflow-x-auto`.

## MEDIUM
- Portal pay accepts `$0.01` on a `$500` balance (no server amount-equality). → in `payPortalInvoice`, require `amountCents === balanceCents` (409 mismatch).
- Auth routes malformed-JSON → 500. → `readJsonBody` → 400 (login, tech-login, invite/accept).
- Tech clock-out response leaks `laborCostCents` (hourly rate). → return `{id, minutes}` only.
- Tech signature/photo upload to R2 **before** the ownership check → orphan/cost vector. → check ownership first.
- Tech location can link a GPS fix to any org job, not just the assigned one. → add `assignedTo == tech` to the lookup.
- `TableHead` missing `scope="col"` (all admin tables). → one-line in the shared primitive.
- `<tr role="button">` (R1) breaks table semantics — **refine R1**: drop the role, keep `tabIndex`+keydown.
- Form error `<p>`s lack `role="alert"` (~6 dialogs/sheets). Success flash uses assertive `role="alert"` → add `live` prop to `Alert` (`status`/polite for non-destructive).
- conversations 4-query waterfall → merge into 2 `Promise.all` stages.
- Missing composite `(organization_id, created_at)` index on `customers` + `audit_log` → migration.
- `DashboardStatCards` skeleton-forever on stats error → `—` branch. Invoices skeleton `cols=5` vs 6 → 6.
- request-detail-sheet date input + notes textarea unlabeled → `aria-label`.

## LOW / NOTE (defer to R3 or note-only)
- Demo-org cross-origin session creation (bounded — chat enforces same-origin); XML-tag injection guardrail regex; money formatting ad-hoc in `billing-panel`/customer-detail → `formatCentsExact`; `motion-reduce:animate-none` on spinners; canonical `formatAdminDateTime` (Eastern) across ~15 sites (consistency, big); operations-metrics unbounded history scan → `first_in_progress_at` column+trigger (schema, big); Upstash for cross-instance rate limits.

## Execution: FR1 security · FR2 tech · FR3 perf+indexes · FR4a error-resilience · FR4b a11y+mobile → verify → deploy.
