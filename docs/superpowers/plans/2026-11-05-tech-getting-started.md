# Technician Getting-Started Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-technician "Getting started" tutorial on the phone (card on `/tech/jobs`, page at `/tech/guide`) whose nine steps complete themselves from the technician's own rows, with write-once stamps and a per-user hide.

**Architecture:** Mirror of the office setup guide, cut down. One FROM-less SELECT derives nine booleans for `(org, user)`; a pure module turns them into steps/progress/upNext; one guarded UPDATE on `users.field_guide_state` stamps first completions; a second UPDATE hides the card. Two routes (`GET`/`PATCH /api/tech/guide`). Client: a small fetch hook, a card inside the jobs list, a page, a header link, one window event for the location toggle. No store, no demo rule, no audit.

**Tech Stack:** Next.js 16 App Router, Drizzle 0.45 on Neon neon-http (`db.execute(sql…)`), zod 4, vitest (pure, no jsdom), base shadcn primitives, lucide icons, tw-animate-css, Playwright for the walk.

**Spec:** `docs/superpowers/specs/2026-11-05-tech-getting-started.md` (v4 FINAL). The spec is the authority; this plan argues from it. Plan v2 after plan review round 1 (two critics; see the SDD ledger).

**Deviations from the spec, ruled here:** `progressLabel(done, total, suffix)` lives in `guide-copy.ts` (spec §6 put it in `guide-view.ts`); the payload has no `finishedAt` (spec §7 mentions one in cases (c)/(g); assert `finished === true` and the stored `firstCompleted.finish_job` instead); `GuideFinished` is built in Task 4 and reused by Task 5.

## Global Constraints

- Gates before every commit: `npx tsc --noEmit` → 0 · `npx eslint <changed files>` → 0 errors · `npx vitest run` → the live baseline (5556 passed / 1 skipped at start) must not drop. No jsdom/RTL: test component logic through pure helpers only.
- `.env.local` is the DEV Neon branch. Never point it at prod (`ep-withered-hill`). Integration suites refuse that host.
- neon-http: `db.transaction()` throws; use single statements or `db.batch()`.
- Copy canon: sentence case; "request" / "technician" / "sign in"; Unicode `…`; human error copy, never `err.message` in the UI. Tech copy strings are EXACT per spec §3/§6; do not reword.
- Tenancy: every subquery carries `organization_id = $o`; every row rule carries the technician's own id.
- Tech UI uses base primitives (`@/components/ui/*`), `h-11` targets, `max-w-md`; never admin primitives from `src/components/admin/ui/*`.
- Hand-authored migration: `drizzle/0054_tech_guide.sql`, `_journal.json` entry (`idx` 54, `version` "7", fresh `when`, tag `0054_tech_guide`, `breakpoints: true`), and a real `0054_snapshot.json` (copy of 0053 with the new column, new `id`, `prevId` = `6a1a3f08-5472-4cdd-8d7b-6a5afd648417`); then `npx drizzle-kit generate` must print "No schema changes". Run `npm run db:migrate` on dev before any DB-backed test.
- Dev hazards: the dev default org `00000000-0000-0000-0000-000000000001` has a WORKING FieldPulse key and live Twilio creds. Never create requests through the admin API; never tap status on dev-org jobs; before anything that could queue a message run `SELECT count(*) FROM communication_jobs WHERE status='pending' AND scheduled_for <= now() + interval '15 minutes'` and abort unless 0. Throwaway orgs only via `createOrgCore` (DB-only), deleted afterwards.
- Logs: ids and codes only (`errorCode(error)` from `@/lib/logger`); never a user's name or email.
- Commit attribution lines (every commit, exactly these two): `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6`.
- Implementers never dispatch subagents.

## Review Focus

1. A technician whose `field_guide_state` is JSON `null`, an array, or has a non-object `firstCompleted`: parse must not throw and the stamp statement must still work (Task 1: parse tolerance tests; SQL has both `jsonb_typeof` CASEs).
2. A stamp write that throws on GET: `getGuide` still resolves with the derived payload (Task 2 `guide-queries.test.ts` "a failed stamp write is logged").
3. The jobs page when `readGuideHidden` throws or the session is null: the job list still renders (Task 2 query test; Task 4 page code).
4. A Today fetch aborted by a quick tab switch (and React StrictMode's double mount in dev): the card still renders once, with no Upcoming note and with `Open the job` once Today loads (Task 4 `cardState`/`cardNote` tests with `todayFirst === 'unknown'`; the jobs-list code uses a separate `todaySettled`).
5. A finish stamp 25 hours old: the card is hidden server-side AND in the payload, with no skeleton (Task 1 `cardHiddenFor` tests; Task 2 `readGuideHidden`; integration (g)).

## File map (exclusive ownership)

| task | creates | modifies |
| --- | --- | --- |
| 1 | `drizzle/0054_tech_guide.sql`, `drizzle/meta/0054_snapshot.json`, `src/lib/tech/guide-state.ts` (+test), `src/lib/tech/guide-sql.ts` (+test) | `drizzle/meta/_journal.json`, `src/lib/db/schema.ts`, `src/components/tech/tech-status-confirm.ts` (+test) |
| 2 | `src/lib/tech/guide-steps.ts` (+test), `src/lib/tech/guide-copy.ts` (+test), `src/lib/tech/guide-queries.ts` (+test) | — |
| 3 | `src/app/api/tech/guide/route.ts` (+test), `src/lib/tech/guide-refresh.ts` (+test), `tests/integration/tech-guide.test.ts` | `vitest.config.ts`, `src/components/tech/tech-location-tracker.tsx` |
| 4 | `src/lib/tech/guide-view.ts` (+test), `src/hooks/use-tech-guide.ts`, `src/components/tech/guide-progress.tsx`, `src/components/tech/guide-finished.tsx`, `src/components/tech/guide-card.tsx`, `src/components/tech/guide-link.tsx` | `src/components/tech/tech-jobs-list-client.tsx`, `src/app/tech/jobs/page.tsx`, `src/app/tech/layout.tsx` |
| 5 | `src/app/tech/guide/page.tsx`, `src/components/tech/guide-page-client.tsx`, `src/components/tech/guide-step-row.tsx` | — |
| 6 | — | `.claude/skills/page-tech/SKILL.md`, `replica/build-log.md`, `replica/architecture.md` |

The spec §9 walk is run by the lead after Task 6 (Playwright, a throwaway org); it is not a task.

---

### Task 1: State, SQL builders, migration, `Working` label

**Files:**
- Create: `drizzle/0054_tech_guide.sql`, `drizzle/meta/0054_snapshot.json`, `src/lib/tech/guide-state.ts`, `src/lib/tech/guide-state.test.ts`, `src/lib/tech/guide-sql.ts`, `src/lib/tech/guide-sql.test.ts`
- Modify: `drizzle/meta/_journal.json`, `src/lib/db/schema.ts` (users table, after `locationConsentUpdatedAt`), `src/components/tech/tech-status-confirm.ts`, `src/components/tech/tech-status-confirm.test.ts` (line 18 only)

**Interfaces:**
- Produces: `STEP_IDS`, `StepId`, `GuideState`, `parseGuideState(raw)`, `cardHiddenFor(state, now)`, `FINISHED_CARD_MS` (guide-state.ts); `guideSelectSql(organizationId, userId)`, `guideStampSql({ organizationId, userId, newStamps })`, `guideHideSql({ organizationId, userId, hiddenAt })` (guide-sql.ts); column `users.field_guide_state`.

- [ ] **Step 1: Failing tests for the state module**

`src/lib/tech/guide-state.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { STEP_IDS, cardHiddenFor, parseGuideState, FINISHED_CARD_MS } from "./guide-state";

const NOW = new Date("2026-11-05T12:00:00.000Z");

describe("parseGuideState", () => {
  it("never throws and drops bad values", () => {
    expect(parseGuideState(null)).toEqual({ firstCompleted: {} });
    expect(parseGuideState([])).toEqual({ firstCompleted: {} });
    expect(parseGuideState({ firstCompleted: "x" })).toEqual({ firstCompleted: {} });
    expect(parseGuideState({ hiddenAt: "nope", firstCompleted: { start_job: 5, finish_job: "2026-11-01T00:00:00.000Z", unknown: "2026-11-01T00:00:00.000Z" } }))
      .toEqual({ firstCompleted: { finish_job: "2026-11-01T00:00:00.000Z" } });
  });
  it("keeps a valid hiddenAt", () => {
    expect(parseGuideState({ hiddenAt: "2026-11-01T00:00:00.000Z" }).hiddenAt).toBe("2026-11-01T00:00:00.000Z");
  });
  it("lists the nine step ids in order", () => {
    expect(STEP_IDS).toEqual(["start_job", "finish_job", "clock_in", "share_location", "add_material", "note_or_photo", "capture_signature", "build_invoice", "collect_payment"]);
  });
});

describe("cardHiddenFor", () => {
  const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
  it("hidden when hiddenAt is set", () => {
    expect(cardHiddenFor({ hiddenAt: at(1), firstCompleted: {} }, NOW)).toBe(true);
  });
  it("hidden once the finish stamp is older than 24 hours", () => {
    expect(FINISHED_CARD_MS).toBe(24 * 60 * 60 * 1000);
    expect(cardHiddenFor({ firstCompleted: { finish_job: at(23) } }, NOW)).toBe(false);
    expect(cardHiddenFor({ firstCompleted: { finish_job: at(25) } }, NOW)).toBe(true);
  });
  it("not hidden without a stamp", () => {
    expect(cardHiddenFor({ firstCompleted: { start_job: at(48) } }, NOW)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect failure** — `npx vitest run src/lib/tech/guide-state.test.ts` → cannot resolve `./guide-state`.

- [ ] **Step 3: Write `src/lib/tech/guide-state.ts`**

```ts
import { z } from "zod";

/** Getting-started guide state (users.field_guide_state). Imports only zod: safe for client code. */
export const STEP_IDS = [
  "start_job", "finish_job", "clock_in", "share_location", "add_material",
  "note_or_photo", "capture_signature", "build_invoice", "collect_payment",
] as const;
export type StepId = (typeof STEP_IDS)[number];

export interface GuideState {
  hiddenAt?: string;
  firstCompleted: Partial<Record<StepId, string>>;
}

/** The finished card leaves on its own this long after the finish_job stamp. */
export const FINISHED_CARD_MS = 24 * 60 * 60 * 1000;

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s))).optional().catch(undefined);
const stateSchema = z.object({
  hiddenAt: isoDate,
  firstCompleted: z.record(z.string(), z.unknown()).optional().catch(undefined),
});

/** Tolerant parse of the stored jsonb. Never throws. */
export function parseGuideState(raw: unknown): GuideState {
  const parsed = stateSchema.safeParse(raw);
  const s = parsed.success ? parsed.data : {};
  const firstCompleted: GuideState["firstCompleted"] = {};
  for (const id of STEP_IDS) {
    const v = s.firstCompleted?.[id];
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) firstCompleted[id] = v;
  }
  return s.hiddenAt ? { hiddenAt: s.hiddenAt, firstCompleted } : { firstCompleted };
}

/** Spec §2: hidden by × or 24 h after the stored finish stamp (server clock). */
export function cardHiddenFor(state: GuideState, now: Date): boolean {
  if (state.hiddenAt) return true;
  const finished = state.firstCompleted.finish_job;
  return finished !== undefined && now.getTime() - Date.parse(finished) > FINISHED_CARD_MS;
}
```

- [ ] **Step 4: Run the state tests** — PASS.

- [ ] **Step 5: Failing tests for the SQL builders**

`src/lib/tech/guide-sql.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { guideSelectSql, guideStampSql, guideHideSql } from "./guide-sql";

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const render = (q: SQL) => new PgDialect().sqlToQuery(q);

