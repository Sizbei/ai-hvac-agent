# Replica M0b: Config Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the office configurable job types with default durations, tags on customers/locations/jobs, multiple contacts per customer, and a primary service location, and wire all three into the New request dialog.

**Architecture:** Four new tables (`tag_types`, `entity_tags`, `customer_contacts`, `job_types`) plus `customer_locations.is_primary` and `service_requests.job_type_id`, delivered as one idempotent hand-authored migration mirrored in `schema.ts`. Data access lives in three new query modules (`tag-queries.ts`, `contact-queries.ts`, `job-type-queries.ts`) that follow the `org-config-queries.ts` pattern; routes follow `api/admin/settings/faqs/route.ts`. No dual writes: the `job_type` enum stays canonical and the server derives it from `job_types.kind`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle ORM 0.45 on Neon (neon-http, `db.batch()` only), zod, vitest (pure helpers only, no jsdom/RTL), Tailwind + `src/components/admin/ui/*` primitives.

**Spec:** `replica/architecture.md` (Schema decisions 1–3, "M0 Foundation" API table, "The parts that bite", build-order item 2) and `replica/schema.sql` (header conventions + section "M0b"). Companion: `replica/design/components.md` ("M0 components").

## Global Constraints

- Gates before every commit: `npx tsc --noEmit` → 0 errors; `npx eslint <changed files>` → 0 errors; `npx vitest run` → capture the live baseline FIRST (`npx vitest run 2>&1 | tail -5`) and never let pass count drop (baseline on 2026-11-01: 4475 passed, 1 skipped).
- No jsdom / React Testing Library. Test component logic by extracting pure functions.
- neon-http: never `db.transaction()`; multi-statement writes use `db.batch([...])`.
- Background work: `after()` from `next/server`, never a detached promise.
- Tenancy: every query filters by `organizationId` (use `withTenant(table, orgId, ...conds)` from `@/lib/db/tenant`); every id from a request body or path is re-read under the org before it is written.
- PII: names/phones/emails are stored with `encrypt()` from `@/lib/crypto`, blind-indexed with `computeContactHashes()` from `@/lib/admin/crm-queries`, sanitised first with `sanitizeName` / `sanitizePhone` / `sanitizeEmail` from `@/lib/ai/sanitize-fields`.
- Audit: `logAudit({...})` details contain ids / enums / field names only, never PII.
- Copy canon: "request", "technician", "sign in", "cancelled", Unicode …, sentence case; error copy is human (`"Couldn't save the tag."`), never `err.message`.
- Migration conventions (from `replica/schema.sql` header): every statement idempotent (`IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`), every index / unique / check / FK named with the Drizzle name (`<table>_<col>_<reftable>_<refcol>_fk`, `<table>_<cols>_unique`, `<table>_<cols>_idx`), `--> statement-breakpoint` between statements, `_journal.json` entry with `when` > 1786543019279, snapshot copy, and `npx drizzle-kit generate` must then print "No schema changes".
- FROZEN: nothing in `src/lib/ai` prompt text or `src/lib/ai/output-guardrail.ts` changes.
- Commit messages: conventional (`feat(...)`, `fix(...)`), end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Skills: before editing a page, read its skill in `.claude/skills/page-<slug>/SKILL.md` (`page-settings`, `page-customers`, `page-requests`); after adding routes, run `node scripts/agent/verify-skills.mjs` (0 missing paths).

## Review Focus

1. A tag type belonging to another organisation is sent in `tagTypeIds` → the route must answer 400, never insert and never 500 on the composite FK. (Pinned in Task 6.)
2. A `contactId` / `locationId` that belongs to a different customer than `customerId` on New request → 400 "That contact doesn't belong to this customer." (Pinned in Task 8.)
3. Two concurrent first-location inserts for one customer → exactly one `is_primary`, and `upsertCustomerLocation` never throws on the partial unique index. (Pinned in Task 4.)
4. Deactivating a job type that existing requests reference → requests keep their `job_type_id`; the picker hides it; `job_type` enum on old rows is untouched. (Pinned in Task 5.)
5. Erasing a customer → every `customer_contacts` row for the customer is deleted and every `entity_tags` row for the customer and its locations is deleted; a hard `deleteCustomer` does the same. (Pinned in Task 7.)

---

## File map

| file | responsibility |
| --- | --- |
| `drizzle/0047_m0b_config_foundation.sql` | idempotent DDL + the two backfills (job types seed, primary location) |
| `drizzle/meta/_journal.json`, `drizzle/meta/0047_snapshot.json` | journal entry + snapshot copy |
| `src/lib/db/schema.ts` | `tagEntityEnum`, `tagTypes`, `entityTags`, `customerContacts`, `jobTypes`, `customerLocations.isPrimary`, `serviceRequests.jobTypeId` |
| `src/lib/admin/job-type-queries.ts` (+ `.test.ts` for pure helpers) | list / create / update job types, `seedDefaultJobTypes`, `resolveJobTypeForRequest` |
| `src/lib/admin/tag-queries.ts` (+ `.test.ts`) | tag types CRUD, `replaceEntityTags`, `listEntityTags`, `TAG_COLOR_TOKENS` |
| `src/lib/admin/contact-queries.ts` (+ `.test.ts`) | contacts CRUD with encrypt/hash, `toContactInput` sanitiser |
| `src/lib/admin/location-queries.ts` | primary flag on create/delete, `setPrimaryLocation` |
| `src/app/api/admin/settings/job-types/route.ts`, `…/[id]/route.ts` | GET/POST, PATCH |
| `src/app/api/admin/settings/tags/route.ts`, `…/[id]/route.ts` | GET/POST, PATCH |
| `src/app/api/admin/tags/[entity]/[id]/route.ts` | GET/PUT the tag set on one entity |
| `src/app/api/admin/customers/[id]/contacts/route.ts`, `…/[cid]/route.ts` | GET/POST, PATCH/DELETE |
| `src/app/api/admin/customers/[id]/locations/[lid]/route.ts` | PATCH isPrimary |
| `src/lib/admin/create-request.ts`, `create-request-queries.ts`, `create-request-flow.ts` | `jobTypeId`, `contactId`, `locationId`, `tagTypeIds` |
| `src/components/admin/settings/job-types-panel.tsx`, `tags-panel.tsx` | settings UI |
| `src/components/admin/tag-chip-picker.tsx` | shared picker |
| `src/components/admin/customers/contacts-section.tsx` | customer page contacts |
| `src/components/admin/request-create-dialog.tsx` | job type select, contact/location pickers, tags |
| `src/lib/admin/erasure-queries.ts`, `src/lib/admin/crm-queries.ts` | erase + hard-delete coverage |
| `src/lib/admin/provisioning.ts` | seed job types for new orgs |
| `.claude/skills/page-settings/SKILL.md`, `page-customers/SKILL.md`, `page-requests/SKILL.md` | doc updates |
| `replica/features.csv`, `replica/build-log.md` | parity flips, build log |

---

### Task 1: Migration 0047 + schema.ts mirror

**Files:**
- Create: `drizzle/0047_m0b_config_foundation.sql`
- Modify: `drizzle/meta/_journal.json` (append entry idx 47), create `drizzle/meta/0047_snapshot.json`
- Modify: `src/lib/db/schema.ts` (imports at top; new enum + tables after `customerLocations`; two columns)

**Interfaces:**
- Produces: Drizzle tables `tagTypes`, `entityTags`, `customerContacts`, `jobTypes`; enum `tagEntityEnum` (values `customer | location | job`); columns `customerLocations.isPrimary: boolean`, `serviceRequests.jobTypeId: uuid | null`.

- [ ] **Step 1: Write the migration**

