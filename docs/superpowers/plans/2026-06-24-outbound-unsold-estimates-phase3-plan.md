# Outbound: Unsold-Estimate Follow-up (Probook v3, Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A consent-gated, deduped, cron-driven campaign that nudges customers about **open estimates** that have gone stale (older than N days, no sold option), recording each send as a context-layer `outbound` event so a follow-on booking is attributable.

**Architecture:** Pure selection (`findStaleUnsoldEstimates`) + a per-estimate enqueue that rides the EXISTING comms rails — `claimOutboundOnce` (dedup), `checkSendAllowed` (consent + quiet hours), `queueCommunicationJob` (the queue the existing `process-communications` cron drains) — plus an `appendEvent` (Phase 1). A thin cron route triggers it per org. **No new *sending* path** — reuses `communication_jobs` + `outbound_message_ledger`.

**Tech Stack:** Drizzle/neon-http, Next.js cron routes (`CRON_SECRET`/`verifyCronAuth`), Vitest.

**Source spec:** `docs/superpowers/specs/2026-06-24-probook-master-spec-v3.md` §6.5.1. **Phase 3** of §8.

**⚠ ONE migration is required (corrected after review):** `communication_trigger_type` is a **Postgres `pgEnum`**. Adding `estimate_followup` to it needs an `ALTER TYPE ... ADD VALUE` migration (operator-applied, like all others). The earlier "no migration" claim was wrong — `claimOutboundOnce`/`checkSendAllowed`/`TRIGGER_RULES`/`communication_jobs.triggerType` are all typed/stored against this enum, so the value must exist in the DB or inserts 500.

**How the real send rail works (the model the enqueue MUST follow — corrected over two review rounds):** `queueCommunicationJob` requires a **`templateId`** (NOT NULL) and a **resolved recipient** (`recipientPhone`/`recipientEmail`) — passing `customerId` alone does NOT send (it throws "recipient required" at send). The reference caller is **`money-triggers.ts`** (`triggerEstimateSent`). Two helpers it uses are **PRIVATE (not exported)** and must be exported (or inlined) for reuse:
- **`findActiveSmsTemplate(org, trigger)`** lives in `money-triggers.ts` (NOT `job-queue.ts`), returns `{ id } | null`, and its `trigger` param is a **closed union that excludes `estimate_followup`** — so you must **export it AND widen its param to `CommTrigger`** (or inline the equivalent `communication_templates` query filtering `templateType:'sms'`, `isActive:true`).
- **`getCustomerContact(org, customerId)`** is duplicated privately in `money-triggers.ts`/`warranty-queries.ts`/`review-queries.ts`; it returns **`{ phone, email, name }` (NOT `firstName`)**. Export one copy (e.g. from `money-triggers.ts`) or inline it; refer to `contact.name`, not `firstName`.

Templates are **per-org DB rows in `communication_templates`**, seeded via `seeds.ts`/`seedCommunicationTemplates` — NOT a code registry. So `estimate_followup` needs a seeded template per org, or `findActiveSmsTemplate` returns null and every send is silently skipped.

**Invariants:** consent is enforced at SEND time by the existing `processPendingJobs` → `checkSendAllowed` path (do not bypass it); dedup via `claimOutboundOnce` (claim BEFORE enqueue → a crash under-sends, never double-sends); recipient PII is encrypted at enqueue by `queueCommunicationJob` (resolve the contact and pass `recipientPhone`/`recipientEmail`). The campaign is **idempotent** (the ledger claim makes a re-run a no-op). **Operator authorization note:** this enqueues real customer messages once the cron runs in prod — it ships **unscheduled** (no `vercel.json` entry) and the operator enables it (see Task 4).

---

## File Structure

- `src/lib/communication/unsold-estimate-followup.ts` — **create**: `findStaleUnsoldEstimates(orgId, olderThanDays)` (pure read) + `runUnsoldEstimateFollowup(orgId, now, opts)` (select → claim → consent → enqueue → event).
- `src/lib/communication/unsold-estimate-followup.test.ts` — **create**.
- `src/lib/communication/triggers.ts` (or the trigger/template enum location) — **modify**: add an `estimate_followup` trigger type + template + a `TRIGGER_RULES` consent entry.
- `src/app/api/cron/estimate-followup/route.ts` — **create**: `verifyCronAuth`, iterate active orgs, call the campaign. Ships **disabled** (no `vercel.json` schedule) until the operator enables it.
- `src/app/api/cron/estimate-followup/route.test.ts` — **create**: auth + that it calls the campaign.