describe("guideSelectSql", () => {
  const { sql: text, params } = render(guideSelectSql(ORG, USER));
  const flat = text.replace(/\s+/g, " ");

  it("is a FROM-less SELECT with one column per signal", () => {
    let depth = 0, top = "";
    for (const ch of flat) { if (ch === "(") depth++; else if (ch === ")") depth--; else if (depth === 0) top += ch; }
    expect(top).not.toMatch(/\bFROM\b/);
    for (const col of ["start_job", "finish_job", "clock_in", "share_location", "add_material", "note_or_photo", "capture_signature", "build_invoice", "collect_payment", "has_open_job", "field_guide_state"]) {
      expect(flat).toContain(` AS ${col}`);
    }
  });

  it("binds 26 org predicates and 13 user predicates, nothing else", () => {
    expect(params.filter((p) => p === ORG)).toHaveLength(26);
    expect(params.filter((p) => p === USER)).toHaveLength(13);
    expect(params).toHaveLength(39);
  });

  it("names every user predicate by column", () => {
    for (const col of ["technician_id", "created_by", "author_id", "recorded_by", "id"]) {
      expect(flat).toMatch(new RegExp(`\\b${col} = \\$\\d+`));
    }
  });

  it("excludes office uploads and cancelled visits", () => {
    expect(flat).toContain("position('_admin_' in t.storage_key) = 0");
    expect((flat.match(/p\.cancelled_at IS NULL/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(flat).toContain("r.status NOT IN ('completed', 'cancelled')");
  });
});

describe("guideStampSql", () => {
  it("guards with ?& on defined keys only, both jsonb_typeof CASEs, technician role", () => {
    const { sql: text, params } = render(guideStampSql({ organizationId: ORG, userId: USER, newStamps: { start_job: "2026-11-05T00:00:00.000Z", clock_in: undefined } }));
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain("role = 'technician'");
    expect(flat).toContain("?&");
    expect((flat.match(/jsonb_typeof/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(params).toContainEqual(["start_job"]);
    expect(params).toContainEqual(JSON.stringify({ start_job: "2026-11-05T00:00:00.000Z" }));
    expect(flat).not.toContain("RETURNING");
  });
});

describe("guideHideSql", () => {
  it("prepends the new key so old values win, and returns the state", () => {
    const { sql: text, params } = render(guideHideSql({ organizationId: ORG, userId: USER, hiddenAt: "2026-11-05T00:00:00.000Z" }));
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toMatch(/jsonb_build_object\('hiddenAt', \$\d+::text\) \|\| CASE WHEN jsonb_typeof/);
    expect(flat).toContain("RETURNING field_guide_state");
    expect(params).toEqual(["2026-11-05T00:00:00.000Z", USER, ORG]);
  });
});
```

- [ ] **Step 6: Run it, expect failure** — cannot resolve `./guide-sql`.

- [ ] **Step 7: Write `src/lib/tech/guide-sql.ts`** (exact SQL; the param counts in the test depend on it; the enum casts match `ownership.ts` style)

```ts
import { sql, type SQL } from "drizzle-orm";
import type { StepId } from "./guide-state";
import { OPEN_ASSIGNMENT_STATUSES } from "./ownership";

/** Pure SQL builders for the technician getting-started guide (spec §3/§4). */

const OLD = sql`CASE WHEN jsonb_typeof(users.field_guide_state) = 'object' THEN users.field_guide_state ELSE '{}'::jsonb END`;
const FC = sql`CASE WHEN jsonb_typeof((${OLD})->'firstCompleted') = 'object' THEN (${OLD})->'firstCompleted' ELSE '{}'::jsonb END`;
const OPEN_IN = sql.raw(`(${OPEN_ASSIGNMENT_STATUSES.map((s) => `'${s}'::request_status`).join(", ")})`);

/** LEAD_ON_LIVE(r) / ASSIGNED_ON_LIVE(r): this technician on a live visit of request alias r. */
function onLive(o: string, u: string, lead: boolean): SQL {
  const leadPred = lead ? sql` AND a.is_lead` : sql``;
  return sql`EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id = a.appointment_id WHERE p.service_request_id = r.id AND a.organization_id = ${o} AND p.organization_id = ${o} AND a.technician_id = ${u}${leadPred} AND a.status <> 'cancelled'::request_status AND p.cancelled_at IS NULL)`;
}

export function guideSelectSql(organizationId: string, userId: string): SQL {
  const o = organizationId;
  const u = userId;
  return sql`SELECT
  EXISTS (SELECT 1 FROM appointment_assignments WHERE organization_id = ${o} AND technician_id = ${u} AND (en_route_at IS NOT NULL OR arrived_at IS NOT NULL OR started_at IS NOT NULL)) AS start_job,
  EXISTS (SELECT 1 FROM appointment_assignments WHERE organization_id = ${o} AND technician_id = ${u} AND completed_at IS NOT NULL AND started_at IS NOT NULL) AS finish_job,
  EXISTS (SELECT 1 FROM technician_time_entries WHERE organization_id = ${o} AND technician_id = ${u} AND kind = 'general') AS clock_in,
  COALESCE((SELECT location_sharing_enabled FROM users WHERE id = ${u} AND organization_id = ${o}), false) AS share_location,
  EXISTS (SELECT 1 FROM job_materials WHERE organization_id = ${o} AND created_by = ${u}) AS add_material,
  (EXISTS (SELECT 1 FROM request_notes WHERE organization_id = ${o} AND author_id = ${u})
    OR EXISTS (SELECT 1 FROM attachments t JOIN service_requests r ON r.id = t.service_request_id WHERE t.organization_id = ${o} AND r.organization_id = ${o} AND t.session_id IS NULL AND t.message_id IS NULL AND position('_admin_' in t.storage_key) = 0 AND ${onLive(o, u, false)})) AS note_or_photo,
  EXISTS (SELECT 1 FROM service_requests r WHERE r.organization_id = ${o} AND r.signed_at IS NOT NULL AND ${onLive(o, u, true)}) AS capture_signature,
  EXISTS (SELECT 1 FROM invoices i JOIN service_requests r ON r.id = i.service_request_id WHERE i.organization_id = ${o} AND r.organization_id = ${o} AND i.fieldpulse_invoice_id IS NULL AND i.hcp_invoice_id IS NULL AND i.state IN ('open'::invoice_state, 'paid'::invoice_state, 'refunded'::invoice_state) AND ${onLive(o, u, true)}) AS build_invoice,
  (EXISTS (SELECT 1 FROM payments WHERE organization_id = ${o} AND recorded_by = ${u} AND status = 'succeeded'::payment_status)
    OR EXISTS (SELECT 1 FROM invoices i JOIN service_requests r ON r.id = i.service_request_id WHERE i.organization_id = ${o} AND r.organization_id = ${o} AND i.pay_link_sent_at IS NOT NULL AND ${onLive(o, u, true)})) AS collect_payment,
  EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id = a.appointment_id JOIN service_requests r ON r.id = p.service_request_id WHERE a.organization_id = ${o} AND p.organization_id = ${o} AND r.organization_id = ${o} AND a.technician_id = ${u} AND a.status IN ${OPEN_IN} AND p.cancelled_at IS NULL AND r.status NOT IN ('completed', 'cancelled')) AS has_open_job,
  (SELECT field_guide_state FROM users WHERE id = ${u} AND organization_id = ${o}) AS field_guide_state`;
}

function definedOnly<T extends object>(obj: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** First-completion stamps; old values win; no-op when every key is already present. */
export function guideStampSql(p: { organizationId: string; userId: string; newStamps: Partial<Record<StepId, string>> }): SQL {
  const newObj = definedOnly(p.newStamps);
  const created = JSON.stringify(newObj);
  const keys = sql.param(Object.keys(newObj));
  return sql`UPDATE users SET field_guide_state = jsonb_set(${OLD}, '{firstCompleted}', ${created}::jsonb || ${FC}, true)
WHERE id = ${p.userId} AND organization_id = ${p.organizationId} AND role = 'technician'
  AND NOT (${FC} ?& ${keys}::text[])`;
}

/** Hide the card (write-once: an existing hiddenAt wins). Always returns the row for a live technician. */
export function guideHideSql(p: { organizationId: string; userId: string; hiddenAt: string }): SQL {
  return sql`UPDATE users SET field_guide_state = jsonb_build_object('hiddenAt', ${p.hiddenAt}::text) || ${OLD}
WHERE id = ${p.userId} AND organization_id = ${p.organizationId} AND role = 'technician'
RETURNING field_guide_state`;
}
```

- [ ] **Step 8: Run the SQL tests** — PASS. If the param counts differ, fix the SQL to the spec (not the test): 26 org predicates = start 1 + finish 1 + clock 1 + share 1 + material 1 + note (1 + 2 + 2) 5 + signature (1 + 2) 3 + invoice (2 + 2) 4 + payment (1 + 2 + 2) 5 + has_open 3 + state 1; 13 user predicates = 1+1+1+1+1+2+1+1+2+1+1.

- [ ] **Step 9: Schema column** — in `src/lib/db/schema.ts`, in `users`, after `locationConsentUpdatedAt`:

```ts
    // Technician getting-started guide (spec 2026-11-05): { hiddenAt?, firstCompleted: { <stepId>: iso } }.
    // Timestamps and step ids only — never PII. NULL = never read.
    fieldGuideState: jsonb("field_guide_state"),
```

(`jsonb` is already imported in schema.ts.)

- [ ] **Step 10: Migration** — `drizzle/0054_tech_guide.sql`:

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS field_guide_state jsonb;
```

Journal: append to `drizzle/meta/_journal.json` `entries` (fill `when` with `Date.now()` at authoring time; it must exceed 1793755484801):

```json
    {
      "idx": 54,
      "version": "7",
      "when": 1793800000000,
      "tag": "0054_tech_guide",
      "breakpoints": true
    }
```

Snapshot: `cp drizzle/meta/0053_snapshot.json drizzle/meta/0054_snapshot.json`, then edit: top-level `id` = a new UUID v4 (`node -e "console.log(crypto.randomUUID())"`), `prevId` = `"6a1a3f08-5472-4cdd-8d7b-6a5afd648417"`, and under `tables["public.users"].columns` add after `location_consent_updated_at`:

```json
        "field_guide_state": {
          "name": "field_guide_state",
          "type": "jsonb",
          "primaryKey": false,
          "notNull": false
        },
```

- [ ] **Step 11: Verify the migration recipe** — `npx drizzle-kit generate` prints "No schema changes, nothing to migrate 😴" (delete any file it created if it did not). Then `npm run db:migrate` (dev branch) applies 0054. Confirm with a one-off script (do not commit it):

```bash
npx tsx -e "import {readFileSync} from 'fs'; for (const l of readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^([A-Z_0-9]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]]=m[2].replace(/^\"|\"$/g,''); } const {neon}=await import('@neondatabase/serverless'); const sql=neon(process.env.DATABASE_URL); console.log(await sql\`SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='field_guide_state'\`)"
```

→ one row.

- [ ] **Step 12: `Working` label** — in `src/components/tech/tech-status-confirm.ts` add `in_progress: 'Working',` to `TECH_STATUS_LABELS` (after `arrived`). In `tech-status-confirm.test.ts` change ONLY line 18 (`expect(techStatusLabel('in_progress')).toBe('In progress')`) to `toBe('Working')`; the `labelAssignmentStatus` assertion near line 105 stays "In progress". Run `npx vitest run src/components/tech/tech-status-confirm.test.ts src/lib/tech/status-actions.test.ts` → PASS.

- [ ] **Step 13: Gates + commit**

```bash
npx tsc --noEmit && npx eslint src/lib/tech/guide-state.ts src/lib/tech/guide-state.test.ts src/lib/tech/guide-sql.ts src/lib/tech/guide-sql.test.ts src/lib/db/schema.ts src/components/tech/tech-status-confirm.ts src/components/tech/tech-status-confirm.test.ts && npx vitest run
git add drizzle/0054_tech_guide.sql drizzle/meta/_journal.json drizzle/meta/0054_snapshot.json src/lib/db/schema.ts src/lib/tech/guide-state.ts src/lib/tech/guide-state.test.ts src/lib/tech/guide-sql.ts src/lib/tech/guide-sql.test.ts src/components/tech/tech-status-confirm.ts src/components/tech/tech-status-confirm.test.ts
git commit -m "feat(tech-guide): guide state, SQL builders, migration 0054, Working tap label"
```

---

### Task 2: Step derivation, copy, queries

**Files:**
- Create: `src/lib/tech/guide-steps.ts`, `src/lib/tech/guide-steps.test.ts`, `src/lib/tech/guide-copy.ts`, `src/lib/tech/guide-copy.test.ts`, `src/lib/tech/guide-queries.ts`, `src/lib/tech/guide-queries.test.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `STEP_DEFS`, `Signals`, `DerivedStep`, `GuidePayload`, `GuideProgress`, `NO_JOB_NOTE`, `deriveGuide(signals, now)` → `{ steps, progress, upNext, finished, newStamps }`, `upNext(steps)` (guide-steps.ts, types-only imports); `GUIDE_COPY`, `progressLabel(done, total, suffix?)` (guide-copy.ts); `getGuide(organizationId, userId, now?)` → `GuidePayload`, `hideGuide(organizationId, userId, now?)` → `{ hiddenAt } | null`, `readGuideHidden(organizationId, userId, now?)` → `boolean` (guide-queries.ts, `server-only`).

- [ ] **Step 1: Failing tests for the derivation**

`src/lib/tech/guide-steps.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { GuideState } from "./guide-state";
import { STEP_DEFS, NO_JOB_NOTE, deriveGuide, upNext, type Signals } from "./guide-steps";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const ALL_FALSE = {
  startJob: false, finishJob: false, clockIn: false, shareLocation: false, addMaterial: false,
  noteOrPhoto: false, captureSignature: false, buildInvoice: false, collectPayment: false,
};
function signals(p: Partial<Signals> = {}, state: Partial<GuideState> = {}): Signals {
  return { ...ALL_FALSE, hasOpenJob: false, state: { firstCompleted: {}, ...state }, ...p };
}

describe("STEP_DEFS", () => {
  it("has nine steps, two required, three lead-only, in spec order", () => {
    expect(STEP_DEFS.map((s) => s.id)).toEqual(["start_job", "finish_job", "clock_in", "share_location", "add_material", "note_or_photo", "capture_signature", "build_invoice", "collect_payment"]);
    expect(STEP_DEFS.filter((s) => s.required).map((s) => s.id)).toEqual(["start_job", "finish_job"]);
    expect(STEP_DEFS.filter((s) => s.leadOnly).map((s) => s.id)).toEqual(["capture_signature", "build_invoice", "collect_payment"]);
    expect(STEP_DEFS.filter((s) => s.group === "run")).toHaveLength(2);
  });
  it("pins the how lines to the real buttons", () => {
    const how = Object.fromEntries(STEP_DEFS.map((s) => [s.id, s.how]));
    expect(how.start_job).toBe("Open your job in the list. Tap On my way when you leave. Tap I've arrived at the door, then Working.");
    expect(how.finish_job).toBe("Tap Done when your part is finished. If Close out shows instead, tap that.");
    expect(how.clock_in).toBe("Tap Clock in above your jobs list, not the one on a job. Tap Clock out when you're done.");
    expect(how.share_location).toBe("Turn on Share my location at the top of the screen.");
    expect(how.add_material).toBe("On the job, under Materials used, pick an item from the pricebook or type one in, then tap Add.");
    expect(how.note_or_photo).toBe("On the job, write an on-site note and tap Save note, or add a photo under Photos.");
    expect(how.capture_signature).toBe("On the job, under Customer signature, hand the phone to the customer, then tap Save signature. Only the lead technician can do this.");
    expect(how.build_invoice).toBe("On the job, tap Open invoice, then Create invoice if there isn't one. Check the lines, tap Customer approval, and have the customer sign and tap Approve and finalize. Only the lead technician builds the invoice.");
    expect(how.collect_payment).toBe("After the customer approves, record cash or a check in the sheet that opens, or tap Send pay link.");
  });
  it("pins titles and why lines", () => {
    const t = Object.fromEntries(STEP_DEFS.map((s) => [s.id, [s.title, s.why]]));
    expect(t.start_job).toEqual(["Start your first job", "The office sees where you are without calling you."]);
    expect(t.finish_job).toEqual(["Finish a job", "Done tells the office your part is finished. Close out finishes the whole request."]);
    expect(t.clock_in).toEqual(["Clock in for the day", "Your hours land on the office timesheet without a paper form."]);
    expect(t.share_location).toEqual(["Share your location while working", "Dispatch sends the nearest technician to the next job."]);
    expect(t.add_material).toEqual(["Add a part you used", "Parts you add here land on the invoice, so nothing is billed from memory."]);
    expect(t.note_or_photo).toEqual(["Add a note or a photo", "The office and the next technician see what you saw."]);
    expect(t.capture_signature).toEqual(["Get the customer's signature", "Proof the work was approved, kept on the job."]);
    expect(t.build_invoice).toEqual(["Build the invoice and get it approved", "The invoice goes out while you're still on site."]);
    expect(t.collect_payment).toEqual(["Collect payment on site", "Cash and checks are recorded on the spot. A pay link lets the customer pay by phone."]);
  });
});

describe("deriveGuide", () => {
  it("fresh technician: 0 of 2, up next start_job with the no-job note, nothing to stamp", () => {
    const d = deriveGuide(signals(), NOW);
    expect(d.progress).toEqual({ requiredDone: 0, requiredTotal: 2, optionalDone: 0, optionalTotal: 7 });
    expect(d.upNext).toBe("start_job");
    expect(d.finished).toBe(false);
    expect(d.newStamps).toEqual({});
    expect(d.steps[0].note).toBe(NO_JOB_NOTE);
    expect(NO_JOB_NOTE).toBe("The office hasn't assigned you a job yet. It shows in your jobs when they do.");
  });
  it("no note once a job is open", () => {
    expect(deriveGuide(signals({ hasOpenJob: true }), NOW).steps[0].note).toBeUndefined();
  });
  it("a true signal is done and stamped now", () => {
    const d = deriveGuide(signals({ startJob: true }), NOW);
    expect(d.steps[0].done).toBe(true);
    expect(d.newStamps).toEqual({ start_job: NOW.toISOString() });
    expect(d.upNext).toBe("finish_job");
  });
  it("a stamped step stays done when the signal is false, and is not re-stamped", () => {
    const d = deriveGuide(signals({}, { firstCompleted: { start_job: "2026-11-01T00:00:00.000Z" } }), NOW);
    expect(d.steps[0].done).toBe(true);
    expect(d.newStamps).toEqual({});
  });
  it("finished when both required are done; up next moves to the first optional", () => {
    const d = deriveGuide(signals({ startJob: true, finishJob: true }), NOW);
    expect(d.finished).toBe(true);
    expect(d.progress.requiredDone).toBe(2);
    expect(d.upNext).toBe("clock_in");
  });
  it("upNext is null when everything is done", () => {
    const all = Object.fromEntries(Object.keys(ALL_FALSE).map((k) => [k, true])) as Partial<Signals>;
    expect(deriveGuide(signals(all), NOW).upNext).toBeNull();
  });
  it("upNext helper prefers required", () => {
    const d = deriveGuide(signals({ clockIn: true }), NOW);
    expect(upNext(d.steps)).toBe("start_job");
  });
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Write `src/lib/tech/guide-steps.ts`**

```ts
import type { GuideState, StepId } from "./guide-state";

/** Step table + pure derivation (spec §3/§4). Imports only types: safe for client code. */

export interface StepDef {
  id: StepId;
  group: "run" | "further";
  title: string;
  why: string;
  how: string;
  required: boolean;
  leadOnly: boolean;
}

export interface DerivedStep extends StepDef {
  done: boolean;
  note?: string;
}

export interface GuideProgress {
  requiredDone: number;
  requiredTotal: 2;
  optionalDone: number;
  optionalTotal: 7;
}

export interface Signals {
  startJob: boolean;
  finishJob: boolean;
  clockIn: boolean;
  shareLocation: boolean;
  addMaterial: boolean;
  noteOrPhoto: boolean;
  captureSignature: boolean;
  buildInvoice: boolean;
  collectPayment: boolean;
  hasOpenJob: boolean;
  state: GuideState;
}

export interface GuidePayload {
  steps: DerivedStep[];
  progress: GuideProgress;
  upNext: StepId | null;
  finished: boolean;
  hasOpenJob: boolean;
  hiddenAt: string | null;
  cardHidden: boolean;
}

export const NO_JOB_NOTE = "The office hasn't assigned you a job yet. It shows in your jobs when they do.";

const run = (id: StepId, title: string, why: string, how: string): StepDef =>
  ({ id, group: "run", title, why, how, required: true, leadOnly: false });
const further = (id: StepId, title: string, why: string, how: string, leadOnly = false): StepDef =>
  ({ id, group: "further", title, why, how, required: false, leadOnly });

export const STEP_DEFS: readonly StepDef[] = [
  run("start_job", "Start your first job", "The office sees where you are without calling you.", "Open your job in the list. Tap On my way when you leave. Tap I've arrived at the door, then Working."),
  run("finish_job", "Finish a job", "Done tells the office your part is finished. Close out finishes the whole request.", "Tap Done when your part is finished. If Close out shows instead, tap that."),
  further("clock_in", "Clock in for the day", "Your hours land on the office timesheet without a paper form.", "Tap Clock in above your jobs list, not the one on a job. Tap Clock out when you're done."),
  further("share_location", "Share your location while working", "Dispatch sends the nearest technician to the next job.", "Turn on Share my location at the top of the screen."),
  further("add_material", "Add a part you used", "Parts you add here land on the invoice, so nothing is billed from memory.", "On the job, under Materials used, pick an item from the pricebook or type one in, then tap Add."),
  further("note_or_photo", "Add a note or a photo", "The office and the next technician see what you saw.", "On the job, write an on-site note and tap Save note, or add a photo under Photos."),
  further("capture_signature", "Get the customer's signature", "Proof the work was approved, kept on the job.", "On the job, under Customer signature, hand the phone to the customer, then tap Save signature. Only the lead technician can do this.", true),
  further("build_invoice", "Build the invoice and get it approved", "The invoice goes out while you're still on site.", "On the job, tap Open invoice, then Create invoice if there isn't one. Check the lines, tap Customer approval, and have the customer sign and tap Approve and finalize. Only the lead technician builds the invoice.", true),
  further("collect_payment", "Collect payment on site", "Cash and checks are recorded on the spot. A pay link lets the customer pay by phone.", "After the customer approves, record cash or a check in the sheet that opens, or tap Send pay link.", true),
];

const SIGNAL_KEY: Record<StepId, keyof Omit<Signals, "hasOpenJob" | "state">> = {
  start_job: "startJob", finish_job: "finishJob", clock_in: "clockIn", share_location: "shareLocation",
  add_material: "addMaterial", note_or_photo: "noteOrPhoto", capture_signature: "captureSignature",
  build_invoice: "buildInvoice", collect_payment: "collectPayment",
};

/** First not-done required step, else first not-done optional step. */
export function upNext(steps: readonly DerivedStep[]): StepId | null {
  return (steps.find((s) => s.required && !s.done) ?? steps.find((s) => !s.required && !s.done))?.id ?? null;
}

export function deriveGuide(s: Signals, now: Date): {
  steps: DerivedStep[]; progress: GuideProgress; upNext: StepId | null; finished: boolean;
  newStamps: Partial<Record<StepId, string>>;
} {
  const nowIso = now.toISOString();
  const newStamps: Partial<Record<StepId, string>> = {};
  const steps = STEP_DEFS.map((def) => {
    const stamped = Boolean(s.state.firstCompleted[def.id]);
    const live = s[SIGNAL_KEY[def.id]];
    const done = stamped || live;
    if (!stamped && live) newStamps[def.id] = nowIso;
    const note = def.id === "start_job" && !done && !s.hasOpenJob ? NO_JOB_NOTE : undefined;
    return { ...def, done, ...(note ? { note } : {}) };
  });
  const count = (required: boolean) => steps.filter((x) => x.required === required && x.done).length;
  const requiredDone = count(true);
  return {
    steps,
    progress: { requiredDone, requiredTotal: 2, optionalDone: count(false), optionalTotal: 7 },
    upNext: upNext(steps),
    finished: requiredDone === 2,
    newStamps,
  };
}
```

- [ ] **Step 4: Run the derivation tests** — PASS.

- [ ] **Step 5: Copy module + test** — `src/lib/tech/guide-copy.ts`:

```ts
/** Exact UI strings for the getting-started guide (spec §6). Do not reword. */
export const GUIDE_COPY = {
  cardTitle: "Getting started",
  pageTitle: "Getting started",
  guideLink: "Guide",
  back: "Back",
  upNext: "Up next",
  seeAll: "See all steps",
  goToJobs: "Go to my jobs",
  openJob: "Open the job",
  runTitle: "Run a job",
  furtherTitle: "Go further",
  leadOnly: "Lead only",
  hideAria: "Hide the guide from your jobs",
  closeAria: "Close the getting started card",
  progressAria: "Getting started progress",
  hint: "Tap Guide at the top to see it again.",
  updateFailed: "Couldn't update the guide. Please try again.",
  loadFailed: "Couldn't load the guide.",
  tryAgain: "Try again",
  loading: "Loading…",
  finishedTitle: "You've run a job start to finish",
  finishedLines: ["You started a job", "You finished a job"] as const,
  finishedRest: "The rest are optional. Pick them up when they're useful.",
  upcomingNote: "Your next job is under Upcoming.",
  srDone: "Done",
  srUpNext: "Up next",
  srTodo: "To do",
} as const;

/** "1 of 2 done" / "N of 7" labels. */
export function progressLabel(done: number, total: number, suffix = " done"): string {
  return `${done} of ${total}${suffix}`;
}
```

`src/lib/tech/guide-copy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { GUIDE_COPY, progressLabel } from "./guide-copy";

describe("GUIDE_COPY", () => {
  it("pins the surface strings", () => {
    expect(GUIDE_COPY).toMatchObject({
      cardTitle: "Getting started", pageTitle: "Getting started", guideLink: "Guide", back: "Back",
      upNext: "Up next", seeAll: "See all steps", goToJobs: "Go to my jobs", openJob: "Open the job",
      runTitle: "Run a job", furtherTitle: "Go further", leadOnly: "Lead only",
      hideAria: "Hide the guide from your jobs", closeAria: "Close the getting started card",
      progressAria: "Getting started progress", hint: "Tap Guide at the top to see it again.",
      updateFailed: "Couldn't update the guide. Please try again.", loadFailed: "Couldn't load the guide.",
      tryAgain: "Try again", loading: "Loading…",
      finishedTitle: "You've run a job start to finish", finishedRest: "The rest are optional. Pick them up when they're useful.",
      upcomingNote: "Your next job is under Upcoming.", srDone: "Done", srUpNext: "Up next", srTodo: "To do",
    });
    expect(GUIDE_COPY.finishedLines).toEqual(["You started a job", "You finished a job"]);
  });
  it("uses the Unicode ellipsis and no trailing period on the finished title", () => {
    expect(GUIDE_COPY.loading).toBe("Loading…");
    expect(GUIDE_COPY.finishedTitle.endsWith(".")).toBe(false);
  });
});

describe("progressLabel", () => {
  it("formats done of total", () => {
    expect(progressLabel(1, 2)).toBe("1 of 2 done");
    expect(progressLabel(3, 7, "")).toBe("3 of 7");
  });
});
```

- [ ] **Step 6: Failing tests for the queries** — `src/lib/tech/guide-queries.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
const execute = vi.fn();
vi.mock("@/lib/db", () => ({ db: { execute: (...a: unknown[]) => execute(...a) } }));
const warn = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: { warn: (...a: unknown[]) => warn(...a), error: vi.fn() }, errorCode: () => "X" }));

import { getGuide, hideGuide, readGuideHidden } from "./guide-queries";

const ORG = "o", USER = "u";
const NOW = new Date("2026-11-05T12:00:00.000Z");
const row = (over: Record<string, unknown> = {}) => ({
  start_job: false, finish_job: false, clock_in: false, share_location: false, add_material: false,
  note_or_photo: false, capture_signature: false, build_invoice: false, collect_payment: false,
  has_open_job: false, field_guide_state: null, ...over,
});

beforeEach(() => { execute.mockReset(); warn.mockReset(); });

describe("getGuide", () => {
  it("one SELECT and no stamp when nothing is new", async () => {
    execute.mockResolvedValueOnce({ rows: [row()] });
    const p = await getGuide(ORG, USER, NOW);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(p.progress.requiredDone).toBe(0);
    expect(p.cardHidden).toBe(false);
    expect(p.hiddenAt).toBeNull();
  });
  it("stamps new completions in a second statement and returns the derived payload from the SELECT copy", async () => {
    execute.mockResolvedValueOnce({ rows: [row({ start_job: true })] }).mockResolvedValueOnce({ rows: [] });
    const p = await getGuide(ORG, USER, NOW);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(p.steps[0].done).toBe(true);
  });
  it("a failed stamp write is logged and the payload still returns", async () => {
    execute.mockResolvedValueOnce({ rows: [row({ start_job: true })] }).mockRejectedValueOnce(new Error("boom"));
    const p = await getGuide(ORG, USER, NOW);
    expect(p.steps[0].done).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("cardHidden comes from the STORED state only", async () => {
    const old = new Date(NOW.getTime() - 25 * 3_600_000).toISOString();
    execute.mockResolvedValueOnce({ rows: [row({ finish_job: true, start_job: true, field_guide_state: { firstCompleted: { finish_job: old } } })] });
    const p = await getGuide(ORG, USER, NOW);
    expect(p.cardHidden).toBe(true);
    expect(p.finished).toBe(true);
  });
  it("a missing row derives all-false", async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    expect((await getGuide(ORG, USER, NOW)).upNext).toBe("start_job");
  });
});

describe("hideGuide", () => {
  it("returns the stored hiddenAt from RETURNING, null on zero rows", async () => {
    execute.mockResolvedValueOnce({ rows: [{ field_guide_state: { hiddenAt: "2026-11-01T00:00:00.000Z", firstCompleted: {} } }] });
    expect(await hideGuide(ORG, USER, NOW)).toEqual({ hiddenAt: "2026-11-01T00:00:00.000Z" });
    execute.mockResolvedValueOnce({ rows: [] });
    expect(await hideGuide(ORG, USER, NOW)).toBeNull();
  });
});

describe("readGuideHidden", () => {
  it("true for hiddenAt or a day-old finish stamp, false otherwise, false on a thrown select", async () => {
    execute.mockResolvedValueOnce({ rows: [{ field_guide_state: { hiddenAt: "2026-11-01T00:00:00.000Z" } }] });
    expect(await readGuideHidden(ORG, USER, NOW)).toBe(true);
    execute.mockResolvedValueOnce({ rows: [{ field_guide_state: { firstCompleted: { finish_job: new Date(NOW.getTime() - 25 * 3_600_000).toISOString() } } }] });
    expect(await readGuideHidden(ORG, USER, NOW)).toBe(true);
    execute.mockResolvedValueOnce({ rows: [{ field_guide_state: null }] });
    expect(await readGuideHidden(ORG, USER, NOW)).toBe(false);
    execute.mockRejectedValueOnce(new Error("down"));
    expect(await readGuideHidden(ORG, USER, NOW)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run, expect failure.**

- [ ] **Step 8: Write `src/lib/tech/guide-queries.ts`**

```ts
import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { logger, errorCode } from "@/lib/logger";
import { cardHiddenFor, parseGuideState } from "./guide-state";
import { guideHideSql, guideSelectSql, guideStampSql } from "./guide-sql";
import { deriveGuide, type GuidePayload, type Signals } from "./guide-steps";

type Row = Record<string, unknown>;

function signalsFromRow(row: Row): Signals {
  const b = (k: string) => row[k] === true;
  return {
    startJob: b("start_job"), finishJob: b("finish_job"), clockIn: b("clock_in"),
    shareLocation: b("share_location"), addMaterial: b("add_material"), noteOrPhoto: b("note_or_photo"),
    captureSignature: b("capture_signature"), buildInvoice: b("build_invoice"), collectPayment: b("collect_payment"),
    hasOpenJob: b("has_open_job"),
    state: parseGuideState(row.field_guide_state),
  };
}

/** GET: one SELECT, then the stamp statement only when something new completed. */
export async function getGuide(organizationId: string, userId: string, now: Date = new Date()): Promise<GuidePayload> {
  const res = await db.execute(guideSelectSql(organizationId, userId));
  const signals = signalsFromRow((res.rows[0] ?? {}) as Row);
  const d = deriveGuide(signals, now);
  if (Object.keys(d.newStamps).length > 0) {
    try {
      await db.execute(guideStampSql({ organizationId, userId, newStamps: d.newStamps }));
    } catch (error) {
      logger.warn({ code: errorCode(error), organizationId, userId }, "Field guide stamp write failed; returning the derived payload");
    }
  }
  return {
    steps: d.steps, progress: d.progress, upNext: d.upNext, finished: d.finished,
    hasOpenJob: signals.hasOpenJob,
    hiddenAt: signals.state.hiddenAt ?? null,
    cardHidden: cardHiddenFor(signals.state, now),
  };
}

/** PATCH: write-once hide. Null when the row is not a live technician of the org. */
export async function hideGuide(organizationId: string, userId: string, now: Date = new Date()): Promise<{ hiddenAt: string } | null> {
  const res = await db.execute(guideHideSql({ organizationId, userId, hiddenAt: now.toISOString() }));
  const row = res.rows[0] as Row | undefined;
  if (!row) return null;
  const state = parseGuideState(row.field_guide_state);
  return { hiddenAt: state.hiddenAt ?? now.toISOString() };
}

/** Server-side read for the jobs page: never throws. */
export async function readGuideHidden(organizationId: string, userId: string, now: Date = new Date()): Promise<boolean> {
  try {
    const res = await db.execute(sql`SELECT field_guide_state FROM users WHERE id = ${userId} AND organization_id = ${organizationId}`);
    const row = res.rows[0] as Row | undefined;
    return cardHiddenFor(parseGuideState(row?.field_guide_state), now);
  } catch (error) {
    logger.warn({ code: errorCode(error), organizationId, userId }, "Field guide hidden read failed; showing the card");
    return false;
  }
}
```

- [ ] **Step 9: Run all Task 2 tests** — PASS. Gates + commit:

```bash
npx tsc --noEmit && npx eslint src/lib/tech/guide-steps.ts src/lib/tech/guide-steps.test.ts src/lib/tech/guide-copy.ts src/lib/tech/guide-copy.test.ts src/lib/tech/guide-queries.ts src/lib/tech/guide-queries.test.ts && npx vitest run
git add src/lib/tech/guide-steps.ts src/lib/tech/guide-steps.test.ts src/lib/tech/guide-copy.ts src/lib/tech/guide-copy.test.ts src/lib/tech/guide-queries.ts src/lib/tech/guide-queries.test.ts
git commit -m "feat(tech-guide): step derivation, copy, and the guide queries"
```

---

### Task 3: Routes, refresh event, location-toggle dispatch, integration suite

**Files:**
- Create: `src/app/api/tech/guide/route.ts`, `src/app/api/tech/guide/route.test.ts`, `src/lib/tech/guide-refresh.ts`, `src/lib/tech/guide-refresh.test.ts`, `tests/integration/tech-guide.test.ts`
- Modify: `vitest.config.ts` (`INTEGRATION_SUITES`), `src/components/tech/tech-location-tracker.tsx`

**Interfaces:**
- Consumes: `getGuide`, `hideGuide`, `guideSelectSql`, `guideStampSql` (Tasks 1–2); `getTechSession`, `isSameOriginRequest`, `slidingWindow`, `RATE_LIMITS`, `readJsonBody`, `successResponse`, `errorResponse`, `createOrgCore`.
- Produces: `GET /api/tech/guide` → `successResponse(GuidePayload)`; `PATCH /api/tech/guide` `{ hidden: true }` → `successResponse({ hiddenAt })`; `GUIDE_REFRESH_EVENT = "tech:guide:refresh"`, `dispatchGuideRefresh(target?)`, `subscribeGuideRefresh(cb, target?)` → unsubscribe (guide-refresh.ts).

- [ ] **Step 1: Failing route tests** — `src/app/api/tech/guide/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: vi.fn() }));
vi.mock("@/lib/tech/guide-queries", () => ({ getGuide: vi.fn(), hideGuide: vi.fn() }));
vi.mock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), slidingWindow: () => ({ allowed: true }) }));

import { GET, PATCH } from "./route";
import { getTechSession } from "@/lib/auth/tech-session";
import { getGuide, hideGuide } from "@/lib/tech/guide-queries";
import { NextRequest } from "next/server";

const session = { userId: "u", organizationId: "o", email: "t@x", name: "T", role: "technician" as const };
const patch = (body: unknown, headers: Record<string, string> = { origin: "http://localhost:3000" }) =>
  new NextRequest("http://localhost:3000/api/tech/guide", { method: "PATCH", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  (getTechSession as unknown as Mock).mockResolvedValue(session);
  (getGuide as unknown as Mock).mockResolvedValue({ steps: [], progress: { requiredDone: 0, requiredTotal: 2, optionalDone: 0, optionalTotal: 7 }, upNext: "start_job", finished: false, hasOpenJob: false, hiddenAt: null, cardHidden: false });
  (hideGuide as unknown as Mock).mockResolvedValue({ hiddenAt: "2026-11-05T00:00:00.000Z" });
});

describe("GET /api/tech/guide", () => {
  it("401 without a session", async () => {
    (getTechSession as unknown as Mock).mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(getGuide).not.toHaveBeenCalled();
  });
  it("returns the payload for the session's org and user", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(getGuide).toHaveBeenCalledWith("o", "u");
    expect((await res.json()).data.upNext).toBe("start_job");
  });
  it("500 with human copy when the query throws", async () => {
    (getGuide as unknown as Mock).mockRejectedValue(new Error("x"));
    const res = await GET();
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toBe("Couldn't load the guide.");
  });
});

describe("PATCH /api/tech/guide", () => {
  it("401 without a session (Origin present)", async () => {
    (getTechSession as unknown as Mock).mockResolvedValue(null);
    expect((await PATCH(patch({ hidden: true }))).status).toBe(401);
  });
  it("403 on a missing or foreign Origin", async () => {
    expect((await PATCH(patch({ hidden: true }, {}))).status).toBe(403);
    expect((await PATCH(patch({ hidden: true }, { origin: "https://evil.example" }))).status).toBe(403);
    expect(hideGuide).not.toHaveBeenCalled();
  });
  it("400 on {} and on { hidden: false }", async () => {
    expect((await PATCH(patch({}))).status).toBe(400);
    expect((await PATCH(patch({ hidden: false }))).status).toBe(400);
  });
  it("hides and returns hiddenAt", async () => {
    const res = await PATCH(patch({ hidden: true }));
    expect(res.status).toBe(200);
    expect(hideGuide).toHaveBeenCalledWith("o", "u");
    expect((await res.json()).data).toEqual({ hiddenAt: "2026-11-05T00:00:00.000Z" });
  });
  it("404 when no technician row matched", async () => {
    (hideGuide as unknown as Mock).mockResolvedValue(null);
    expect((await PATCH(patch({ hidden: true }))).status).toBe(404);
  });
});
```

Check the error envelope shape in `src/lib/api-response.ts` (`errorResponse`) and adjust the 500 assertion's path (`error.message` vs `error`) to match it exactly.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Write `src/app/api/tech/guide/route.ts`**

```ts
/**
 * Technician getting-started guide (spec 2026-11-05).
 * GET   → the derived steps + progress for the session's technician (stamps new completions).
 * PATCH { hidden: true } → hides the jobs-list card for this technician (write-once).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { getTechSession } from "@/lib/auth/tech-session";
import { getGuide, hideGuide } from "@/lib/tech/guide-queries";
import { isSameOriginRequest } from "@/lib/session-csrf";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { logger, errorCode } from "@/lib/logger";

export const dynamic = "force-dynamic";

const patchSchema = z.strictObject({ hidden: z.literal(true) });

export async function GET() {
  try {
    const session = await getTechSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`tech:guide-get:${session.userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    return successResponse(await getGuide(session.organizationId, session.userId));
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to load the technician guide");
    return errorResponse("Couldn't load the guide.", "INTERNAL_ERROR", 500);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getTechSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    if (!isSameOriginRequest(request)) return errorResponse("Forbidden", "FORBIDDEN", 403);
    const rate = slidingWindow(`tech:guide-patch:${session.userId}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    const body = await readJsonBody(request);
    const parsed = body.ok ? patchSchema.safeParse(body.data) : null;
    if (!parsed?.success) return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    const result = await hideGuide(session.organizationId, session.userId);
    if (!result) return errorResponse("Technician not found", "NOT_FOUND", 404);
    return successResponse(result);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to update the technician guide");
    return errorResponse("Couldn't update the guide. Please try again.", "INTERNAL_ERROR", 500);
  }
}
```

- [ ] **Step 4: Run the route tests** — PASS.

- [ ] **Step 5: Refresh event module + test**

`src/lib/tech/guide-refresh.ts`:

```ts
/** One window event tells the guide card and page to refetch (spec §2). */
export const GUIDE_REFRESH_EVENT = "tech:guide:refresh";

function defaultTarget(): EventTarget | undefined {
  return typeof window === "undefined" ? undefined : window;
}

export function dispatchGuideRefresh(target: EventTarget | undefined = defaultTarget()): void {
  target?.dispatchEvent(new Event(GUIDE_REFRESH_EVENT));
}

export function subscribeGuideRefresh(cb: () => void, target: EventTarget | undefined = defaultTarget()): () => void {
  if (!target) return () => {};
  target.addEventListener(GUIDE_REFRESH_EVENT, cb);
  return () => target.removeEventListener(GUIDE_REFRESH_EVENT, cb);
}
```

`src/lib/tech/guide-refresh.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { GUIDE_REFRESH_EVENT, dispatchGuideRefresh, subscribeGuideRefresh } from "./guide-refresh";

describe("guide refresh event", () => {
  it("names the event", () => expect(GUIDE_REFRESH_EVENT).toBe("tech:guide:refresh"));
  it("delivers once per dispatch and stops after unsubscribe", () => {
    const target = new EventTarget();
    const cb = vi.fn();
    const off = subscribeGuideRefresh(cb, target);
    dispatchGuideRefresh(target);
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    dispatchGuideRefresh(target);
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it("is a no-op without a target", () => {
    expect(() => dispatchGuideRefresh(undefined)).not.toThrow();
    expect(typeof subscribeGuideRefresh(() => {}, undefined)).toBe("function");
  });
});
```

- [ ] **Step 6: Location toggle dispatch** — in `src/components/tech/tech-location-tracker.tsx`, add `import { dispatchGuideRefresh } from '@/lib/tech/guide-refresh';` and call `dispatchGuideRefresh();` on the line right after `setEnabled(next);` inside the `res.ok` branch of `toggle` (both directions).

- [ ] **Step 7: Integration suite** — add `"tests/integration/tech-guide.test.ts",` to `INTEGRATION_SUITES` in `vitest.config.ts` with the comment `// Technician getting-started guide: derivation + stamps against the dev DB (two throwaway orgs).` Write `tests/integration/tech-guide.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Integration suite for the technician getting-started guide (dev DB only,
 * VITEST_INTEGRATION=1). Two throwaway orgs via createOrgCore, deleted in
 * afterAll. Every UPDATE carries the row id AND the org id.
 */

type Q = typeof import("@/lib/tech/guide-queries");
type S = typeof import("@/lib/tech/guide-sql");
type Db = typeof import("@/lib/db");
type Row = Record<string, unknown>;

let q: Q;
let s: S;
let db: Db["db"];
let sql: typeof import("drizzle-orm").sql;
let org1 = "";
let org2 = "";
let lead = "";
let helper = "";
let helperRow = "";
let techB = "";

async function run(statement: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute(statement)).rows as Row[];
}

async function stateOf(user: string, org: string): Promise<Row | null> {
  const rows = await run(sql`SELECT field_guide_state AS st FROM users WHERE id = ${user} AND organization_id = ${org}`);
  return (rows[0]?.st as Row | null) ?? null;
}

async function tech(org: string, active = true): Promise<string> {
  return (await run(sql`INSERT INTO users (organization_id,email,name,role,password_hash,is_active) VALUES (${org},'tech-'||gen_random_uuid()||'@throwaway.example','Guide Probe Technician','technician','x',${active}) RETURNING id`))[0].id as string;
}

/** Request assigned to the lead (the 0050 trigger makes visit #1 + the lead row), then the helper's row. */
async function seedJob(org: string, leadId: string, helperId: string): Promise<{ rid: string; appt: string; row: string }> {
  const sess = (await run(sql`INSERT INTO customer_sessions (organization_id,token) VALUES (${org},gen_random_uuid()::text) RETURNING id`))[0].id as string;
  const rid = (await run(sql`INSERT INTO service_requests (organization_id,session_id,assigned_to,issue_type,urgency,description,reference_number,scheduled_date,status) VALUES (${org},${sess},${leadId},'no_heat','medium','Guide probe','GPR-'||substr(md5(random()::text),1,8),now(),'assigned'::request_status) RETURNING id`))[0].id as string;
  const appt = (await run(sql`SELECT id FROM appointments WHERE service_request_id = ${rid} AND organization_id = ${org} ORDER BY appointment_number LIMIT 1`))[0].id as string;
  const row = (await run(sql`INSERT INTO appointment_assignments (organization_id,appointment_id,technician_id,is_lead,status) VALUES (${org},${appt},${helperId},false,'assigned'::request_status) RETURNING id`))[0].id as string;
  return { rid, appt, row };
}

beforeAll(async () => {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL missing from .env.local");
  if (url.includes("ep-withered-hill")) throw new Error("Refusing to run against the production database");
  ({ sql } = await import("drizzle-orm"));
  ({ db } = await import("@/lib/db"));
  q = await import("@/lib/tech/guide-queries");
  s = await import("@/lib/tech/guide-sql");
  const { createOrgCore } = await import("@/lib/admin/provisioning");
  const make = async (label: string) => {
    const out = await createOrgCore({
      name: `Guide Probe Org ${label} ${randomUUID().slice(0, 8)}`,
      createdBy: null,
      ownerEmail: null,
      ownerUser: { email: `owner-${randomUUID()}@throwaway.example`, name: "Probe Owner", googleId: `probe-${randomUUID()}` },
      skipOrgCountCheck: true,
    });
    if (!out.ok) throw new Error(`createOrgCore failed: ${JSON.stringify(out.error)}`);
    return out.result.organizationId as string;
  };
  org1 = await make("1");
  org2 = await make("2");
  lead = await tech(org1, false);
  helper = await tech(org1);
  techB = await tech(org2);
}, 60_000);

afterAll(async () => {
  for (const id of [org1, org2]) {
    if (!id) continue;
    try {
      await db.execute(sql`DELETE FROM organizations WHERE id = ${id}`);
    } catch (error) {
      console.error(`afterAll: could not delete probe org ${id}`, error);
    }
  }
}, 60_000);

describe("technician guide (dev DB)", () => {
  it("(a) a new technician is 0 of 2 with the no-job note and nothing stamped", async () => {
    const p = await q.getGuide(org1, helper);
    expect(p.progress.requiredDone).toBe(0);
    expect(p.upNext).toBe("start_job");
    expect(p.steps[0].note).toBe("The office hasn't assigned you a job yet. It shows in your jobs when they do.");
    expect(p.cardHidden).toBe(false);
    expect(await stateOf(helper, org1)).toBeNull();
  });

  it("(b) a started row completes start_job, stamps it, and the stamp is sticky", async () => {
    ({ row: helperRow } = await seedJob(org1, lead, helper));
    expect((await q.getGuide(org1, helper)).steps[0].note).toBeUndefined();
    await db.execute(sql`UPDATE appointment_assignments SET en_route_at = now() WHERE id = ${helperRow} AND organization_id = ${org1}`);
    const p = await q.getGuide(org1, helper);
    expect(p.steps[0].done).toBe(true);
    expect(p.upNext).toBe("finish_job");
    const st = await stateOf(helper, org1);
    expect((st?.firstCompleted as Row)?.start_job).toBeDefined();
    await db.execute(sql`UPDATE appointment_assignments SET en_route_at = NULL WHERE id = ${helperRow} AND organization_id = ${org1}`);
    expect((await q.getGuide(org1, helper)).steps[0].done).toBe(true);
  });

  it("(c) a completed started row finishes the guide; the next read writes nothing", async () => {
    await db.execute(sql`UPDATE appointment_assignments SET started_at = now(), completed_at = now() WHERE id = ${helperRow} AND organization_id = ${org1}`);
    const p = await q.getGuide(org1, helper);
    expect(p.finished).toBe(true);
    expect(p.cardHidden).toBe(false);
    const before = JSON.stringify(await stateOf(helper, org1));
    expect((JSON.parse(before).firstCompleted as Row).finish_job).toBeDefined();
    await q.getGuide(org1, helper);
    expect(JSON.stringify(await stateOf(helper, org1))).toBe(before);
  });

  it("(d) hide is write-once", async () => {
    const first = await q.hideGuide(org1, helper);
    expect(first?.hiddenAt).toBeDefined();
    await new Promise((r) => setTimeout(r, 20));
    const second = await q.hideGuide(org1, helper);
    expect(second?.hiddenAt).toBe(first?.hiddenAt);
    expect((await q.getGuide(org1, helper)).cardHidden).toBe(true);
    expect(await q.readGuideHidden(org1, helper)).toBe(true);
  });

  it("(e) tenancy: technician B's rows in org 2 never count for the helper, and the org parameter gates", async () => {
    const { rid, row } = await seedJob(org2, techB, techB);
    await db.execute(sql`UPDATE appointment_assignments SET en_route_at = now(), started_at = now() WHERE id = ${row} AND organization_id = ${org2}`);
    await db.execute(sql`INSERT INTO job_materials (organization_id,service_request_id,description,created_by) VALUES (${org2},${rid},'Probe part',${techB})`);
    await db.execute(sql`INSERT INTO request_notes (organization_id,request_id,author_id,content) VALUES (${org2},${rid},${techB},'Probe note')`);
    const pb = await q.getGuide(org2, techB);
    expect(pb.steps.find((x) => x.id === "add_material")?.done).toBe(true);
    expect(pb.steps.find((x) => x.id === "note_or_photo")?.done).toBe(true);
    const fresh = await tech(org1);
    const pa = await q.getGuide(org1, fresh);
    expect(pa.steps.every((x) => !x.done)).toBe(true);
    const cross = (await run(s.guideSelectSql(org2, helper)))[0];
    for (const [k, v] of Object.entries(cross)) {
      if (k !== "field_guide_state") expect(v, k).toBe(false);
    }
  });

  it("(f) two stamp statements with disjoint keys both land", async () => {
    const fresh = await tech(org1);
    const iso = new Date().toISOString();
    await Promise.all([
      db.execute(s.guideStampSql({ organizationId: org1, userId: fresh, newStamps: { clock_in: iso } })),
      db.execute(s.guideStampSql({ organizationId: org1, userId: fresh, newStamps: { add_material: iso } })),
    ]);
    const st = await stateOf(fresh, org1);
    expect(Object.keys((st?.firstCompleted as Row) ?? {}).sort()).toEqual(["add_material", "clock_in"]);
  });

  it("(g) a day-old finish stamp hides the card server-side and in the payload", async () => {
    const fresh = await tech(org1);
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
    await db.execute(s.guideStampSql({ organizationId: org1, userId: fresh, newStamps: { start_job: old, finish_job: old } }));
    expect(await q.readGuideHidden(org1, fresh)).toBe(true);
    expect((await q.getGuide(org1, fresh)).cardHidden).toBe(true);
  });
});
```

Check the NOT NULL columns of `job_materials` and `request_notes` in `src/lib/db/schema.ts` before running; add any required column the INSERTs omit. Run: `VITEST_INTEGRATION=1 npx vitest run tests/integration/tech-guide.test.ts` → 7 green. Then confirm no leftovers: `SELECT count(*) FROM organizations WHERE name LIKE 'Guide Probe Org%'` = 0.

- [ ] **Step 8: Gates + commit**

```bash
npx tsc --noEmit && npx eslint src/app/api/tech/guide/route.ts src/app/api/tech/guide/route.test.ts src/lib/tech/guide-refresh.ts src/lib/tech/guide-refresh.test.ts src/components/tech/tech-location-tracker.tsx tests/integration/tech-guide.test.ts vitest.config.ts && npx vitest run
git add src/app/api/tech/guide src/lib/tech/guide-refresh.ts src/lib/tech/guide-refresh.test.ts src/components/tech/tech-location-tracker.tsx tests/integration/tech-guide.test.ts vitest.config.ts
git commit -m "feat(tech-guide): GET/PATCH routes, refresh event from the location toggle, integration suite"
```

---

### Task 4: Card on the jobs list, server-side hidden read, header link

**Files:**
- Create: `src/lib/tech/guide-view.ts`, `src/lib/tech/guide-view.test.ts`, `src/hooks/use-tech-guide.ts`, `src/components/tech/guide-progress.tsx`, `src/components/tech/guide-finished.tsx`, `src/components/tech/guide-card.tsx`, `src/components/tech/guide-link.tsx`
- Modify: `src/components/tech/tech-jobs-list-client.tsx`, `src/app/tech/jobs/page.tsx`, `src/app/tech/layout.tsx`

**Interfaces:**
- Consumes: `GuidePayload`, `DerivedStep` (types), `GUIDE_COPY`, `progressLabel`, `subscribeGuideRefresh`, `readGuideHidden`, `getTechSession`.
- Produces: `useTechGuide()` → `{ data: GuidePayload | null, status: 'loading' | 'ok' | 'failed', reload(): Promise<void> }`; `cardState`, `pickTodayFirst`, `cardNote`, `glyphFor`, `TodayFirst`, `Glyph` (guide-view.ts); `<GuideProgress done total showLabel? />`; `<GuideFinished />`; `<GuideCard todayFirst todaySettled onHidden />`; `<GuideLink />`; `TechJobsListClient` prop `guideHidden: boolean`.

- [ ] **Step 1: Failing view tests** — `src/lib/tech/guide-view.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { cardState, pickTodayFirst, cardNote, glyphFor } from "./guide-view";
import type { DerivedStep, GuidePayload } from "./guide-steps";

const base: GuidePayload = { steps: [], progress: { requiredDone: 0, requiredTotal: 2, optionalDone: 0, optionalTotal: 7 }, upNext: "start_job", finished: false, hasOpenJob: false, hiddenAt: null, cardHidden: false };
const opts = { loading: false, failed: false, slowElapsed: true, guideHidden: false, todaySettled: true };
const step = { id: "start_job", note: "no job" } as unknown as DerivedStep;
const noNote = { id: "start_job" } as unknown as DerivedStep;

describe("cardState", () => {
  it("hidden server-side never fetches", () => expect(cardState(null, { ...opts, guideHidden: true, loading: true })).toBe("hidden"));
  it("hidden on the payload flag", () => expect(cardState({ ...base, cardHidden: true }, opts)).toBe("hidden"));
  it("nothing before 300 ms, skeleton after, while loading", () => {
    expect(cardState(null, { ...opts, loading: true, slowElapsed: false })).toBe("nothing");
    expect(cardState(null, { ...opts, loading: true })).toBe("skeleton");
  });
  it("waits for the Today fetch to settle", () => {
    expect(cardState(base, { ...opts, todaySettled: false })).toBe("skeleton");
    expect(cardState(base, opts)).toBe("card");
  });
  it("nothing on a failed first load; a kept payload still shows", () => {
    expect(cardState(null, { ...opts, failed: true })).toBe("nothing");
    expect(cardState(base, { ...opts, failed: true })).toBe("card");
  });
  it("finished block", () => expect(cardState({ ...base, finished: true }, opts)).toBe("finished"));
});

describe("pickTodayFirst", () => {
  const j = (id: string, assignmentStatus: string) => ({ id, appointmentId: `a-${id}`, assignmentStatus });
  it("prefers an in-progress, arrived or en-route row, else the first row, null when empty", () => {
    expect(pickTodayFirst([j("1", "assigned"), j("2", "en_route")])).toEqual({ href: "/tech/jobs/2?visit=a-2" });
    expect(pickTodayFirst([j("1", "assigned"), j("2", "scheduled")])).toEqual({ href: "/tech/jobs/1?visit=a-1" });
    expect(pickTodayFirst([])).toBeNull();
  });
});

describe("cardNote", () => {
  it("server note first, then the Upcoming hint only when Today loaded empty", () => {
    expect(cardNote(step, false, null)).toBe("no job");
    expect(cardNote(noNote, true, null)).toBe("Your next job is under Upcoming.");
    expect(cardNote(noNote, true, { href: "/x" })).toBeUndefined();
    expect(cardNote(noNote, true, "unknown")).toBeUndefined();
    expect(cardNote(noNote, false, null)).toBeUndefined();
  });
});

describe("glyphFor", () => {
  it("done / next / todo", () => {
    expect(glyphFor({ id: "start_job", done: true }, "finish_job")).toBe("done");
    expect(glyphFor({ id: "finish_job", done: false }, "finish_job")).toBe("next");
    expect(glyphFor({ id: "clock_in", done: false }, "finish_job")).toBe("todo");
  });
});
```

- [ ] **Step 2: Run, expect failure. Then write `src/lib/tech/guide-view.ts`:**

```ts
import type { DerivedStep, GuidePayload } from "./guide-steps";
import type { StepId } from "./guide-state";
import { GUIDE_COPY } from "./guide-copy";

/** Pure view decisions for the guide card and page (spec §6). No DOM. */

export type TodayFirst = { href: string } | null | "unknown";
export type CardState = "nothing" | "skeleton" | "card" | "finished" | "hidden";
export type Glyph = "done" | "next" | "todo";

export function cardState(
  payload: GuidePayload | null,
  o: { loading: boolean; failed: boolean; slowElapsed: boolean; guideHidden: boolean; todaySettled: boolean },
): CardState {
  if (o.guideHidden || payload?.cardHidden) return "hidden";
  if (!payload) {
    if (o.failed) return "nothing";
    return o.slowElapsed ? "skeleton" : "nothing";
  }
  if (!o.todaySettled) return o.slowElapsed ? "skeleton" : "nothing";
  return payload.finished ? "finished" : "card";
}

const ACTIVE = new Set(["in_progress", "arrived", "en_route"]);

/** The Today row the card's button opens: an active row first, else the first row. */
export function pickTodayFirst(rows: ReadonlyArray<{ id: string; appointmentId: string; assignmentStatus: string }>): { href: string } | null {
  const row = rows.find((r) => ACTIVE.has(r.assignmentStatus)) ?? rows[0];
  return row ? { href: `/tech/jobs/${row.id}?visit=${row.appointmentId}` } : null;
}

/** The server note wins; the Upcoming hint only when Today succeeded with no rows. */
export function cardNote(step: DerivedStep, hasOpenJob: boolean, todayFirst: TodayFirst): string | undefined {
  if (step.note) return step.note;
  if (step.id === "start_job" && hasOpenJob && todayFirst === null) return GUIDE_COPY.upcomingNote;
  return undefined;
}

export function glyphFor(step: Pick<DerivedStep, "id" | "done">, upNext: StepId | null): Glyph {
  if (step.done) return "done";
  return step.id === upNext ? "next" : "todo";
}
```

- [ ] **Step 3: Hook** — `src/hooks/use-tech-guide.ts`:

```ts
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GuidePayload } from '@/lib/tech/guide-steps';
import { subscribeGuideRefresh } from '@/lib/tech/guide-refresh';