```sql
-- M0b config foundation: tags, contacts, primary location, job types.
-- Every statement is idempotent (the neon-http migrator autocommits per
-- statement and records the file only after all pending files succeed).
DO $$ BEGIN
  CREATE TYPE "public"."tag_entity" AS ENUM('customer', 'location', 'job');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tag_types" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "entity" "tag_entity" NOT NULL,
  "name" text NOT NULL,
  "color" text DEFAULT 'graphite' NOT NULL,
  "visible_on_board" boolean DEFAULT false NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tag_types_org_entity_name_unique" UNIQUE("organization_id","entity","name"),
  CONSTRAINT "tag_types_id_org_entity_unique" UNIQUE("id","organization_id","entity")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tag_types" ADD CONSTRAINT "tag_types_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_tags" (
  "organization_id" uuid NOT NULL,
  "tag_type_id" uuid NOT NULL,
  "entity" "tag_entity" NOT NULL,
  "entity_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "entity_tags_tag_type_id_entity_entity_id_pk" PRIMARY KEY("tag_type_id","entity","entity_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "entity_tags" ADD CONSTRAINT "entity_tags_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "entity_tags" ADD CONSTRAINT "entity_tags_tag_type_fk"
    FOREIGN KEY ("tag_type_id","organization_id","entity")
    REFERENCES "public"."tag_types"("id","organization_id","entity") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_tags_org_entity_idx" ON "entity_tags" USING btree ("organization_id","entity","entity_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_contacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "location_id" uuid,
  "name_encrypted" text NOT NULL,
  "role" text,
  "phone_encrypted" text,
  "phone_hash" text,
  "email_encrypted" text,
  "email_hash" text,
  "is_primary" boolean DEFAULT false NOT NULL,
  "position" smallint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_customers_id_fk"
    FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_location_id_customer_locations_id_fk"
    FOREIGN KEY ("location_id") REFERENCES "public"."customer_locations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_contacts_org_customer_idx" ON "customer_contacts" USING btree ("organization_id","customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_contacts_org_phone_hash_idx" ON "customer_contacts" USING btree ("organization_id","phone_hash");
--> statement-breakpoint
ALTER TABLE "customer_locations" ADD COLUMN IF NOT EXISTS "is_primary" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_locations_one_primary_idx" ON "customer_locations" USING btree ("customer_id") WHERE "customer_locations"."is_primary" = true;
--> statement-breakpoint
UPDATE "customer_locations" l SET "is_primary" = true
  WHERE NOT l."is_primary"
    AND l."id" = (SELECT x."id" FROM "customer_locations" x WHERE x."customer_id" = l."customer_id" ORDER BY x."created_at", x."id" LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM "customer_locations" p WHERE p."customer_id" = l."customer_id" AND p."is_primary");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_types" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "name" text NOT NULL,
  "kind" "job_type" NOT NULL,
  "default_duration_minutes" integer DEFAULT 90 NOT NULL,
  "default_priority" "urgency" DEFAULT 'medium' NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "position" smallint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "job_types_org_name_unique" UNIQUE("organization_id","name"),
  CONSTRAINT "job_types_duration_check" CHECK ("job_types"."default_duration_minutes" BETWEEN 15 AND 1440)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "job_types" ADD CONSTRAINT "job_types_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN IF NOT EXISTS "job_type_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_job_type_id_job_types_id_fk"
    FOREIGN KEY ("job_type_id") REFERENCES "public"."job_types"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "requests_job_type_id_idx" ON "service_requests" USING btree ("job_type_id");
--> statement-breakpoint
-- Seed one job type per enum value for every existing org (durations from
-- src/lib/ai/dispatch/duration.ts JOB_DURATION_DEFAULTS), then point existing
-- requests at them. Idempotent: ON CONFLICT on (org, name); the UPDATE only
-- touches rows with job_type_id IS NULL.
INSERT INTO "job_types" ("organization_id","name","kind","default_duration_minutes","default_priority","position")
SELECT o."id", v.name, v.kind::"job_type", v.minutes, v.priority::"urgency", v.pos
FROM "organizations" o
CROSS JOIN (VALUES
  ('Service call','service_call',90,'medium',0),
  ('No heat','no_heat',105,'high',1),
  ('No cooling','no_cool',105,'high',2),
  ('Maintenance','maintenance',60,'low',3),
  ('Installation','install',480,'medium',4),
  ('Estimate','estimate',30,'low',5),
  ('Warranty','warranty',90,'medium',6),
  ('Diagnostic','diagnostic',75,'medium',7),
  ('Inspection','inspection',45,'low',8)
) AS v(name, kind, minutes, priority, pos)
ON CONFLICT ("organization_id","name") DO NOTHING;
--> statement-breakpoint
UPDATE "service_requests" r SET "job_type_id" = jt."id"
FROM "job_types" jt
WHERE r."job_type_id" IS NULL AND r."job_type" IS NOT NULL
  AND jt."organization_id" = r."organization_id" AND jt."kind" = r."job_type";
```

- [ ] **Step 2: Mirror in `schema.ts`**

Add `check`, `foreignKey`, `primaryKey`, `unique`, `smallint` to the `drizzle-orm/pg-core` import. After `customerLocations` add:

```ts
export const tagEntityEnum = pgEnum("tag_entity", ["customer", "location", "job"]);

// M0b: org-defined tags for customers, locations and jobs. `color` is a
// status-colors.ts token name, never a hex value.
export const tagTypes = pgTable(
  "tag_types",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entity: tagEntityEnum("entity").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull().default("graphite"),
    visibleOnBoard: boolean("visible_on_board").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("tag_types_org_entity_name_unique").on(table.organizationId, table.entity, table.name),
    // Lets entity_tags carry a composite FK so a tag can never cross orgs or kinds.
    unique("tag_types_id_org_entity_unique").on(table.id, table.organizationId, table.entity),
  ],
);

// Polymorphic link table. entity_id is deliberately not an FK (three target
// tables); deleteCustomer / request delete / location delete remove rows.
export const entityTags = pgTable(
  "entity_tags",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tagTypeId: uuid("tag_type_id").notNull(),
    entity: tagEntityEnum("entity").notNull(),
    entityId: uuid("entity_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "entity_tags_tag_type_id_entity_entity_id_pk",
      columns: [table.tagTypeId, table.entity, table.entityId],
    }),
    foreignKey({
      name: "entity_tags_tag_type_fk",
      columns: [table.tagTypeId, table.organizationId, table.entity],
      foreignColumns: [tagTypes.id, tagTypes.organizationId, tagTypes.entity],
    }).onDelete("cascade"),
    index("entity_tags_org_entity_idx").on(table.organizationId, table.entity, table.entityId),
  ],
);

// M0b: extra people on a customer account (tenant, property manager…). Same
// encrypt + blind-index shape as customers. Never part of the identity lookup.
export const customerContacts = pgTable(
  "customer_contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    locationId: uuid("location_id").references(() => customerLocations.id, { onDelete: "set null" }),
    nameEncrypted: text("name_encrypted").notNull(),
    role: text("role"),
    phoneEncrypted: text("phone_encrypted"),
    phoneHash: text("phone_hash"),
    emailEncrypted: text("email_encrypted"),
    emailHash: text("email_hash"),
    isPrimary: boolean("is_primary").notNull().default(false),
    position: smallint("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("customer_contacts_org_customer_idx").on(table.organizationId, table.customerId),
    index("customer_contacts_org_phone_hash_idx").on(table.organizationId, table.phoneHash),
  ],
);

// M0b: org-configurable job types. `kind` is the canonical job_type enum the
// AI intake, duration table and FP/HCP mappers keep reading.
export const jobTypes = pgTable(
  "job_types",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: jobTypeEnum("kind").notNull(),
    defaultDurationMinutes: integer("default_duration_minutes").notNull().default(90),
    defaultPriority: urgencyEnum("default_priority").notNull().default("medium"),
    active: boolean("active").notNull().default(true),
    position: smallint("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("job_types_org_name_unique").on(table.organizationId, table.name),
    check("job_types_duration_check", sql`${table.defaultDurationMinutes} BETWEEN 15 AND 1440`),
  ],
);
```

In `customerLocations` add after `zone`:
```ts
    // M0b: exactly one primary per customer (partial unique index below).
    isPrimary: boolean("is_primary").notNull().default(false),
```
and in its index list:
```ts
    uniqueIndex("customer_locations_one_primary_idx").on(table.customerId).where(sql`${table.isPrimary} = true`),
```

In `serviceRequests` add after `jobType`:
```ts
    // M0b: the org-defined job type row; `jobType` (enum) is derived from its kind.
    jobTypeId: uuid("job_type_id").references(() => jobTypes.id, { onDelete: "set null" }),
```
and in its index list: `index("requests_job_type_id_idx").on(table.jobTypeId),`.

Note: `jobTypes` is declared after `serviceRequests` in the file, so the `references(() => jobTypes.id)` thunk is fine; declare `jobTypes` and `tagTypes` wherever `customerLocations` is declared (they only reference `organizations`, `customers`, `customerLocations`).

- [ ] **Step 3: Journal + snapshot**

Append to `drizzle/meta/_journal.json` entries: `{ "idx": 47, "version": "7", "when": <Date.now() at authoring, must be > 1786543019279>, "tag": "0047_m0b_config_foundation", "breakpoints": true }`. Then run:

Run: `npx drizzle-kit generate --name m0b_snapshot_probe`
Expected: it generates a `0048_*.sql` + `0048_snapshot.json`. Inspect the SQL: it must contain ONLY the constructs you already hand-wrote (no drops, no renames). If it contains anything else, fix `schema.ts` until the generated SQL matches, then: `mv drizzle/meta/0048_snapshot.json drizzle/meta/0047_snapshot.json`, delete the generated `0048_*.sql`, remove the idx-48 journal entry, and fix the `"id"`/`"prevId"` fields in `0047_snapshot.json` so `prevId` equals `0046_snapshot.json`'s `id`.

Run: `npx drizzle-kit generate`
Expected: `No schema changes, nothing to migrate 😴`

- [ ] **Step 4: Apply to the dev branch and verify**

Run: `npm run db:migrate` (`.env.local` is the DEV Neon branch; never prod)
Expected: `Migrations complete!`

Run: `npm run db:migrate` again
Expected: completes with no error (idempotency).

Run (psql via `npx tsx -e` or the neon client):
```ts
// scripts/agent/probe-m0b.mjs is not needed; use a one-off:
import { neon } from "@neondatabase/serverless"; import "dotenv/config";
const sql = neon(process.env.DATABASE_URL);
console.log(await sql`select count(*) from job_types`);
console.log(await sql`select count(*) from service_requests where job_type is not null and job_type_id is null`);
console.log(await sql`select count(*) from (select customer_id from customer_locations group by customer_id having count(*) filter (where is_primary) <> 1) x`);
```
Expected: job_types ≥ 9 × number of orgs; the second and third counts are `0`.

- [ ] **Step 5: Gates + commit**

Run: `npx tsc --noEmit && npx eslint src/lib/db/schema.ts && npx vitest run 2>&1 | tail -3`
Expected: 0 errors; vitest pass count ≥ baseline.