---

## Task 1: Add the `estimate_followup` trigger (enum migration + per-org seeded template + consent rule)

**Files:** `src/lib/db/schema.ts` (the `communication_trigger_type` pgEnum) + a generated migration; `src/lib/communication/consent.ts` (`TRIGGER_RULES`); `src/lib/communication/seeds.ts` (+ `sms-templates.ts`/`email-templates.tsx`).

- [ ] **Step 1: Locate the machinery**

Run: `grep -rn "communication_trigger_type\|communicationTriggerTypeEnum\|TRIGGER_RULES\|findActiveSmsTemplate\|seedCommunicationTemplates" src/lib/communication src/lib/db/schema.ts`. Confirm: (a) the trigger is a **`pgEnum`** in `schema.ts`; (b) `TRIGGER_RULES` in `consent.ts` maps trigger → consent class; (c) templates are **per-org DB rows** seeded in `seeds.ts` and resolved at send via `findActiveSmsTemplate(org, trigger)`.

- [ ] **Step 2: Add the enum value + generate the migration**

Add `"estimate_followup"` to the `communicationTriggerTypeEnum` values in `schema.ts`. Run `npm run db:generate` — it emits an `ALTER TYPE "communication_trigger_type" ADD VALUE 'estimate_followup'` migration. **Do NOT `db:migrate`** (operator applies). Confirm the generated SQL is the ADD VALUE statement.

- [ ] **Step 3: Add the consent rule**

Add an `estimate_followup` entry to `TRIGGER_RULES` classifying it as **marketing/promotional** (so the per-type marketing toggle — off by default in `DEFAULT_PREFS` — and quiet-hours both apply). Match an existing marketing trigger's shape.

- [ ] **Step 4: Seed a per-org template**