/** Fetches /api/tech/guide on mount and on the refresh event; keeps the last good payload. */
export function useTechGuide() {
  const [data, setData] = useState<GuidePayload | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'failed'>('loading');
  const seq = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const mine = ++seq.current;
    try {
      const res = await fetch('/api/tech/guide');
      const body = await res.json().catch(() => null);
      if (mine !== seq.current) return;
      if (res.ok && body?.success) {
        setData(body.data as GuidePayload);
        setStatus('ok');
      } else {
        setStatus('failed');
      }
    } catch {
      if (mine === seq.current) setStatus('failed');
    }
  }, []);

  useEffect(() => {
    void reload();
    return subscribeGuideRefresh(() => void reload());
  }, [reload]);

  return { data, status, reload };
}
```

- [ ] **Step 4: Progress + finished components**

`src/components/tech/guide-progress.tsx`:

```tsx
'use client';

import { GUIDE_COPY, progressLabel } from '@/lib/tech/guide-copy';

/** Spec §6: 6 px sunken track, primary fill, 300 ms ease-out, aria progressbar. The label is optional (the card's header carries its own count). */
export function GuideProgress({ done, total, showLabel = true }: { readonly done: number; readonly total: number; readonly showLabel?: boolean }) {
  const text = progressLabel(done, total);
  return (
    <div className="space-y-1.5">
      {showLabel && <p className="font-mono text-[13px] tabular-nums text-muted-foreground">{text}</p>}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={text}
        aria-label={GUIDE_COPY.progressAria}
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
          style={{ width: `${total === 0 ? 0 : Math.round((done / total) * 100)}%` }}
        />
      </div>
    </div>
  );
}
```

`src/components/tech/guide-finished.tsx`:

```tsx
import { Check } from 'lucide-react';
import { GUIDE_COPY } from '@/lib/tech/guide-copy';