```bash
git add drizzle/0047_m0b_config_foundation.sql drizzle/meta/_journal.json drizzle/meta/0047_snapshot.json src/lib/db/schema.ts
git commit -m "feat(db): M0b config foundation — tags, contacts, primary location, job types

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Job type queries + seeding on provision

**Files:**
- Create: `src/lib/admin/job-type-queries.ts`, `src/lib/admin/job-type-queries.test.ts`
- Modify: `src/lib/admin/provisioning.ts` (inside `createOrgCore`, after the batch succeeds)

**Interfaces:**
- Produces:
  ```ts
  export interface JobTypeRecord { id: string; name: string; kind: JobType; defaultDurationMinutes: number; defaultPriority: Urgency; active: boolean; position: number }
  export const jobTypeInputSchema: z.ZodType<JobTypeInput>  // name 1..80, kind enum, defaultDurationMinutes int 15..1440, defaultPriority enum, active?, position? int 0..999
  export function listJobTypes(organizationId: string, opts?: { activeOnly?: boolean }): Promise<readonly JobTypeRecord[]>
  export function createJobType(organizationId: string, input: JobTypeInput): Promise<JobTypeRecord | { conflict: true }>
  export function updateJobType(organizationId: string, id: string, patch: Partial<JobTypeInput>): Promise<JobTypeRecord | null | { conflict: true }>
  export function seedDefaultJobTypes(organizationId: string): Promise<void>
  export function resolveJobTypeForRequest(organizationId: string, jobTypeId: string): Promise<{ id: string; kind: JobType; defaultDurationMinutes: number } | null>  // active rows only, org-scoped
  export const DEFAULT_JOB_TYPES: readonly { name: string; kind: JobType; minutes: number; priority: Urgency }[]  // same 9 rows as the migration
  ```

- [ ] **Step 1: Write the failing tests (pure parts)**

```ts
// src/lib/admin/job-type-queries.test.ts
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: {} }));
import { jobTypeInputSchema, DEFAULT_JOB_TYPES } from "./job-type-queries";