Add an `estimate_followup` row to `defaultTemplates` in `seeds.ts` with the **full required shape** (match an existing row): `key`, `name`, `description`, `triggerType: "estimate_followup"`, `templateType: "sms" as const` (so `findActiveSmsTemplate`'s `templateType:'sms'` + `isActive:true` filter matches), `bodyTemplate` ("your estimate", `{{customerName}}`, **no price, no PII**), `variables`, `priority`.

**⚠ Bulk re-seed does NOT backfill existing orgs.** `seedAllOrganizationTemplates` skips any org that already has ≥1 template (`existingCount.length > 0` → skip). So adding the row to `defaultTemplates` only helps **newly-seeded** orgs. For the pilot org (already seeded), the operator must run a **targeted insert** of just the `estimate_followup` template for that org (or you add a small idempotent "insert missing default templates" path). State this explicitly — until the row exists for the pilot org, the campaign skips it degrade-safe (returns `skippedNoTemplate`, no crash).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` → exit 0.
```bash
git add -A
git commit -m "feat(comms): estimate_followup trigger (enum migration + seeded template + consent rule)"
```

---

## Task 2: `findStaleUnsoldEstimates` (pure read) + tests

**Files:**
- Create: `src/lib/communication/unsold-estimate-followup.ts`
- Test: `src/lib/communication/unsold-estimate-followup.test.ts`

- [ ] **Step 1: Write the failing test**

Mock `@/lib/db`. Assert `findStaleUnsoldEstimates(orgId, 7)` selects estimates where `status='open'` (re-bucketing an expired `expiresAt<now` is the existing reporting convention — here just require `status='open'`), `createdAt < now-7d`, `soldOptionId IS NULL`, scoped via `withTenant`, returning `{estimateId, customerId, serviceRequestId, createdAt}` rows.

- [ ] **Step 2: Run → fail** (module missing).

- [ ] **Step 3: Implement the read**

```ts
import { and, eq, isNull, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { estimates } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export interface StaleEstimate {
  readonly estimateId: string;
  readonly customerId: string;
  readonly serviceRequestId: string | null;
  readonly createdAt: Date;
}

export async function findStaleUnsoldEstimates(
  organizationId: string,
  olderThanDays: number,
  now: Date,
): Promise<StaleEstimate[]> {
  const cutoff = new Date(now.getTime() - olderThanDays * 86_400_000);
  const rows = await db
    .select({
      estimateId: estimates.id,
      customerId: estimates.customerId,
      serviceRequestId: estimates.serviceRequestId,
      createdAt: estimates.createdAt,
    })
    .from(estimates)
    .where(
      withTenant(
        estimates,
        organizationId,
        and(eq(estimates.status, "open"), isNull(estimates.soldOptionId), lt(estimates.createdAt, cutoff))!,
      ),
    );
  return rows.filter((r): r is StaleEstimate => r.customerId != null);
}
```

- [ ] **Step 4: Run → pass.** Commit:
```bash
git add src/lib/communication/unsold-estimate-followup.ts src/lib/communication/unsold-estimate-followup.test.ts
git commit -m "feat(outbound): findStaleUnsoldEstimates query"
```

---

## Task 3: `runUnsoldEstimateFollowup` — select → dedup → consent → enqueue → event

**Files:**
- Modify: `src/lib/communication/unsold-estimate-followup.ts`
- Test: `src/lib/communication/unsold-estimate-followup.test.ts`

- [ ] **Step 1: Write the failing test**

Mock `claimOutboundOnce`, `checkSendAllowed`, `queueCommunicationJob`, `appendEvent`, **`findActiveSmsTemplate`, and `getCustomerContact`**. Assert: for two stale estimates, one already-claimed (claim returns false) → skipped; the other claimed (true) + consent allowed + a template row exists + a phone resolves → `queueCommunicationJob` called once with `triggerType:'estimate_followup'`, **`templateId` from the resolved template**, **`recipientPhone` from the resolved contact**, and an `appendEvent({kind:'outbound', labelKey:'outbound_sent', refId: estimateId})` recorded. A consent-denied estimate → claimed but NOT enqueued (no event). **An estimate where `findActiveSmsTemplate` returns null OR the contact has no phone → claimed but skipped (no enqueue), counted as `skippedNoTemplate`/`skippedNoContact`.** Returns a summary `{considered, enqueued, skippedClaimed, skippedConsent, skippedNoTemplate, skippedNoContact}`.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```ts
import { claimOutboundOnce } from "./outbound-ledger";
import { checkSendAllowed } from "./consent";
import { queueCommunicationJob } from "./job-queue";
// findActiveSmsTemplate + getCustomerContact are PRIVATE in money-triggers.ts — EXPORT them
// (widen findActiveSmsTemplate's trigger param to CommTrigger) or inline equivalents here.
import { findActiveSmsTemplate, getCustomerContact } from "./money-triggers";
import { appendEvent } from "@/lib/context/thread";

export interface FollowupSummary {
  considered: number; enqueued: number;
  skippedClaimed: number; skippedConsent: number;
  skippedNoTemplate: number; skippedNoContact: number;
}

export async function runUnsoldEstimateFollowup(
  organizationId: string,
  now: Date,
  opts: { olderThanDays?: number; periodKeyFor?: (e: StaleEstimate) => string } = {},
): Promise<FollowupSummary> {
  const olderThanDays = opts.olderThanDays ?? 7;
  const stale = await findStaleUnsoldEstimates(organizationId, olderThanDays, now);
  const summary: FollowupSummary = {
    considered: stale.length, enqueued: 0,
    skippedClaimed: 0, skippedConsent: 0, skippedNoTemplate: 0, skippedNoContact: 0,
  };

  // Resolve the per-org template ONCE (it's the same for every estimate).
  const template = await findActiveSmsTemplate(organizationId, "estimate_followup");
  if (!template) {
    // No seeded template for this org → nothing can send; degrade safe.
    summary.skippedNoTemplate = stale.length;
    return summary;
  }

  for (const e of stale) {
    const periodKey = opts.periodKeyFor?.(e) ?? `estimate_followup:${e.estimateId}`;
    // Claim BEFORE enqueue so a crash under-sends rather than double-sends.
    const claimed = await claimOutboundOnce({
      organizationId, customerId: e.customerId, triggerType: "estimate_followup", periodKey,
    });
    if (!claimed) { summary.skippedClaimed++; continue; }

    const allowed = await checkSendAllowed({
      organizationId, customerId: e.customerId, channel: "sms", triggerType: "estimate_followup", now,
    });
    if (!allowed.allowed) { summary.skippedConsent++; continue; }

    // queueCommunicationJob needs a RESOLVED recipient — customerId alone never sends.
    const contact = await getCustomerContact(organizationId, e.customerId);
    if (!contact?.phone) { summary.skippedNoContact++; continue; }

    await queueCommunicationJob({
      organizationId,
      customerId: e.customerId,
      templateId: template.id,            // REQUIRED — resolved per-org template
      triggerType: "estimate_followup",
      channel: "sms",
      recipientPhone: contact.phone,      // REQUIRED — encrypted at enqueue
      serviceRequestId: e.serviceRequestId ?? undefined,
      templateVariables: { customerName: contact.name ?? "there" }, // CustomerContact has `name`, not `firstName`
    });
    await appendEvent(organizationId, e.customerId, {
      kind: "outbound", labelKey: "outbound_sent", refId: e.estimateId, channel: "sms",
    });
    summary.enqueued++;
  }
  return summary;
}
```

**Match the real signatures (read `job-queue.ts`, `consent.ts`, `outbound-ledger.ts`, `money-triggers.ts`):** `queueCommunicationJob` requires `templateId` + a recipient; `findActiveSmsTemplate(org, trigger)` returns `{id} | null` (export it from `money-triggers.ts` and widen its `trigger` param to `CommTrigger`); `getCustomerContact(org, customerId)` returns **`{phone, email, name}`** (export one copy; use `contact.name`). `money-triggers.ts`'s `triggerEstimateSent` is the reference caller — copy its template-resolve → contact-resolve → `queueCommunicationJob` shape exactly. Consent is re-checked at SEND time too — this pre-check just avoids enqueuing obvious no-sends.

- [ ] **Step 4: Run → pass.** Run `npx tsc --noEmit` → exit 0. Commit:
```bash
git add src/lib/communication/unsold-estimate-followup.ts src/lib/communication/unsold-estimate-followup.test.ts
git commit -m "feat(outbound): runUnsoldEstimateFollowup (dedup + consent + enqueue + event)"
```

---

## Task 4: Cron route (ships disabled)

**Files:**
- Create: `src/app/api/cron/estimate-followup/route.ts`
- Test: `src/app/api/cron/estimate-followup/route.test.ts`

- [ ] **Step 1: Implement (mirror an existing cron route)**

Read `src/app/api/cron/generate-membership-visits/route.ts` for the exact shape. **The auth call is `verifyCronAuth(request.headers.get("authorization"))`** — it takes the Authorization header string (Bearer `CRON_SECRET`), NOT the request object — plus `runtime="nodejs"` + `dynamic="force-dynamic"`. Then: verify auth → 401; iterate orgs from the `organizations` table (active/non-deleted — not the membership filter); `runUnsoldEstimateFollowup(org.id, new Date())` per org; return the aggregated summary.

- [ ] **Step 2: Test** — 401 without the secret; 200 + summary with it (mock the campaign).

- [ ] **Step 3: Do NOT add a `vercel.json` schedule.** The route exists and is testable but is **not scheduled** — enabling it (a `vercel.json` cron entry) is an operator action, because it sends real customer messages. Note this in the route's top comment.

- [ ] **Step 4: Verify + commit**

Run: `npx tsc --noEmit && npm run lint && npx vitest run src/lib/communication src/app/api/cron/estimate-followup` → green.
```bash
git add src/app/api/cron/estimate-followup
git commit -m "feat(outbound): estimate-followup cron route (auth-gated, ships unscheduled)"
```

---

## Done criteria (maps to spec G7-adjacent / re-booking)

- Stale open unsold estimates are selected; each customer gets at most one nudge (ledger-deduped); consent + quiet-hours enforced; the send is recorded as an `outbound` context event for attribution.
- Reuses the existing send path entirely (no new SMS/email code).
- Ships **unscheduled** — enabling the cron is an explicit operator step (it sends real messages).
- tsc + lint + the new suites + build are green.

**Out of scope (later):** booking attribution windowing/reporting (the event log enables it; the report is a later slice), repeat-nudge cadence (start once-ever per estimate), forecast-driven prioritization (Phase 6/9). These don't block the campaign.