/** The finished block (spec §6), shared by the card and the page. */
export function GuideFinished() {
  return (
    <div className="space-y-1.5">
      <p className="text-[17px] font-semibold">{GUIDE_COPY.finishedTitle}</p>
      <ul className="space-y-1">
        {GUIDE_COPY.finishedLines.map((line) => (
          <li key={line} className="flex items-center gap-2 text-[15px]">
            <Check className="size-4 shrink-0 text-success-strong" aria-hidden="true" />
            {line}
          </li>
        ))}
      </ul>
      <p className="text-[13px] text-muted-foreground">{GUIDE_COPY.finishedRest}</p>
    </div>
  );
}
```

- [ ] **Step 5: Card** — `src/components/tech/guide-card.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { GuideFinished } from '@/components/tech/guide-finished';
import { GuideProgress } from '@/components/tech/guide-progress';
import { useTechGuide } from '@/hooks/use-tech-guide';
import { GUIDE_COPY, progressLabel } from '@/lib/tech/guide-copy';
import { cardNote, cardState, type TodayFirst } from '@/lib/tech/guide-view';

const SKELETON_DELAY_MS = 300;
/** Tallest common state (header, bar, eyebrow, title, two-line how, button, link) so the skeleton → card swap never moves the list. */
const CARD_MIN_H = 'min-h-[332px]';

