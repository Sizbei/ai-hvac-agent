# Outbound: Unsold-Estimate Follow-up (Probook v3, Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A consent-gated, deduped, cron-driven campaign that nudges customers about **open estimates** that have gone stale (older than N days, no sold option), recording each send as a context-layer `outbound` event so a follow-on booking is attributable.

**Architecture:** Pure selection (`findStaleUnsoldEstimates`) + a per-estimate enqueue that rides the EXISTING comms rails — `claimOutboundOnce` (dedup), `checkSendAllowed` (consent + quiet hours), `queueCommunicationJob` (the queue the existing `process-communications` cron drains) — plus an `appendEvent` (Phase 1). A thin cron route triggers it per org. **No new sending path, no new migration** — reuses `communication_jobs` + `outbound_message_ledger`.

**Tech Stack:** Drizzle/neon-http, Next.js cron routes (`CRON_SECRET`/`verifyCronAuth`), Vitest.

**Source spec:** `docs/superpowers/specs/2026-06-24-probook-master-spec-v3.md` §6.5.1. **Phase 3** of §8. **No migration.**

**Invariants:** consent is enforced at SEND time by the existing `processPendingJobs` → `checkSendAllowed` path (do not bypass it); dedup via `claimOutboundOnce`; recipient PII is encrypted at enqueue by `queueCommunicationJob` (pass `customerId`, never raw contact). The campaign is **idempotent** (the ledger claim makes a re-run a no-op). **Operator authorization note:** this enqueues real customer messages once the cron runs in prod — it must not be scheduled/enabled without the operator's say-so (the cron entry ships disabled or behind a flag; see Task 4).

---

## File Structure

- `src/lib/communication/unsold-estimate-followup.ts` — **create**: `findStaleUnsoldEstimates(orgId, olderThanDays)` (pure read) + `runUnsoldEstimateFollowup(orgId, now, opts)` (select → claim → consent → enqueue → event).
- `src/lib/communication/unsold-estimate-followup.test.ts` — **create**.
- `src/lib/communication/triggers.ts` (or the trigger/template enum location) — **modify**: add an `estimate_followup` trigger type + template + a `TRIGGER_RULES` consent entry.
- `src/app/api/cron/estimate-followup/route.ts` — **create**: `verifyCronAuth`, iterate active orgs, call the campaign. Ships **disabled** (no `vercel.json` schedule) until the operator enables it.
- `src/app/api/cron/estimate-followup/route.test.ts` — **create**: auth + that it calls the campaign.

---

## Task 1: Trigger type + template + consent rule

**Files:**
- Modify: the communication trigger enum + templates + `src/lib/communication/consent.ts` `TRIGGER_RULES`.

- [ ] **Step 1: Locate the trigger machinery**

Run: `grep -rn "communicationTriggerEnum\|TRIGGER_RULES\|triggerType" src/lib/communication src/lib/db/schema.ts | head`. Identify (a) the trigger enum/union, (b) the template registry, (c) the `TRIGGER_RULES` map in `consent.ts`.

- [ ] **Step 2: Add `estimate_followup`**

Add `estimate_followup` to the trigger enum/union, add a template (SMS + email body referencing "your estimate" — **no price, no PII beyond first name** which the template-variable system already injects), and a `TRIGGER_RULES` entry classifying it as a marketing/promotional type so per-type consent + quiet-hours apply. Match the shape of an existing trigger (e.g. a booking-reminder) exactly.

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit` → exit 0.
```bash
git add -A
git commit -m "feat(comms): add estimate_followup trigger, template, and consent rule"
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

Mock `claimOutboundOnce`, `checkSendAllowed`, `queueCommunicationJob`, `appendEvent`. Assert: for two stale estimates, one already-claimed (claim returns false) → skipped; the other claimed (true) + consent allowed → `queueCommunicationJob` called once with `triggerType:'estimate_followup'`, `customerId`, and an `appendEvent({kind:'outbound', labelKey:'outbound_sent', refId: estimateId})` recorded. A consent-denied estimate → claimed but NOT enqueued (and no event). Returns a summary `{considered, enqueued, skippedClaimed, skippedConsent}`.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```ts
import { claimOutboundOnce } from "./outbound-ledger";
import { checkSendAllowed } from "./consent";
import { queueCommunicationJob } from "./job-queue";
import { appendEvent } from "@/lib/context/thread";

export interface FollowupSummary {
  considered: number; enqueued: number; skippedClaimed: number; skippedConsent: number;
}

export async function runUnsoldEstimateFollowup(
  organizationId: string,
  now: Date,
  opts: { olderThanDays?: number; periodKeyFor?: (e: StaleEstimate) => string } = {},
): Promise<FollowupSummary> {
  const olderThanDays = opts.olderThanDays ?? 7;
  const stale = await findStaleUnsoldEstimates(organizationId, olderThanDays, now);
  const summary: FollowupSummary = { considered: stale.length, enqueued: 0, skippedClaimed: 0, skippedConsent: 0 };

  for (const e of stale) {
    // Dedup: one nudge per estimate (periodKey = the estimate id keeps it once-ever;
    // use a windowed key if repeat nudges are desired later).
    const periodKey = opts.periodKeyFor?.(e) ?? `estimate_followup:${e.estimateId}`;
    const claimed = await claimOutboundOnce({
      organizationId, customerId: e.customerId, triggerType: "estimate_followup", periodKey,
    });
    if (!claimed) { summary.skippedClaimed++; continue; }

    const allowed = await checkSendAllowed({
      organizationId, customerId: e.customerId, channel: "sms", triggerType: "estimate_followup", now,
    });
    if (!allowed.allowed) { summary.skippedConsent++; continue; }

    await queueCommunicationJob({
      organizationId,
      customerId: e.customerId,
      triggerType: "estimate_followup",
      channel: "sms",
      serviceRequestId: e.serviceRequestId ?? undefined,
      templateVariables: {},
    });
    await appendEvent(organizationId, e.customerId, {
      kind: "outbound", labelKey: "outbound_sent", refId: e.estimateId, channel: "sms",
    });
    summary.enqueued++;
  }
  return summary;
}
```

Adapt the exact `queueCommunicationJob` / `checkSendAllowed` / `claimOutboundOnce` argument shapes to their real signatures (read the files). Consent is re-checked at SEND time too — this pre-check just avoids enqueuing obvious no-sends.

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

Read `src/app/api/cron/generate-membership-visits/route.ts` for the exact `verifyCronAuth(req)` (Bearer `CRON_SECRET`) + `runtime="nodejs"` + `dynamic="force-dynamic"` shape. Then: verify auth → 401; iterate active orgs (reuse the existing active-org query the other crons use); `runUnsoldEstimateFollowup(org.id, new Date())` per org; return the aggregated summary.

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