describe("jobTypeInputSchema", () => {
  it("accepts a valid job type", () => {
    const r = jobTypeInputSchema.safeParse({ name: " Tune-up ", kind: "maintenance", defaultDurationMinutes: 60, defaultPriority: "low" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe("Tune-up");
  });
  it("rejects a duration outside 15..1440 and a blank name", () => {
    expect(jobTypeInputSchema.safeParse({ name: "x", kind: "install", defaultDurationMinutes: 10, defaultPriority: "medium" }).success).toBe(false);
    expect(jobTypeInputSchema.safeParse({ name: "  ", kind: "install", defaultDurationMinutes: 60, defaultPriority: "medium" }).success).toBe(false);
  });
  it("rejects an unknown kind", () => {
    expect(jobTypeInputSchema.safeParse({ name: "Repair", kind: "repair", defaultDurationMinutes: 60, defaultPriority: "medium" }).success).toBe(false);
  });
});

describe("DEFAULT_JOB_TYPES", () => {
  it("covers every job_type enum value exactly once", () => {
    const kinds = DEFAULT_JOB_TYPES.map((d) => d.kind).sort();
    expect(kinds).toEqual(["diagnostic", "estimate", "inspection", "install", "maintenance", "no_cool", "no_heat", "service_call", "warranty"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/admin/job-type-queries.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/admin/job-type-queries.ts
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { jobTypes, jobTypeEnum, urgencyEnum } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export type JobType = (typeof jobTypeEnum.enumValues)[number];
export type Urgency = (typeof urgencyEnum.enumValues)[number];

export interface JobTypeRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: JobType;
  readonly defaultDurationMinutes: number;
  readonly defaultPriority: Urgency;
  readonly active: boolean;
  readonly position: number;
}

export const jobTypeInputSchema = z.object({
  name: z.string().transform((v) => v.trim()).pipe(z.string().min(1, "Name is required.").max(80)),
  kind: z.enum(jobTypeEnum.enumValues),
  defaultDurationMinutes: z.number().int().min(15).max(1440),
  defaultPriority: z.enum(urgencyEnum.enumValues),
  active: z.boolean().optional(),
  position: z.number().int().min(0).max(999).optional(),
});
export type JobTypeInput = z.infer<typeof jobTypeInputSchema>;

/** Same nine rows as drizzle/0047 seeds; durations from JOB_DURATION_DEFAULTS. */
export const DEFAULT_JOB_TYPES = [
  { name: "Service call", kind: "service_call", minutes: 90, priority: "medium" },
  { name: "No heat", kind: "no_heat", minutes: 105, priority: "high" },
  { name: "No cooling", kind: "no_cool", minutes: 105, priority: "high" },
  { name: "Maintenance", kind: "maintenance", minutes: 60, priority: "low" },
  { name: "Installation", kind: "install", minutes: 480, priority: "medium" },
  { name: "Estimate", kind: "estimate", minutes: 30, priority: "low" },
  { name: "Warranty", kind: "warranty", minutes: 90, priority: "medium" },
  { name: "Diagnostic", kind: "diagnostic", minutes: 75, priority: "medium" },
  { name: "Inspection", kind: "inspection", minutes: 45, priority: "low" },
] as const satisfies readonly { name: string; kind: JobType; minutes: number; priority: Urgency }[];

function toRecord(row: typeof jobTypes.$inferSelect): JobTypeRecord {
  return {
    id: row.id, name: row.name, kind: row.kind, defaultDurationMinutes: row.defaultDurationMinutes,
    defaultPriority: row.defaultPriority, active: row.active, position: row.position,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

export async function listJobTypes(organizationId: string, opts: { readonly activeOnly?: boolean } = {}): Promise<readonly JobTypeRecord[]> {
  const rows = await db.select().from(jobTypes)
    .where(withTenant(jobTypes, organizationId, ...(opts.activeOnly ? [eq(jobTypes.active, true)] : [])))
    .orderBy(asc(jobTypes.position), asc(jobTypes.name));
  return rows.map(toRecord);
}

export async function createJobType(organizationId: string, input: JobTypeInput): Promise<JobTypeRecord | { readonly conflict: true }> {
  try {
    const [row] = await db.insert(jobTypes).values({
      organizationId, name: input.name, kind: input.kind, defaultDurationMinutes: input.defaultDurationMinutes,
      defaultPriority: input.defaultPriority, active: input.active ?? true, position: input.position ?? 0,
    }).returning();
    if (!row) throw new Error("Failed to create job type");
    return toRecord(row);
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return { conflict: true };
    throw error;
  }
}

export async function updateJobType(organizationId: string, id: string, patch: Partial<JobTypeInput>): Promise<JobTypeRecord | null | { readonly conflict: true }> {
  const set: Partial<typeof jobTypes.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.defaultDurationMinutes !== undefined) set.defaultDurationMinutes = patch.defaultDurationMinutes;
  if (patch.defaultPriority !== undefined) set.defaultPriority = patch.defaultPriority;
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.position !== undefined) set.position = patch.position;
  try {
    const [row] = await db.update(jobTypes).set(set)
      .where(withTenant(jobTypes, organizationId, eq(jobTypes.id, id))).returning();
    return row ? toRecord(row) : null;
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return { conflict: true };
    throw error;
  }
}

/** One row per enum value; ON CONFLICT (org, name) DO NOTHING so re-runs are no-ops. */
export async function seedDefaultJobTypes(organizationId: string): Promise<void> {
  await db.insert(jobTypes).values(
    DEFAULT_JOB_TYPES.map((d, i) => ({
      organizationId, name: d.name, kind: d.kind, defaultDurationMinutes: d.minutes, defaultPriority: d.priority, position: i,
    })),
  ).onConflictDoNothing({ target: [jobTypes.organizationId, jobTypes.name] });
}

/** Active, org-scoped lookup the create path uses to derive `job_type` and the duration. */
export async function resolveJobTypeForRequest(organizationId: string, jobTypeId: string) {
  const [row] = await db.select({ id: jobTypes.id, kind: jobTypes.kind, defaultDurationMinutes: jobTypes.defaultDurationMinutes })
    .from(jobTypes)
    .where(withTenant(jobTypes, organizationId, and(eq(jobTypes.id, jobTypeId), eq(jobTypes.active, true))!))
    .limit(1);
  return row ?? null;
}
```

In `provisioning.ts` `createOrgCore`, after `await runBatch(...)` succeeds (both the first attempt and the slug-retry path), call `await seedDefaultJobTypes(organizationId)` wrapped in try/catch that logs with `logger.error` and continues (seeding must never fail provisioning).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/admin/job-type-queries.test.ts src/lib/admin/provisioning.test.ts`
Expected: PASS (provisioning tests may mock `db`; if `seedDefaultJobTypes` breaks a mock, mock `./job-type-queries` in that test file with `vi.mock("./job-type-queries", () => ({ seedDefaultJobTypes: vi.fn().mockResolvedValue(undefined) }))`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/admin/job-type-queries.ts src/lib/admin/job-type-queries.test.ts src/lib/admin/provisioning.ts src/lib/admin/provisioning.test.ts
git commit -m "feat(admin): job type queries and seeding on provision

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Job types settings API + panel

**Files:**
- Create: `src/app/api/admin/settings/job-types/route.ts`, `src/app/api/admin/settings/job-types/[id]/route.ts`
- Create: `src/components/admin/settings/job-types-panel.tsx`
- Modify: `src/app/admin/(dashboard)/settings/page.tsx` (new tab "Job types" with a `Wrench`-style icon from lucide, e.g. `ClipboardList`)
- Modify: `src/hooks/use-org-settings.ts` only if the page's data hook is the natural place; otherwise the panel fetches itself with `useEffect` + `fetch('/api/admin/settings/job-types')` like `useCustomerSearch` in the dialog.

**Interfaces:**
- Consumes: `listJobTypes`, `createJobType`, `updateJobType`, `jobTypeInputSchema` from Task 2.
- Produces: `GET /api/admin/settings/job-types` → `{ success: true, data: { jobTypes: JobTypeRecord[] } }`; `POST` → 201 `{ jobType }`, 409 `DUPLICATE_NAME`; `PATCH …/[id]` → `{ jobType }` / 404 / 409.

- [ ] **Step 1: Write the route (copy the `faqs/route.ts` shape exactly)**

```ts
// src/app/api/admin/settings/job-types/route.ts
import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { listJobTypes, createJobType, jobTypeInputSchema } from "@/lib/admin/job-type-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const MAX_JOB_TYPES = 100;

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:job-types-list:${session.userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    const jobTypes = await listJobTypes(session.organizationId);
    return successResponse({ jobTypes });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list job types");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:job-types-create:${session.userId}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    const parsed = jobTypeInputSchema.safeParse(await request.json());
    if (!parsed.success) return errorResponse("Invalid job type: " + parsed.error.issues[0]?.message, "VALIDATION_ERROR", 400);
    const existing = await listJobTypes(session.organizationId);
    if (existing.length >= MAX_JOB_TYPES) return errorResponse(`You can have at most ${MAX_JOB_TYPES} job types.`, "LIMIT_REACHED", 409);
    const result = await createJobType(session.organizationId, parsed.data);
    if ("conflict" in result) return errorResponse("A job type with that name already exists.", "DUPLICATE_NAME", 409);
    await logAudit({ organizationId: session.organizationId, userId: session.userId, action: "create_job_type", entity: "job_types", entityId: result.id })
      .catch((auditError: unknown) => logger.error({ error: auditError }, "Failed to audit job type creation"));
    return successResponse({ jobType: result }, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to create job type");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
```

`[id]/route.ts` PATCH: validate `id` with the UUID regex from `technicians/[id]/route.ts`, parse `jobTypeInputSchema.partial()`, call `updateJobType`, map `null` → 404 `NOT_FOUND`, `conflict` → 409, audit action `update_job_type` with `details: JSON.stringify({ fields: Object.keys(parsed.data) })`.

- [ ] **Step 2: Write the panel** (compose `Card`, `Input`, `Select`, `Switch`, `Button` as `custom-faqs-panel.tsx` does; the spec in `replica/design/components.md` "Job-type row editor")

Rows: name (Input), kind (Select of `jobTypeValues` with `JOB_TYPE_LABELS` from `@/lib/admin/create-request`), default duration (Input type number, `font-mono`, step 15), default priority (Select with `URGENCY_LABELS`), active (Switch). Inline "Add job type" row at the bottom with the same fields. Save per row on blur/change through `PATCH`; show `"Couldn't save the job type."` on failure, `"A job type with that name already exists."` on 409. Sort by `position` then name. No drag ordering in M0b (position is edited as a number input, width 16).

- [ ] **Step 3: Wire the tab in `settings/page.tsx`** next to "Services": `<TabsTrigger value="job-types"><ClipboardList className="size-4" />Job types</TabsTrigger>` and `<TabsContent value="job-types"><JobTypesPanel /></TabsContent>`.

- [ ] **Step 4: Verify in the browser**

Run: `npm run dev` (if not running), then `node scripts/agent/screenshot-page.mjs /admin/settings?tab=job-types 1440` (or click the tab; the page may not read `?tab`, in which case screenshot `/admin/settings` and confirm the tab renders by curl):
```bash
TOKEN=$(node scripts/agent/mint-admin-session.mjs)
curl -s -b "hvac_admin_session=$TOKEN" http://localhost:3000/api/admin/settings/job-types | head -c 400
curl -s -b "hvac_admin_session=$TOKEN" -H 'content-type: application/json' -X POST http://localhost:3000/api/admin/settings/job-types -d '{"name":"Duct cleaning","kind":"maintenance","defaultDurationMinutes":120,"defaultPriority":"low"}'
```
Expected: GET lists ≥ 9 rows; POST returns 201 with the row; a second identical POST returns 409 `DUPLICATE_NAME`. Look at the screenshot yourself: nine rows plus the new one, sentence case, mono minutes.

- [ ] **Step 5: Gates + commit**

Run: `npx tsc --noEmit && npx eslint src/app/api/admin/settings/job-types src/components/admin/settings/job-types-panel.tsx 'src/app/admin/(dashboard)/settings/page.tsx' && npx vitest run 2>&1 | tail -3`

```bash
git add src/app/api/admin/settings/job-types src/components/admin/settings/job-types-panel.tsx 'src/app/admin/(dashboard)/settings/page.tsx'
git commit -m "feat(settings): configurable job types with default duration

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Primary location on create / delete

**Files:**
- Modify: `src/lib/admin/location-queries.ts` (`upsertCustomerLocation` ~lines 40–99; add `setPrimaryLocation`, `reselectPrimaryLocation`; include `isPrimary` in `listCustomerLocations`)
- Create: `src/app/api/admin/customers/[id]/locations/[lid]/route.ts` (PATCH `{ isPrimary: true }`)
- Modify: the location delete path (grep `delete(customerLocations)` in `src/lib/admin`; if none exists, there is no delete path and `reselectPrimaryLocation` is only called from `deleteCustomer`-adjacent code — state that in the commit)
- Test: `src/lib/admin/location-queries.test.ts` only if it already exists; otherwise this task is verified by the DB probe below.

**Interfaces:**
- Produces: `setPrimaryLocation(organizationId, customerId, locationId): Promise<boolean>` (two statements in one `db.batch`: clear then set); `reselectPrimaryLocation(organizationId, customerId): Promise<void>`; `CustomerLocation.isPrimary: boolean`.

- [ ] **Step 1: Make the first location primary without racing the partial index**

In `upsertCustomerLocation`, keep the insert as is (it never sets `isPrimary`). After `created` (or after the winner read-back), run one guarded UPDATE:

```ts
  // First location becomes primary. A separate guarded UPDATE (not part of the
  // insert) so a lost race on customer_locations_one_primary_idx can never
  // throw: the predicate re-checks that no primary exists at write time.
  await db.execute(sql`
    UPDATE ${customerLocations} SET is_primary = true
    WHERE id = ${locationId}
      AND organization_id = ${organizationId}
      AND NOT EXISTS (
        SELECT 1 FROM ${customerLocations} p
        WHERE p.customer_id = ${customerId} AND p.is_primary
      )`);
```
Wrap it in try/catch; on a unique violation (`code === "23505"`) do nothing (another writer won).

- [ ] **Step 2: `setPrimaryLocation` and `reselectPrimaryLocation`**

```ts
export async function setPrimaryLocation(organizationId: string, customerId: string, locationId: string): Promise<boolean> {
  const [target] = await db.select({ id: customerLocations.id }).from(customerLocations)
    .where(withTenant(customerLocations, organizationId, and(eq(customerLocations.id, locationId), eq(customerLocations.customerId, customerId))!))
    .limit(1);
  if (!target) return false;
  await db.batch([
    db.update(customerLocations).set({ isPrimary: false })
      .where(withTenant(customerLocations, organizationId, and(eq(customerLocations.customerId, customerId), eq(customerLocations.isPrimary, true))!)),
    db.update(customerLocations).set({ isPrimary: true })
      .where(withTenant(customerLocations, organizationId, eq(customerLocations.id, locationId))),
  ]);
  return true;
}

/** After a location is removed: promote the oldest remaining one when none is primary. */
export async function reselectPrimaryLocation(organizationId: string, customerId: string): Promise<void> {
  await db.execute(sql`
    UPDATE ${customerLocations} l SET is_primary = true
    WHERE l.organization_id = ${organizationId} AND l.customer_id = ${customerId}
      AND l.id = (SELECT x.id FROM ${customerLocations} x WHERE x.customer_id = l.customer_id ORDER BY x.created_at, x.id LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM ${customerLocations} p WHERE p.customer_id = l.customer_id AND p.is_primary)`);
}
```

- [ ] **Step 3: PATCH route** at `src/app/api/admin/customers/[id]/locations/[lid]/route.ts`: `getAdminSession`, `adminMutation` rate limit, UUID-check both params, body `z.object({ isPrimary: z.literal(true) })`, call `setPrimaryLocation`, 404 when false, audit `set_primary_location` (entity `customer_locations`, entityId `lid`), return `successResponse({ ok: true })`.

- [ ] **Step 4: Probe**

```bash
TOKEN=$(node scripts/agent/mint-admin-session.mjs)
# pick a customer with 2+ locations from the dev DB, then:
curl -s -b "hvac_admin_session=$TOKEN" -H 'content-type: application/json' -X PATCH http://localhost:3000/api/admin/customers/<cid>/locations/<lid>/ -d '{"isPrimary":true}'
```
Expected: `{ "success": true, ... }` and the DB probe from Task 1 Step 4 (count of customers with ≠1 primary) is still `0`.

- [ ] **Step 5: Gates + commit**

```bash
git add src/lib/admin/location-queries.ts 'src/app/api/admin/customers/[id]/locations'
git commit -m "feat(customers): primary service location, set on create and by PATCH

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Tag queries

**Files:**
- Create: `src/lib/admin/tag-queries.ts`, `src/lib/admin/tag-queries.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const TAG_COLOR_TOKENS = ["graphite", "marker", "signal", "success", "warning", "info"] as const;
  export type TagColor = (typeof TAG_COLOR_TOKENS)[number];
  export type TagEntity = "customer" | "location" | "job";
  export interface TagTypeRecord { id: string; entity: TagEntity; name: string; color: TagColor; visibleOnBoard: boolean; active: boolean }
  export const tagTypeInputSchema  // entity enum, name 1..40 trimmed, color enum, visibleOnBoard?, active?
  export function listTagTypes(organizationId, opts?: { entity?: TagEntity; activeOnly?: boolean }): Promise<readonly TagTypeRecord[]>
  export function createTagType(organizationId, input): Promise<TagTypeRecord | { conflict: true }>
  export function updateTagType(organizationId, id, patch): Promise<TagTypeRecord | null | { conflict: true }>
  export function listEntityTags(organizationId, entity, entityIds: readonly string[]): Promise<ReadonlyMap<string, readonly TagTypeRecord[]>>
  export function replaceEntityTags(organizationId, entity, entityId, tagTypeIds: readonly string[]): Promise<{ ok: true } | { ok: false; reason: "unknown_tag" }>
  export function tagBadgeClass(color: TagColor): string   // pure; maps a token to the same class pairs status-colors.ts uses
  ```

- [ ] **Step 1: Failing tests (pure parts)**

```ts
// src/lib/admin/tag-queries.test.ts
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: {} }));
import { tagTypeInputSchema, tagBadgeClass, TAG_COLOR_TOKENS } from "./tag-queries";

describe("tagTypeInputSchema", () => {
  it("trims the name and accepts a token colour", () => {
    const r = tagTypeInputSchema.safeParse({ entity: "job", name: " VIP ", color: "signal" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe("VIP");
  });
  it("rejects a hex colour and an unknown entity", () => {
    expect(tagTypeInputSchema.safeParse({ entity: "job", name: "VIP", color: "#ff0000" }).success).toBe(false);
    expect(tagTypeInputSchema.safeParse({ entity: "invoice", name: "VIP", color: "marker" }).success).toBe(false);
  });
});

describe("tagBadgeClass", () => {
  it("returns a class string for every token", () => {
    for (const c of TAG_COLOR_TOKENS) expect(tagBadgeClass(c)).toMatch(/bg-/);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/admin/tag-queries.test.ts` → module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/admin/tag-queries.ts
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { tagTypes, entityTags, tagEntityEnum } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export const TAG_COLOR_TOKENS = ["graphite", "marker", "signal", "success", "warning", "info"] as const;
export type TagColor = (typeof TAG_COLOR_TOKENS)[number];
export type TagEntity = (typeof tagEntityEnum.enumValues)[number];

export interface TagTypeRecord {
  readonly id: string; readonly entity: TagEntity; readonly name: string;
  readonly color: TagColor; readonly visibleOnBoard: boolean; readonly active: boolean;
}

export const tagTypeInputSchema = z.object({
  entity: z.enum(tagEntityEnum.enumValues),
  name: z.string().transform((v) => v.trim()).pipe(z.string().min(1, "Name is required.").max(40)),
  color: z.enum(TAG_COLOR_TOKENS),
  visibleOnBoard: z.boolean().optional(),
  active: z.boolean().optional(),
});
export type TagTypeInput = z.infer<typeof tagTypeInputSchema>;

/** Token → the same text/background pairs status-colors.ts proves ≥4.5:1. */
const BADGE: Record<TagColor, string> = {
  graphite: "bg-muted text-muted-foreground border-border",
  marker: "bg-marker-light text-marker-strong border-marker-border",
  signal: "bg-danger-light text-danger-strong border-danger-border",
  success: "bg-success-light text-success-strong border-success-border",
  warning: "bg-warning-light text-warning-strong border-warning-border",
  info: "bg-info-light text-info-strong border-info-border",
};
export function tagBadgeClass(color: TagColor): string { return BADGE[color] ?? BADGE.graphite; }

function isColor(v: string): v is TagColor { return (TAG_COLOR_TOKENS as readonly string[]).includes(v); }
function toRecord(row: typeof tagTypes.$inferSelect): TagTypeRecord {
  return { id: row.id, entity: row.entity, name: row.name, color: isColor(row.color) ? row.color : "graphite", visibleOnBoard: row.visibleOnBoard, active: row.active };
}
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

export async function listTagTypes(organizationId: string, opts: { readonly entity?: TagEntity; readonly activeOnly?: boolean } = {}): Promise<readonly TagTypeRecord[]> {
  const conds = [
    ...(opts.entity ? [eq(tagTypes.entity, opts.entity)] : []),
    ...(opts.activeOnly ? [eq(tagTypes.active, true)] : []),
  ];
  const rows = await db.select().from(tagTypes).where(withTenant(tagTypes, organizationId, ...conds)).orderBy(asc(tagTypes.entity), asc(tagTypes.name));
  return rows.map(toRecord);
}

export async function createTagType(organizationId: string, input: TagTypeInput): Promise<TagTypeRecord | { readonly conflict: true }> {
  try {
    const [row] = await db.insert(tagTypes).values({
      organizationId, entity: input.entity, name: input.name, color: input.color,
      visibleOnBoard: input.visibleOnBoard ?? false, active: input.active ?? true,
    }).returning();
    if (!row) throw new Error("Failed to create tag");
    return toRecord(row);
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return { conflict: true };
    throw error;
  }
}

export async function updateTagType(organizationId: string, id: string, patch: Partial<Omit<TagTypeInput, "entity">>): Promise<TagTypeRecord | null | { readonly conflict: true }> {
  const set: Partial<typeof tagTypes.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.color !== undefined) set.color = patch.color;
  if (patch.visibleOnBoard !== undefined) set.visibleOnBoard = patch.visibleOnBoard;
  if (patch.active !== undefined) set.active = patch.active;
  try {
    const [row] = await db.update(tagTypes).set(set).where(withTenant(tagTypes, organizationId, eq(tagTypes.id, id))).returning();
    return row ? toRecord(row) : null;
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return { conflict: true };
    throw error;
  }
}

/** Tags for many entities at once (one query); map key = entityId. */
export async function listEntityTags(organizationId: string, entity: TagEntity, entityIds: readonly string[]): Promise<ReadonlyMap<string, readonly TagTypeRecord[]>> {
  const out = new Map<string, TagTypeRecord[]>();
  if (entityIds.length === 0) return out;
  const rows = await db.select({ entityId: entityTags.entityId, tag: tagTypes })
    .from(entityTags).innerJoin(tagTypes, eq(tagTypes.id, entityTags.tagTypeId))
    .where(withTenant(entityTags, organizationId, eq(entityTags.entity, entity), inArray(entityTags.entityId, [...entityIds])))
    .orderBy(asc(tagTypes.name));
  for (const r of rows) {
    const list = out.get(r.entityId) ?? [];
    list.push(toRecord(r.tag));
    out.set(r.entityId, list);
  }
  return out;
}

/**
 * Replace the tag set on one entity. The CALLER has already verified the
 * entity belongs to the org. Tag ids are re-read here under the org with the
 * matching entity kind and active=true, so a wrong-org or wrong-kind id is a
 * 400 (`unknown_tag`), never a FK error. Delete + insert in one batch.
 */
export async function replaceEntityTags(organizationId: string, entity: TagEntity, entityId: string, tagTypeIds: readonly string[]): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: "unknown_tag" }> {
  const unique = [...new Set(tagTypeIds)];
  if (unique.length > 0) {
    const found = await db.select({ id: tagTypes.id }).from(tagTypes)
      .where(withTenant(tagTypes, organizationId, eq(tagTypes.entity, entity), eq(tagTypes.active, true), inArray(tagTypes.id, unique)));
    if (found.length !== unique.length) return { ok: false, reason: "unknown_tag" };
  }
  const del = db.delete(entityTags).where(withTenant(entityTags, organizationId, eq(entityTags.entity, entity), eq(entityTags.entityId, entityId)));
  if (unique.length === 0) { await del; return { ok: true }; }
  await db.batch([
    del,
    db.insert(entityTags).values(unique.map((tagTypeId) => ({ organizationId, tagTypeId, entity, entityId }))),
  ]);
  return { ok: true };
}
```

- [ ] **Step 4: Run tests** — `npx vitest run src/lib/admin/tag-queries.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/admin/tag-queries.ts src/lib/admin/tag-queries.test.ts
git commit -m "feat(admin): tag type and entity tag queries

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Tag routes, settings panel, chip picker

**Files:**
- Create: `src/app/api/admin/settings/tags/route.ts` (GET `?entity=`, POST), `src/app/api/admin/settings/tags/[id]/route.ts` (PATCH)
- Create: `src/app/api/admin/tags/[entity]/[id]/route.ts` (GET, PUT)
- Create: `src/components/admin/settings/tags-panel.tsx`, `src/components/admin/tag-chip-picker.tsx`
- Modify: `src/app/admin/(dashboard)/settings/page.tsx` (tab "Tags", icon `Tag`)
- Test: `src/app/api/admin/tags/[entity]/[id]/route.test.ts` is NOT needed (no DB in unit tests); the ownership check is a pure function tested in `tag-queries.test.ts`? No — put `resolveTaggable` in `src/lib/admin/tag-entity-lookup.ts` and probe by curl.

**Interfaces:**
- Produces: `PUT /api/admin/tags/{customer|location|job}/{id}` body `{ tagTypeIds: string[] }` → 200 `{ tags: TagTypeRecord[] }`, 404 when the entity isn't in the org, 400 `UNKNOWN_TAG` when a tag id is wrong-org / wrong-kind / inactive. `GET` → `{ tags }`.
- `TagChipPicker` props: `{ entity: TagEntity; entityId: string; initialTags: readonly TagTypeRecord[]; onChange?: (tags) => void }`; it fetches `/api/admin/settings/tags?entity=…` for the popover list, PUTs on every change, supports "New tag" inline (POST to settings/tags then PUT).

- [ ] **Step 1: Entity lookup helper**

```ts
// src/lib/admin/tag-entity-lookup.ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers, customerLocations, serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import type { TagEntity } from "./tag-queries";

/** True when `[entity]/[id]` exists in this org. Path ids are never trusted. */
export async function taggableExists(organizationId: string, entity: TagEntity, id: string): Promise<boolean> {
  const table = entity === "customer" ? customers : entity === "location" ? customerLocations : serviceRequests;
  const [row] = await db.select({ id: table.id }).from(table).where(withTenant(table, organizationId, eq(table.id, id))).limit(1);
  return Boolean(row);
}
```

- [ ] **Step 2: `tags/[entity]/[id]/route.ts`**

```ts
import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { listEntityTags, replaceEntityTags, type TagEntity } from "@/lib/admin/tag-queries";
import { taggableExists } from "@/lib/admin/tag-entity-lookup";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITIES = ["customer", "location", "job"] as const;
const bodySchema = z.object({ tagTypeIds: z.array(z.string().regex(UUID_REGEX)).max(20) });

function parseParams(p: { entity: string; id: string }): { entity: TagEntity; id: string } | null {
  if (!(ENTITIES as readonly string[]).includes(p.entity) || !UUID_REGEX.test(p.id)) return null;
  return { entity: p.entity as TagEntity, id: p.id };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ entity: string; id: string }> }) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const p = parseParams(await params);
    if (!p) return errorResponse("Not found", "NOT_FOUND", 404);
    if (!(await taggableExists(session.organizationId, p.entity, p.id))) return errorResponse("Not found", "NOT_FOUND", 404);
    const map = await listEntityTags(session.organizationId, p.entity, [p.id]);
    return successResponse({ tags: map.get(p.id) ?? [] });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list entity tags");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ entity: string; id: string }> }) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:tags-put:${session.userId}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    const p = parseParams(await params);
    if (!p) return errorResponse("Not found", "NOT_FOUND", 404);
    const body = await readJsonBody(request);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) return errorResponse("Invalid tags", "VALIDATION_ERROR", 400);
    if (!(await taggableExists(session.organizationId, p.entity, p.id))) return errorResponse("Not found", "NOT_FOUND", 404);
    const result = await replaceEntityTags(session.organizationId, p.entity, p.id, parsed.data.tagTypeIds);
    if (!result.ok) return errorResponse("One of those tags doesn't exist.", "UNKNOWN_TAG", 400);
    await logAudit({ organizationId: session.organizationId, userId: session.userId, action: "replace_entity_tags", entity: `${p.entity}_tags`, entityId: p.id, details: JSON.stringify({ tagTypeIds: parsed.data.tagTypeIds }) })
      .catch((auditError: unknown) => logger.error({ error: auditError }, "Failed to audit tag change"));
    const map = await listEntityTags(session.organizationId, p.entity, [p.id]);
    return successResponse({ tags: map.get(p.id) ?? [] });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to replace entity tags");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
```
(Check `readJsonBody`'s signature in `src/lib/api-response.ts:28` and match it; if it returns a discriminated result, adapt.)

`settings/tags/route.ts` and `[id]/route.ts`: same shape as Task 3's job-types routes with `tagTypeInputSchema`, audit actions `create_tag_type` / `update_tag_type`, 409 `DUPLICATE_NAME` copy "A tag with that name already exists for this type."

- [ ] **Step 3: Settings panel** (`tags-panel.tsx`): three groups (Customers, Locations, Jobs) each a `Card` with rows: name (Input), colour (Select over `TAG_COLOR_TOKENS`, rendering a swatch `span` with `tagBadgeClass`), "Show on board" (Switch, jobs group only), active (Switch); inline add row per group. Tab wired in `settings/page.tsx` as "Tags".

- [ ] **Step 4: Chip picker** (`tag-chip-picker.tsx`, spec "Tag chip picker" in `replica/design/components.md`): renders `initialTags` as `Badge`-style chips with `tagBadgeClass(color)` + an × button; "Add tag" opens a `Popover` listing active tag types for `entity` with a search `Input`, a checkbox per type, and a "New tag" row (name + colour) that POSTs to `/api/admin/settings/tags` then PUTs. Every change PUTs the full id set; on failure shows `"Couldn't save tags."` inline and reverts. Chips with `visibleOnBoard` get `title="Shown on board"`. Keyboard: Backspace on a focused chip removes it.

- [ ] **Step 5: Probe (Review Focus 1)**

```bash
TOKEN=$(node scripts/agent/mint-admin-session.mjs)
# create a job tag, then attach it to a request in this org:
curl -s -b "hvac_admin_session=$TOKEN" -H 'content-type: application/json' -X POST http://localhost:3000/api/admin/settings/tags -d '{"entity":"job","name":"Callback","color":"signal","visibleOnBoard":true}'
curl -s -b "hvac_admin_session=$TOKEN" -H 'content-type: application/json' -X PUT http://localhost:3000/api/admin/tags/job/<requestId> -d '{"tagTypeIds":["<tagId>"]}'
# wrong kind: a CUSTOMER tag on a job → 400 UNKNOWN_TAG, not 500
curl -s -b "hvac_admin_session=$TOKEN" -H 'content-type: application/json' -X PUT http://localhost:3000/api/admin/tags/job/<requestId> -d '{"tagTypeIds":["<customerTagId>"]}'
# other org's tag id (seed-org.mjs creates a second org on dev) → 400 UNKNOWN_TAG
```
Expected: 201, 200 with `tags: [Callback]`, 400, 400. Screenshot `/admin/settings` Tags tab at 1440 and look at it.

- [ ] **Step 6: Gates + commit**

```bash
git add src/app/api/admin/settings/tags src/app/api/admin/tags src/lib/admin/tag-entity-lookup.ts src/components/admin/settings/tags-panel.tsx src/components/admin/tag-chip-picker.tsx 'src/app/admin/(dashboard)/settings/page.tsx'
git commit -m "feat(admin): tag types settings, entity tag routes, chip picker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Contacts queries, routes, customer-page section, erase + delete coverage

**Files:**
- Create: `src/lib/admin/contact-queries.ts`, `src/lib/admin/contact-queries.test.ts`
- Create: `src/app/api/admin/customers/[id]/contacts/route.ts` (GET, POST), `…/contacts/[cid]/route.ts` (PATCH, DELETE)
- Create: `src/components/admin/customers/contacts-section.tsx`
- Modify: `src/app/admin/(dashboard)/customers/[id]/page.tsx` (render `ContactsSection` and `TagChipPicker entity="customer"` under the header; `TagChipPicker entity="location"` on each location row if the page lists locations — check `CustomerBookingsSection`/the locations block first)
- Modify: `src/lib/admin/erasure-queries.ts` (two new batch statements), `src/lib/admin/crm-queries.ts` `deleteCustomer` (delete `entityTags` for the customer and its locations; contacts cascade by FK)
- Modify: the request hard-delete in `src/lib/admin/conversation-queries.ts` (~line 457, `delete(serviceRequests)`): delete `entityTags` where `entity='job'` and `entityId` in the deleted ids, in the same batch.

**Interfaces:**
- Produces:
  ```ts
  export interface ContactRecord { id: string; customerId: string; locationId: string | null; name: string; role: string | null; phone: string | null; email: string | null; isPrimary: boolean; position: number }
  export const contactInputSchema  // name 1..200 (sanitizeName), role? ≤60, phone? (isPhoneComplete, sanitizePhone), email? (sanitizeEmail + z.email), locationId? uuid, isPrimary?
  export function listContacts(organizationId, customerId): Promise<readonly ContactRecord[]>
  export function createContact(organizationId, customerId, input): Promise<ContactRecord | { reason: "location_not_owned" }>
  export function updateContact(organizationId, customerId, contactId, patch): Promise<ContactRecord | null | { reason: "location_not_owned" }>
  export function deleteContact(organizationId, customerId, contactId): Promise<boolean>
  export function contactBelongsToCustomer(organizationId, customerId, contactId): Promise<boolean>
  export function toContactRow(input: ContactInput): { nameEncrypted; phoneEncrypted; phoneHash; emailEncrypted; emailHash }  // pure given encrypt/hash
  ```

- [ ] **Step 1: Failing tests (pure)**

```ts
// src/lib/admin/contact-queries.test.ts
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: {} }));
import { contactInputSchema } from "./contact-queries";

describe("contactInputSchema", () => {
  it("sanitises name, phone and email", () => {
    const r = contactInputSchema.safeParse({ name: "  jane   DOE ", phone: "(423) 555-0100", email: " Jane@Example.com " });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name.length).toBeGreaterThan(0);
      expect(r.data.phone).toMatch(/^\+?1?\d{10}$|^\d{10}$|\d/);
      expect(r.data.email).toBe("jane@example.com");
    }
  });
  it("rejects a 7-digit phone and a bad email", () => {
    expect(contactInputSchema.safeParse({ name: "Jane", phone: "555-0100" }).success).toBe(false);
    expect(contactInputSchema.safeParse({ name: "Jane", email: "nope" }).success).toBe(false);
  });
  it("requires a name", () => {
    expect(contactInputSchema.safeParse({ phone: "4235550100" }).success).toBe(false);
  });
});
```
(Adjust the phone expectation to whatever `sanitizePhone` actually returns — read `src/lib/ai/sanitize-fields.ts:98` first and assert on its real output format.)

- [ ] **Step 2: Implement**

```ts
// src/lib/admin/contact-queries.ts
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { customerContacts, customerLocations } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { encrypt, decrypt } from "@/lib/crypto";
import { computeContactHashes } from "@/lib/admin/crm-queries";
import { sanitizeName, sanitizePhone, sanitizeEmail } from "@/lib/ai/sanitize-fields";
import { isPhoneComplete } from "@/lib/ai/extraction-schema";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const optionalText = (max: number) => z.string().max(max).optional().nullable().transform((v) => { const t = v?.trim(); return t ? t : null; });

export const contactInputSchema = z.object({
  name: z.string().transform((v) => sanitizeName(v)).pipe(z.string().min(1, "Name is required.").max(200)),
  role: optionalText(60),
  phone: optionalText(40).transform((v) => (v ? sanitizePhone(v) : null)).refine((v) => v === null || isPhoneComplete(v), "Phone must be a 10-digit US number."),
  email: optionalText(254).transform((v) => (v ? sanitizeEmail(v) : null)).refine((v) => v === null || z.email().safeParse(v).success, "Email address isn't valid."),
  locationId: z.string().regex(UUID_REGEX).optional().nullable(),
  isPrimary: z.boolean().optional(),
});
export type ContactInput = z.infer<typeof contactInputSchema>;

export interface ContactRecord {
  readonly id: string; readonly customerId: string; readonly locationId: string | null;
  readonly name: string; readonly role: string | null; readonly phone: string | null; readonly email: string | null;
  readonly isPrimary: boolean; readonly position: number;
}

function safeDecrypt(v: string | null): string | null { if (!v) return null; try { return decrypt(v); } catch { return null; } }
function toRecord(r: typeof customerContacts.$inferSelect): ContactRecord {
  return { id: r.id, customerId: r.customerId, locationId: r.locationId, name: safeDecrypt(r.nameEncrypted) ?? "", role: r.role,
    phone: safeDecrypt(r.phoneEncrypted), email: safeDecrypt(r.emailEncrypted), isPrimary: r.isPrimary, position: r.position };
}

/** Encrypt + blind-index exactly like customers (same normaliser via computeContactHashes). */
export function toContactRow(input: Pick<ContactInput, "name" | "phone" | "email">) {
  const hashes = computeContactHashes({ email: input.email ?? null, phone: input.phone ?? null });
  return {
    nameEncrypted: encrypt(input.name),
    phoneEncrypted: input.phone ? encrypt(input.phone) : null,
    phoneHash: hashes.phoneHash,
    emailEncrypted: input.email ? encrypt(input.email) : null,
    emailHash: hashes.emailHash,
  };
}

async function locationOwned(organizationId: string, customerId: string, locationId: string): Promise<boolean> {
  const [row] = await db.select({ id: customerLocations.id }).from(customerLocations)
    .where(withTenant(customerLocations, organizationId, and(eq(customerLocations.id, locationId), eq(customerLocations.customerId, customerId))!)).limit(1);
  return Boolean(row);
}

export async function listContacts(organizationId: string, customerId: string): Promise<readonly ContactRecord[]> {
  const rows = await db.select().from(customerContacts)
    .where(withTenant(customerContacts, organizationId, eq(customerContacts.customerId, customerId)))
    .orderBy(asc(customerContacts.position), asc(customerContacts.createdAt));
  return rows.map(toRecord);
}

export async function createContact(organizationId: string, customerId: string, input: ContactInput): Promise<ContactRecord | { readonly reason: "location_not_owned" }> {
  if (input.locationId && !(await locationOwned(organizationId, customerId, input.locationId))) return { reason: "location_not_owned" };
  const [row] = await db.insert(customerContacts).values({
    organizationId, customerId, locationId: input.locationId ?? null, role: input.role ?? null, isPrimary: input.isPrimary ?? false, ...toContactRow(input),
  }).returning();
  if (!row) throw new Error("Failed to create contact");
  return toRecord(row);
}

export async function updateContact(organizationId: string, customerId: string, contactId: string, patch: Partial<ContactInput>): Promise<ContactRecord | null | { readonly reason: "location_not_owned" }> {
  if (patch.locationId && !(await locationOwned(organizationId, customerId, patch.locationId))) return { reason: "location_not_owned" };
  const [existing] = await db.select().from(customerContacts)
    .where(withTenant(customerContacts, organizationId, and(eq(customerContacts.id, contactId), eq(customerContacts.customerId, customerId))!)).limit(1);
  if (!existing) return null;
  const merged = {
    name: patch.name ?? safeDecrypt(existing.nameEncrypted) ?? "",
    phone: patch.phone === undefined ? safeDecrypt(existing.phoneEncrypted) : patch.phone,
    email: patch.email === undefined ? safeDecrypt(existing.emailEncrypted) : patch.email,
  };
  const [row] = await db.update(customerContacts).set({
    ...toContactRow(merged),
    role: patch.role === undefined ? existing.role : patch.role,
    locationId: patch.locationId === undefined ? existing.locationId : patch.locationId,
    isPrimary: patch.isPrimary ?? existing.isPrimary,
    updatedAt: new Date(),
  }).where(withTenant(customerContacts, organizationId, eq(customerContacts.id, contactId))).returning();
  return row ? toRecord(row) : null;
}

export async function deleteContact(organizationId: string, customerId: string, contactId: string): Promise<boolean> {
  const rows = await db.delete(customerContacts)
    .where(withTenant(customerContacts, organizationId, and(eq(customerContacts.id, contactId), eq(customerContacts.customerId, customerId))!))
    .returning({ id: customerContacts.id });
  return rows.length > 0;
}

export async function contactBelongsToCustomer(organizationId: string, customerId: string, contactId: string): Promise<boolean> {
  const [row] = await db.select({ id: customerContacts.id }).from(customerContacts)
    .where(withTenant(customerContacts, organizationId, and(eq(customerContacts.id, contactId), eq(customerContacts.customerId, customerId))!)).limit(1);
  return Boolean(row);
}
```

- [ ] **Step 3: Routes** — `contacts/route.ts` GET/POST and `[cid]/route.ts` PATCH/DELETE in the Task 3 shape: UUID-check params, confirm the customer exists in the org first (`db.select({id: customers.id}) … withTenant`), 404 otherwise; `location_not_owned` → 400 `"That location doesn't belong to this customer."`; audit actions `create_contact` / `update_contact` / `delete_contact` with entity `customer_contacts`, `details: JSON.stringify({ customerId })` (no PII). Cap 20 contacts per customer (409 `LIMIT_REACHED`).

- [ ] **Step 4: Erase + delete coverage (Review Focus 5)**

In `erasure-queries.ts`, inside the existing `db.batch([...])`, add:
```ts
    // M0b contacts carry their own PII: delete them outright (nothing to keep).
    db.delete(customerContacts).where(withTenant(customerContacts, organizationId, eq(customerContacts.customerId, customerId))),
```
In `crm-queries.ts` `deleteCustomer`'s batch add, before the customer delete:
```ts
    db.delete(entityTags).where(withTenant(entityTags, organizationId, eq(entityTags.entity, "customer"), eq(entityTags.entityId, customerId))),
    db.delete(entityTags).where(withTenant(entityTags, organizationId, eq(entityTags.entity, "location"),
      inArray(entityTags.entityId, db.select({ id: customerLocations.id }).from(customerLocations).where(eq(customerLocations.customerId, customerId))))),
```
In `conversation-queries.ts` request delete: add `db.delete(entityTags).where(withTenant(entityTags, organizationId, eq(entityTags.entity, "job"), inArray(entityTags.entityId, requestIds)))` to its batch (read how it collects ids first).

Test: extend `src/lib/admin/erasure-queries.test.ts` if it exists with an assertion that the batch includes a delete on `customer_contacts` (the existing tests mock `db.batch` and inspect statements; follow their pattern). If no such test exists, verify by probe: erase a seeded customer with a contact on dev (`POST /api/admin/customers/<id>/erase`) and `select count(*) from customer_contacts where customer_id = …` → 0.

- [ ] **Step 5: Contacts section UI** (`contacts-section.tsx`, spec "Contacts editor"): `SectionCard` titled "Contacts"; rows with name, role muted, phone/email in `font-mono text-[13px]`, "Primary" chip; row menu (edit, make primary, remove) via `DropdownMenu`; add/edit `Dialog` with name, role, phone, email, location `Select` (from the page's locations), "Primary" switch. Mount it in `customers/[id]/page.tsx` after the header card, and mount `TagChipPicker entity="customer"` in the header area. Also add a "Tags" chip row to the request detail sheet (`src/components/admin/request-detail-sheet.tsx`) using `TagChipPicker entity="job"` — read `.claude/skills/page-requests/SKILL.md` first.

- [ ] **Step 6: Probe + screenshot**

```bash
TOKEN=$(node scripts/agent/mint-admin-session.mjs)
curl -s -b "hvac_admin_session=$TOKEN" -H 'content-type: application/json' -X POST http://localhost:3000/api/admin/customers/<cid>/contacts -d '{"name":"Pat Tenant","role":"tenant","phone":"4235550199"}'
curl -s -b "hvac_admin_session=$TOKEN" http://localhost:3000/api/admin/customers/<cid>/contacts
node scripts/agent/screenshot-page.mjs /admin/customers/<cid> 1440
node scripts/agent/screenshot-page.mjs /admin/customers/<cid> 390
```
Expected: 201 then a list with the decrypted contact; screenshots show the Contacts card and the tag chips; nothing overflows at 390.

- [ ] **Step 7: Gates + commit**

```bash
git add src/lib/admin/contact-queries.ts src/lib/admin/contact-queries.test.ts 'src/app/api/admin/customers/[id]/contacts' src/components/admin/customers/contacts-section.tsx 'src/app/admin/(dashboard)/customers/[id]/page.tsx' src/components/admin/request-detail-sheet.tsx src/lib/admin/erasure-queries.ts src/lib/admin/crm-queries.ts src/lib/admin/conversation-queries.ts
git commit -m "feat(customers): contacts with encrypted PII, customer and job tags, erase coverage

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: New request dialog — job type, contact, location, tags

**Files:**
- Modify: `src/lib/admin/create-request.ts` (body schema + `CreateRequestDraft`/payload builder), `src/lib/admin/create-request.test.ts`
- Modify: `src/lib/admin/create-request-queries.ts` (`createAdminRequest`: resolve job type, verify contact/location ownership, set `jobTypeId`, `jobType`, `locationId`, `estimatedDurationMinutes`, `estimatedDurationSource: "job_type"`, tags after save)
- Modify: `src/lib/admin/create-request-flow.ts` + `.test.ts` only if `runCreateRequest` needs a new dep (it should not: ownership checks live in `createAdminRequest` before `insertRequest`; tags are a best-effort post-save step like the status event)
- Modify: `src/components/admin/request-create-dialog.tsx`
- Modify: `src/app/api/admin/requests/route.ts` (map the two new 400 reasons)

**Interfaces:**
- Consumes: `resolveJobTypeForRequest`, `contactBelongsToCustomer`, `replaceEntityTags`, `listJobTypes`, `listContacts`, `listCustomerLocations`.
- Produces: POST body gains `jobTypeId?: uuid`, `contactId?: uuid`, `locationId?: uuid`, `tagTypeIds?: uuid[] (≤10)`; new 400 codes `JOB_TYPE_NOT_FOUND`, `CONTACT_NOT_OWNED`, `LOCATION_NOT_OWNED`; `estimatedDurationSource` value `"job_type"`.

- [ ] **Step 1: Failing tests**

```ts
// append to src/lib/admin/create-request.test.ts
describe("createRequestBodySchema — M0b fields", () => {
  const base = { customerId: "11111111-1111-1111-1111-111111111111", address: "1 Main St", description: "no heat", issueType: "heating_not_working", urgency: "high" };
  it("accepts jobTypeId, contactId, locationId and up to 10 tags", () => {
    const r = createRequestBodySchema.safeParse({ ...base, jobTypeId: "22222222-2222-2222-2222-222222222222", contactId: "33333333-3333-3333-3333-333333333333", locationId: "44444444-4444-4444-4444-444444444444", tagTypeIds: ["55555555-5555-5555-5555-555555555555"] });
    expect(r.success).toBe(true);
  });
  it("rejects contactId/locationId with an inline customer", () => {
    const r = createRequestBodySchema.safeParse({ ...base, customerId: undefined, customer: { name: "New Person" }, contactId: "33333333-3333-3333-3333-333333333333" });
    expect(r.success).toBe(false);
  });
  it("rejects more than 10 tags", () => {
    const r = createRequestBodySchema.safeParse({ ...base, tagTypeIds: Array.from({ length: 11 }, (_, i) => `66666666-6666-6666-6666-${String(i).padStart(12, "0")}`) });
    expect(r.success).toBe(false);
  });
});
```
Read the existing test file first: the schema's exported name and the exact body shape (customer XOR) must match what is there; adapt `base` accordingly.

- [ ] **Step 2: Run** — `npx vitest run src/lib/admin/create-request.test.ts` → the three new tests FAIL.

- [ ] **Step 3: Schema change** in `create-request.ts`: add the four optional fields with the UUID regex; extend the existing XOR `superRefine` so `contactId`/`locationId` are only allowed when `customerId` is present (`"Pick an existing customer to choose a contact or location."`). Add `jobTypeId`, `contactId`, `locationId`, `tagTypeIds` to `CreateRequestDraft` and the payload builder.

- [ ] **Step 4: Queries** in `createAdminRequest` before building `deps`:
```ts
  const jobTypeRow = input.jobTypeId ? await resolveJobTypeForRequest(organizationId, input.jobTypeId) : null;
  if (input.jobTypeId && !jobTypeRow) return { ok: false, reason: "job_type_not_found" };
  if (input.customer.kind === "existing") {
    if (input.contactId && !(await contactBelongsToCustomer(organizationId, input.customer.customerId, input.contactId))) return { ok: false, reason: "contact_not_owned" };
    if (input.locationId && !(await locationBelongsToCustomer(organizationId, input.customer.customerId, input.locationId))) return { ok: false, reason: "location_not_owned" };
  }
  // The server derives the enum from the row; a client-sent jobType is ignored when jobTypeId is set.
  const jobType = jobTypeRow ? jobTypeRow.kind : resolveJobType(input.issueType, input.jobType);
```
(`locationBelongsToCustomer` = a 4-line select in `location-queries.ts`, add it there.) In the `serviceRequests` insert add `jobTypeId: jobTypeRow?.id ?? null`, `locationId: input.locationId ?? null`, and when `jobTypeRow` is set `estimatedDurationMinutes: jobTypeRow.defaultDurationMinutes, estimatedDurationSource: "job_type"`. Add `jobTypeId: jobTypeRow?.id ?? null` and `contactId: input.contactId ?? null` to the audit `details`. After the save (next to `recordCreated`), when `input.tagTypeIds?.length`, call `replaceEntityTags(organizationId, "job", requestId, input.tagTypeIds)` in a try/catch that logs (`"Office booking saved but tags failed"`). Extend `CreateAdminRequestResult` with the three new failure reasons and map them in `route.ts` to 400 with copy: "That job type isn't available.", "That contact doesn't belong to this customer.", "That location doesn't belong to this customer."

- [ ] **Step 5: Dialog**: replace the job-type `Select` items with the org's active job types (`fetch('/api/admin/settings/job-types')` on open; items `{ value: jt.id, label: jt.name }`; keep an "Auto (match the issue)" item with value `''`). When a job type is picked, prefill `urgency` from `defaultPriority` if the user hasn't touched urgency. After a customer is picked, fetch `/api/admin/customers/<id>/contacts` and the customer's locations (reuse whatever the customer page uses — `useCustomerDetail` returns locations; otherwise `GET /api/admin/customers/<id>` includes them) and show two `Select`s: "Contact" (optional) and "Service location" (defaults to the primary; picking one fills `address`). Add a "Tags" row using `TagChipPicker` in a controlled, pre-save mode: pass `entityId={null}` and `onChange` collecting `tagTypeIds` (extend the picker with an optional `value`/`onChange` controlled mode that does not PUT when `entityId` is null).

- [ ] **Step 6: Probe (Review Focus 2) + screenshots**

```bash
TOKEN=$(node scripts/agent/mint-admin-session.mjs)
curl -s -b "hvac_admin_session=$TOKEN" -H 'content-type: application/json' -X POST http://localhost:3000/api/admin/requests -d '{"customerId":"<cid>","contactId":"<contact of ANOTHER customer>","address":"1 Main St","description":"no heat","issueType":"heating_not_working","urgency":"high"}'
curl -s -b "hvac_admin_session=$TOKEN" -H 'content-type: application/json' -X POST http://localhost:3000/api/admin/requests -d '{"customerId":"<cid>","jobTypeId":"<Installation id>","tagTypeIds":["<Callback id>"],"address":"1 Main St","description":"replace furnace","issueType":"installation","urgency":"medium"}'
```
Expected: first → 400 `CONTACT_NOT_OWNED`; second → 201 with the request whose `jobType` is `install`, `estimatedDurationMinutes` 480 in the DB, and `GET /api/admin/tags/job/<id>` lists Callback. Screenshot the dialog at 1440 and 390 with a customer picked (use `scripts/agent/screenshot-page.mjs` on `/admin/requests` then open the dialog by adding `?new=1` support only if the page already has it; otherwise use the Playwright recipe in `.claude/skills/admin-pages/SKILL.md`). Look at both images.

- [ ] **Step 7: Gates + commit**

```bash
git add src/lib/admin/create-request.ts src/lib/admin/create-request.test.ts src/lib/admin/create-request-queries.ts src/lib/admin/location-queries.ts src/app/api/admin/requests/route.ts src/components/admin/request-create-dialog.tsx src/components/admin/tag-chip-picker.tsx
git commit -m "feat(requests): job type, contact, location and tags on the New request dialog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Docs, skills, parity

**Files:**
- Modify: `.claude/skills/page-settings/SKILL.md` (job types + tags tabs, routes), `.claude/skills/page-customers/SKILL.md` (contacts, primary location, tags), `.claude/skills/page-requests/SKILL.md` (POST body additions + 400 codes)
- Modify: `replica/features.csv` — flip `clone` to `yes` on rows 27 ("Customer and location tags"), 55 ("Job tags with color and dispatch visibility"), 56 ("Org-configurable job types"), 83 ("Job type default duration"), 23 ("Multiple service locations per customer"); row 22 ("Multiple contacts per customer with per-method preferences") to `partial` with note "contacts + roles shipped; per-contact comms routing is M6"; row 49 stays `partial` → `yes` ("Create job from admin with customer / contact / location").
- Modify: `replica/build-log.md` — one line per screen touched (S04 customer, S07 job form, S28 settings), format `S07 | 2026-11-01 | yes | … | …` as the existing line.
- Modify: `replica/parity.md` — regenerate: `python3 .claude/skills/replica-diff/parity.py replica/features.csv --markdown > replica/parity.md`.

- [ ] **Step 1:** Update the three skills; run `node scripts/agent/verify-skills.mjs` → 0 missing.
- [ ] **Step 2:** Flip the CSV rows, regenerate parity, append the build log.
- [ ] **Step 3: Commit**

```bash
git add .claude/skills replica/features.csv replica/parity.md replica/build-log.md
git commit -m "docs(replica): M0b in page skills, feature matrix and build log

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: M0b tables (Task 1), seeding + provisioning (2), settings UI for job types (3) and tags (6), primary location on create/delete/PATCH (4), tags on customer/location/job with ownership checks (5–7), contacts with encryption and erase (7), S07 wiring with duration and ownership checks (8), docs/parity (9). Zones, capacity adjustments, workflows: deferred by spec.
- Type consistency: `TagTypeRecord`, `TagEntity`, `JobTypeRecord`, `ContactRecord` are defined in Tasks 5/2/7 and consumed by name in 6/8.
- Review Focus pins: 1→Task 6 step 5; 2→Task 8 step 6; 3→Task 4 step 1; 4→Task 2 (`resolveJobTypeForRequest` active-only) + Task 3 panel; 5→Task 7 step 4.