export function GuideCard({ todayFirst, todaySettled, onHidden }: {
  readonly todayFirst: TodayFirst;
  readonly todaySettled: boolean;
  readonly onHidden: () => void;
}) {
  const { data, status, reload } = useTechGuide();
  const [slow, setSlow] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SKELETON_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  const state = hidden
    ? 'hidden'
    : cardState(data, { loading: status === 'loading', failed: status === 'failed', slowElapsed: slow, guideHidden: false, todaySettled });

  if (state === 'hidden') {
    return hidden ? <p role="status" className="text-[13px] text-muted-foreground">{GUIDE_COPY.hint}</p> : null;
  }
  if (state === 'nothing') return null;
  if (state === 'skeleton' || !data) {
    return (
      <Card className={CARD_MIN_H}>
        <CardContent className="space-y-3 p-4" aria-hidden="true">
          <div className="flex h-11 items-center justify-between"><Skeleton className="h-4 w-28" /><Skeleton className="h-4 w-10" /></div>
          <Skeleton className="h-1.5 w-full rounded-full" />
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-4 w-24" />
        </CardContent>
      </Card>
    );
  }

  async function hide(): Promise<void> {
    setHidden(true);
    setFailed(false);
    onHidden();
    try {
      const res = await fetch('/api/tech/guide', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: true }),
      });
      if (!res.ok) throw new Error('hide failed');
      void reload();
    } catch {
      setHidden(false);
      setFailed(true);
    }
  }

  const finished = state === 'finished';
  const up = data.steps.find((s) => s.id === data.upNext);
  const note = up ? cardNote(up, data.hasOpenJob, todayFirst) : undefined;
  const showButton = !finished && todayFirst !== 'unknown' && todayFirst !== null;

  return (
    <Card className={CARD_MIN_H}>
      <CardContent className="space-y-3 p-4">
        <div className="flex h-11 items-center justify-between gap-2">
          <p className="text-[15px] font-semibold">{GUIDE_COPY.cardTitle}</p>
          <div className="flex items-center gap-1">
            <span className="font-mono text-[13px] tabular-nums text-muted-foreground">
              {progressLabel(data.progress.requiredDone, data.progress.requiredTotal, '')}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label={finished ? GUIDE_COPY.closeAria : GUIDE_COPY.hideAria}
              onClick={() => void hide()}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
        <GuideProgress done={data.progress.requiredDone} total={data.progress.requiredTotal} showLabel={false} />
        {finished ? (
          <GuideFinished />
        ) : up ? (
          <div className="space-y-1.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{GUIDE_COPY.upNext}</p>
            <p className="text-[17px] font-semibold">{up.title}</p>
            <p className="text-[13px] text-muted-foreground">{up.how}</p>
            {note && <p className="text-[13px] text-muted-foreground">{note}</p>}
            {showButton && (
              <Button className="h-12 w-full rounded-xl text-[16px]" render={<Link href={todayFirst.href} />}>
                {GUIDE_COPY.openJob}
              </Button>
            )}
          </div>
        ) : null}
        <Link href="/tech/guide" className="inline-flex min-h-11 items-center text-[13px] font-medium text-link">
          {GUIDE_COPY.seeAll}
        </Link>
        {failed && <p role="alert" className="text-[13px] text-danger-strong">{GUIDE_COPY.updateFailed}</p>}
      </CardContent>
    </Card>
  );
}
```

If `text-link` is not a token in `src/app/globals.css`, use `text-primary` (check first; the invoice page's back link uses `text-link`).

- [ ] **Step 6: Jobs list integration** — edit `src/components/tech/tech-jobs-list-client.tsx`:

Imports to add:

```ts
import { useRef } from 'react'; // merge into the existing react import
import { GuideCard } from '@/components/tech/guide-card';
import { pickTodayFirst, type TodayFirst } from '@/lib/tech/guide-view';
```

Signature: `export function TechJobsListClient({ guideHidden }: { readonly guideHidden: boolean })`.

New state and ref, next to the existing state:

```ts
  // Guide card inputs (spec §6): the first Today row is captured once, from the
  // first successful Today fetch only; `todaySettled` flips on success, failure
  // or abort so the card never waits for the whole visit. A tab switch never
  // changes either.
  const [todayFirst, setTodayFirst] = useState<TodayFirst>('unknown');
  const [todaySettled, setTodaySettled] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);
```

Replace the fetch effect body with:

```ts
  useEffect(() => {
    let cancelled = false;
    let settled = false;
    const controller = new AbortController();
    const isToday = range === 'today';
    void (async () => {
      try {
        const res = await fetch(`/api/tech/jobs?range=${range}`, { signal: controller.signal });
        const body = await res.json().catch(() => ({ success: false }));
        if (cancelled) return;
        if (res.ok && body.success) {
          setJobs(body.data.jobs);
          setError(null);
          if (isToday) {
            setTodayFirst((prev) => (prev === 'unknown' ? pickTodayFirst(body.data.jobs) : prev));
          }
        } else {
          setError('Failed to load jobs');
        }
      } catch {
        if (cancelled) return;
        setError('Could not connect to server.');
      }
      if (!cancelled) {
        setIsLoading(false);
        if (isToday) {
          settled = true;
          setTodaySettled(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      // An aborted Today fetch still settles the card (todayFirst stays 'unknown').
      if (isToday && !settled) setTodaySettled(true);
    };
  }, [range]);
```

Render, between the clock row and the control:

```tsx
      {!guideHidden && (
        <GuideCard
          todayFirst={todayFirst}
          todaySettled={todaySettled}
          onHidden={() => groupRef.current?.querySelector<HTMLButtonElement>('[role=radio][aria-checked=true]')?.focus()}
        />
      )}
      <div ref={groupRef}>
        <SegmentedControl … (unchanged props) … />
      </div>
```

Under React StrictMode (dev) the first mount's cleanup settles Today before the second fetch; the second mount's success then sets `todayFirst` because it is still `'unknown'`. That is the intended order: the card may render once without the button and gain it when Today loads (one pop-in on dev only; production mounts once).

- [ ] **Step 7: Jobs page server read** — `src/app/tech/jobs/page.tsx`:

```tsx
import { getTechSession } from '@/lib/auth/tech-session';
import { readGuideHidden } from '@/lib/tech/guide-queries';
import { TechJobsListClient } from '@/components/tech/tech-jobs-list-client';

export const dynamic = 'force-dynamic';

/**
 * Technician "my jobs" list. The guide card's hidden flag is read server-side
 * (spec §2) so a hidden guide never flashes a skeleton above the list.
 */
export default async function TechJobsPage() {
  const session = await getTechSession();
  if (!session) return null; // the layout redirects
  const guideHidden = await readGuideHidden(session.organizationId, session.userId);
  return <TechJobsListClient guideHidden={guideHidden} />;
}
```

- [ ] **Step 8: Header link** — `src/components/tech/guide-link.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BookOpen } from 'lucide-react';
import { GUIDE_COPY } from '@/lib/tech/guide-copy';

/** Header link to the getting-started guide; current-page aware (spec §2). */
export function GuideLink() {
  const current = usePathname() === '/tech/guide';
  return (
    <Link
      href="/tech/guide"
      aria-current={current ? 'page' : undefined}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-[current=page]:text-foreground"
    >
      <BookOpen className="size-4" aria-hidden="true" />
      {GUIDE_COPY.guideLink}
    </Link>
  );
}
```

`src/app/tech/layout.tsx` header becomes:

```tsx
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border-strong bg-surface px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold tracking-tight">Field</h1>
          <p className="truncate text-xs text-muted-foreground">{session.name}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <GuideLink />
          <TechSignOutButton />
        </div>
      </header>
```

with `import { GuideLink } from '@/components/tech/guide-link';`.

- [ ] **Step 9: Visual check** — dev server running: `node scripts/agent/screenshot-page.mjs /tech/jobs 390 /private/tmp/claude-501/-Users-sizbei-Documents-GitHub-ai-hvac-agent/fde8e78e-e26b-44a5-921c-c4bf61138d99/scratchpad/t4-jobs.png --tech` (read-only against the dev org; the GET stamps that technician's own row, which is fine) and look at the image: card or hint present (the `Guide` link leads to a 404 until Task 5; do not follow it), header link beside Sign out, nothing overflowing at 390. Run `npx next build` once to prove the async server page compiles.

- [ ] **Step 10: Gates + commit**

```bash
npx tsc --noEmit && npx eslint src/lib/tech/guide-view.ts src/lib/tech/guide-view.test.ts src/hooks/use-tech-guide.ts src/components/tech/guide-progress.tsx src/components/tech/guide-finished.tsx src/components/tech/guide-card.tsx src/components/tech/guide-link.tsx src/components/tech/tech-jobs-list-client.tsx src/app/tech/jobs/page.tsx src/app/tech/layout.tsx && npx vitest run
git add src/lib/tech/guide-view.ts src/lib/tech/guide-view.test.ts src/hooks/use-tech-guide.ts src/components/tech/guide-progress.tsx src/components/tech/guide-finished.tsx src/components/tech/guide-card.tsx src/components/tech/guide-link.tsx src/components/tech/tech-jobs-list-client.tsx src/app/tech/jobs/page.tsx src/app/tech/layout.tsx
git commit -m "feat(tech-guide): jobs-list card with server-side hidden read, progress bar, finished block, header Guide link"
```

---

### Task 5: The guide page

**Files:**
- Create: `src/app/tech/guide/page.tsx`, `src/components/tech/guide-page-client.tsx`, `src/components/tech/guide-step-row.tsx`

**Interfaces:**
- Consumes: `useTechGuide`, `GuideProgress`, `GuideFinished`, `GUIDE_COPY`, `progressLabel`, `glyphFor`, `Glyph`, `DerivedStep`.
- Produces: the page at `/tech/guide`.

- [ ] **Step 1: Page** — `src/app/tech/guide/page.tsx`:

```tsx
import { GuidePageClient } from '@/components/tech/guide-page-client';

/** Getting started — the technician tutorial (spec 2026-11-05). Session-gated by the tech layout. */
export default function TechGuidePage() {
  return <GuidePageClient />;
}
```

- [ ] **Step 2: Row component** — `src/components/tech/guide-step-row.tsx` (client: it tracks a flip for the 180 ms fade):

```tsx
'use client';

import { useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import { GUIDE_COPY } from '@/lib/tech/guide-copy';
import type { DerivedStep } from '@/lib/tech/guide-steps';
import type { Glyph } from '@/lib/tech/guide-view';

const SR: Record<Glyph, string> = { done: GUIDE_COPY.srDone, next: GUIDE_COPY.srUpNext, todo: GUIDE_COPY.srTodo };

/** Glyph: Check for done (fades in 180 ms only when it flipped while mounted), filled dot for up next, ring otherwise. */
function StepGlyph({ glyph, flipped }: { readonly glyph: Glyph; readonly flipped: boolean }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      {glyph === 'done' ? (
        <Check className={`size-4 text-success-strong ${flipped ? 'animate-in fade-in duration-[180ms]' : ''}`} aria-hidden="true" />
      ) : (
        <span aria-hidden="true" className={glyph === 'next' ? 'size-2 rounded-full bg-primary' : 'size-2 rounded-full border border-border-strong'} />
      )}
      <span className="sr-only">{SR[glyph]}</span>
    </span>
  );
}

/** One step row: glyph, title, Lead only chip, how + note (both hidden on the hero's own step). */
export function GuideStepRow({ step, glyph, showHow }: { readonly step: DerivedStep; readonly glyph: Glyph; readonly showHow: boolean }) {
  const wasDone = useRef(step.done);
  const flipped = step.done && !wasDone.current;
  useEffect(() => {
    wasDone.current = step.done;
  }, [step.done]);
  return (
    <li className="flex min-h-11 gap-3 py-2.5">
      <div className="pt-0.5"><StepGlyph glyph={glyph} flipped={flipped} /></div>
      <div className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2 text-[15px] font-medium">
          {step.title}
          {step.leadOnly && (
            <span className="rounded-[3px] border border-border px-1.5 text-[11px] font-medium text-muted-foreground">{GUIDE_COPY.leadOnly}</span>
          )}
        </p>
        {showHow && <p className="text-[13px] text-muted-foreground">{step.how}</p>}
        {showHow && step.note && <p className="text-[13px] text-muted-foreground">{step.note}</p>}
      </div>
    </li>
  );
}
```

`animate-in` / `fade-in` come from `tw-animate-css` (already imported in `src/app/globals.css`).

- [ ] **Step 3: Page client** — `src/components/tech/guide-page-client.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { GuideFinished } from '@/components/tech/guide-finished';
import { GuideProgress } from '@/components/tech/guide-progress';
import { GuideStepRow } from '@/components/tech/guide-step-row';
import { useTechGuide } from '@/hooks/use-tech-guide';
import { GUIDE_COPY, progressLabel } from '@/lib/tech/guide-copy';
import { glyphFor } from '@/lib/tech/guide-view';

const SKELETON_DELAY_MS = 300;

export function GuidePageClient() {
  const { data, status, reload } = useTechGuide();
  const [slow, setSlow] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SKELETON_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  const header = (
    <div className="space-y-3">
      <Link href="/tech/jobs" className="inline-flex min-h-11 items-center gap-1.5 text-[15px] text-link">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {GUIDE_COPY.back}
      </Link>
      <h1 className="text-[20px] font-semibold tracking-tight">{GUIDE_COPY.pageTitle}</h1>
    </div>
  );

  if (!data) {
    if (status === 'failed') {
      return (
        <div className="space-y-4">
          {header}
          <p className="text-[15px] text-danger-strong">{GUIDE_COPY.loadFailed}</p>
          <Button
            variant="outline"
            className="h-11"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void reload().finally(() => setRetrying(false));
            }}
          >
            {retrying ? GUIDE_COPY.loading : GUIDE_COPY.tryAgain}
          </Button>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        {header}
        {slow && (
          <div className="space-y-3" aria-hidden="true">
            <Skeleton className="h-1.5 w-full rounded-full" />
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-11 w-full" />)}
          </div>
        )}
      </div>
    );
  }

  const up = data.steps.find((s) => s.id === data.upNext);
  const run = data.steps.filter((s) => s.group === 'run');
  const further = data.steps.filter((s) => s.group === 'further');
  // The hero shows the up-next how line; the row repeats it only when there is no hero (finished).
  const showHow = (id: string) => data.finished || id !== data.upNext;

  return (
    <div className="space-y-4">
      {header}
      <GuideProgress done={data.progress.requiredDone} total={data.progress.requiredTotal} />
      {data.finished ? (
        <Card><CardContent className="p-4"><GuideFinished /></CardContent></Card>
      ) : up ? (
        <Card>
          <CardContent className="space-y-2 p-4">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{GUIDE_COPY.upNext}</p>
            <p className="text-[17px] font-semibold">{up.title}</p>
            <p className="text-[15px]">{up.why}</p>
            <p className="text-[13px] text-muted-foreground">{up.how}</p>
            {up.note && <p className="text-[13px] text-muted-foreground">{up.note}</p>}
            <Button className="h-12 w-full rounded-xl text-[16px]" render={<Link href="/tech/jobs" />}>{GUIDE_COPY.goToJobs}</Button>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader><CardTitle className="text-[17px]">{GUIDE_COPY.runTitle}</CardTitle></CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {run.map((s) => <GuideStepRow key={s.id} step={s} glyph={glyphFor(s, data.upNext)} showHow={showHow(s.id)} />)}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-[17px]">{GUIDE_COPY.furtherTitle}</CardTitle>
          <span className="font-mono text-[13px] tabular-nums text-muted-foreground">{progressLabel(data.progress.optionalDone, data.progress.optionalTotal, '')}</span>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {further.map((s) => <GuideStepRow key={s.id} step={s} glyph={glyphFor(s, data.upNext)} showHow={showHow(s.id)} />)}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Visual check** — `node scripts/agent/screenshot-page.mjs /tech/guide 390 <scratchpad>/t5-guide.png --tech` (read-only) and look at it: Back link, title, bar with label, hero or finished block, two cards, `Lead only` chips on the three lead-only rows, `Go further · N of 7`, no horizontal overflow.

- [ ] **Step 5: Gates + commit**

```bash
npx tsc --noEmit && npx eslint src/app/tech/guide/page.tsx src/components/tech/guide-page-client.tsx src/components/tech/guide-step-row.tsx && npx vitest run
git add src/app/tech/guide src/components/tech/guide-page-client.tsx src/components/tech/guide-step-row.tsx
git commit -m "feat(tech-guide): the Getting started page"
```

---

### Task 6: Docs

**Files:**
- Modify: `.claude/skills/page-tech/SKILL.md`, `replica/build-log.md`, `replica/architecture.md`

- [ ] **Step 1: page-tech skill** — the heading line (`# Tech portal (…)`) and the frontmatter `description` gain `/tech/guide`; the top **Files** block gains the new files; add a section `**Getting started guide (spec 2026-11-05):**` after the "Setup guide hook" paragraph covering: files (`src/app/tech/guide/page.tsx`, `src/components/tech/guide-{card,page-client,step-row,progress,finished,link}.tsx`, `src/hooks/use-tech-guide.ts`, `src/lib/tech/guide-{state,sql,steps,copy,queries,view,refresh}.ts`, `src/app/api/tech/guide/route.ts`, `tests/integration/tech-guide.test.ts`); the nine step ids with required = `start_job`, `finish_job`; sticky stamps (`users.field_guide_state` = `{ hiddenAt?, firstCompleted }`, one guarded UPDATE on GET, old wins); `cardHiddenFor` (× or 24 h after the finish stamp, server clock) read server-side in the jobs page and echoed as `cardHidden`; the `tech:guide:refresh` event dispatched by the location toggle; the no-demo-rule ruling (PLATFORM_ORG_ID = DEMO_ORG_ID in prod); the `Working` tap label; lenient rules (office finalize counts, a Working-then-held row counts as finished, any technician's photo on your live job counts); the probe recipe (`MINT_ORG_ID=<org> npx tsx scripts/agent/mint-tech-session.mjs`, decode and assert `userId`, `GET /api/tech/guide`, `PATCH` with `Origin: http://localhost:3000`); and add to "Verify changes": `npx vitest run src/lib/tech/guide-*.test.ts src/app/api/tech/guide` and `VITEST_INTEGRATION=1 npx vitest run tests/integration/tech-guide.test.ts`.
- [ ] **Step 2: build-log row** — append in the table's style: `Tech getting started | 2026-11-05 | done | <what shipped: /tech/guide page, jobs-list card, header Guide link, nine self-completing steps, migration 0054> | <rulings: progress counts the two required steps with Go further for the rest; no demo rule because PLATFORM_ORG_ID = DEMO_ORG_ID in prod; the finished card leaves 24 h after the finish stamp; Working label fix; lenient rules stated in the spec; no features.csv row>`.
- [ ] **Step 3: architecture.md** — one line in `### F04 Tech loop (M3a–M3d)`: "Technician getting-started guide (`/tech/guide`, card on `/tech/jobs`): nine self-completing steps per technician in `users.field_guide_state`; spec 2026-11-05."
- [ ] **Step 4: Verify + commit** — `node scripts/agent/verify-skills.mjs` → 0 missing.

```bash
git add .claude/skills/page-tech/SKILL.md replica/build-log.md replica/architecture.md
git commit -m "docs(tech-guide): page-tech skill, build log and architecture note for the getting-started guide"
```

(The memory paragraph in `replica-program-fp-st.md` is the lead's, after the walk.)

---

## Self-review

- Spec coverage: §2 surfaces → Tasks 4 (card, header, server read) and 5 (page); §3 steps/rules → Tasks 1 (SQL), 2 (defs/derivation), the `Working` fix → Task 1; §4 payload/stamps/PATCH → Tasks 1–3; §5 migration + no-demo rule → Task 1; §6 UI → Tasks 4–5; §7 tests → each task + Task 3 integration (code shown); §8 docs → Task 6; §9 walk → the lead, after Task 6.
- Type consistency: `GuidePayload` fields (`steps, progress, upNext, finished, hasOpenJob, hiddenAt, cardHidden`) are identical in Tasks 2, 3 (mock), 4 and 5; `TodayFirst` and `todaySettled` are produced in Task 4's list and consumed by Task 4's card only; `progressLabel(done, total, suffix)` is defined in Task 2 and used in 4–5; `Glyph` is exported from guide-view (Task 4) and used by Task 5.
- Review Focus: each line names its owning task's test.
