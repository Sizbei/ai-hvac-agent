# Replica M0b: Config Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the office configurable job types with default durations, tags on customers/locations/requests, multiple contacts per customer, a visible list of service locations with one primary, and wire all of it into the New request dialog.

**Architecture:** Four new tables (`tag_types`, `entity_tags`, `customer_contacts`, `job_types`) plus `customer_locations.is_primary`, `service_requests.job_type_id` and `service_requests.contact_id`, delivered as one idempotent hand-authored migration mirrored in `schema.ts`. Client-safe types/schemas live in `*-types.ts` modules (pattern: `org-config-types.ts`); DB access in `*-queries.ts` (pattern: `org-config-queries.ts`); routes follow `api/admin/settings/faqs/route.ts`. No dual writes: the `job_type` enum stays canonical and the server derives it from `job_types.kind`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle ORM 0.45.2 + drizzle-kit 0.31 on Neon (neon-http, `db.batch()` only), zod 4, vitest (pure helpers, mocked `@/lib/db`), Tailwind + `src/components/admin/ui/*` primitives (base-ui, no Popover/Checkbox components exist: use `DropdownMenu` with checkbox items).

**Spec:** `replica/architecture.md` (Schema decisions 1–3, "M0 Foundation" API table, "The parts that bite", build-order item 2) and `replica/schema.sql` (header conventions + section "M0b"). Companion: `replica/design/components.md` ("M0 components"), `replica/review-log.md`.

## Global Constraints

- Gates before every commit: `npx tsc --noEmit` → 0 errors; `npx eslint <changed files>` → 0 errors; `npx vitest run` → capture the live baseline FIRST (`npx vitest run 2>&1 | tail -5`) and never let the pass count drop (baseline 2026-11-01: 4475 passed, 1 skipped).
- No jsdom / React Testing Library. Unit tests mock `@/lib/db` (`vi.mock("@/lib/db", () => ({ db: {...} }))`) and, where a module reads enums at load, `@/lib/db/schema`. Existing tests with fixed schema mocks or statement-count assertions MUST be updated in the same task that changes the module (each task lists them).
- Unique violations: always `import { isUniqueViolation } from "@/lib/db/unique-violation"` (Drizzle wraps driver errors; a top-level `.code` check never matches).
- Request bodies: `const body = await readJsonBody(request); if (!body.ok) return errorResponse("Invalid request body", "VALIDATION_ERROR", 400); const parsed = schema.safeParse(body.data);` (`src/lib/api-response.ts:28` returns `{ ok: true; data } | { ok: false }`).
- neon-http: never `db.transaction()`; multi-statement writes use `db.batch([...])`. Background work: `after()` from `next/server`.
- Tenancy: every query filters by `organizationId` with `withTenant(table, orgId, ...conds)` from `@/lib/db/tenant` (variadic `SQL[]`); every id from a request body or path is re-read under the org (and, for contacts/locations, under the customer) before it is written.
- PII: `encrypt()`/`decrypt()` from `@/lib/crypto`; blind index via `computeContactHashes()` from `@/lib/admin/crm-queries`; sanitise with `sanitizeName` / `sanitizePhone` / `sanitizeEmail` from `@/lib/ai/sanitize-fields`. Contacts never join `findCustomerMatchByContact` / `upsertCustomerByContact`.
- Audit: `logAudit({ organizationId, userId, action, entity, entityId, details? })` — `details` is a JSON string of ids / enums / field names only.
- Copy canon: "request" (never "job" in UI copy), "technician", sentence case, Unicode …; error copy is human and ends with a next step ("Couldn't save the job type. Please try again."); never `err.message`.
- Migration conventions (`replica/schema.sql` header): every statement idempotent (`IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`), every index / unique / check / FK named with the Drizzle name, `--> statement-breakpoint` between statements, `npx drizzle-kit generate` must print "No schema changes" at the end. Drizzle recipe (use this exact order):
  1. `npx drizzle-kit generate` → confirm "No schema changes" (clean baseline).
  2. Edit `src/lib/db/schema.ts`.
  3. `npx drizzle-kit generate --name <name>` → writes `drizzle/00NN_<name>.sql`, `drizzle/meta/00NN_snapshot.json` and the journal entry.
  4. Compare the generated SQL with the hand-authored SQL below (same objects; the generated one lacks idempotency). If objects differ: `git checkout drizzle/meta/_journal.json && rm drizzle/00NN_* drizzle/meta/00NN_snapshot.json`, fix `schema.ts`, go to 3.
  5. Overwrite `drizzle/00NN_<name>.sql` with the hand-authored idempotent SQL.
  6. `npx drizzle-kit generate` → "No schema changes". `git status --short drizzle` shows exactly the new SQL, the new snapshot and ` M drizzle/meta/_journal.json`.
- DB probes run with: `npx tsx -e 'import { neon } from "@neondatabase/serverless"; import { config } from "dotenv"; config({ path: ".env.local" }); const sql = neon(process.env.DATABASE_URL!); console.log(await sql`...`);'` (`.env.local` is the DEV branch; never prod).
- Admin session for curl: `TOKEN=$(npx tsx scripts/agent/mint-admin-session.mjs)`; cookie `hvac_admin_session=$TOKEN`. Screenshots: `node scripts/agent/screenshot-page.mjs <path> [width] [outfile]` (look at the image yourself).
- FROZEN: nothing in `src/lib/ai` prompt text or `src/lib/ai/output-guardrail.ts` changes.
- Commits: conventional type, explicit file list (never `git add -A`), end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Skills: read `.claude/skills/page-settings/SKILL.md`, `page-customers/SKILL.md`, `page-requests/SKILL.md`, `admin-pages/SKILL.md` before editing those pages; after adding routes run `node scripts/agent/verify-skills.mjs` (0 missing paths).
- Work on `main` (the user's instruction); do not deploy.

## Review Focus

1. A tag type belonging to another organisation, or of the wrong entity kind, is sent in `tagTypeIds` → 400 `UNKNOWN_TAG`, never a 500 from the composite FK. (Task 6 step 6.)
2. A `contactId` / `locationId` belonging to a different customer than `customerId` on New request → 400 "That contact doesn't belong to this customer." (Task 8 step 7.)
3. Two concurrent first-location inserts for one customer → exactly one `is_primary`; a lost race on `customer_locations_one_primary_idx` is swallowed. (Task 4 step 2 test.)
4. Deactivating a job type that existing requests reference → requests keep `job_type_id`; `GET …/job-types?active=1` hides it; `job_type` on old rows is untouched. (Task 3 step 5.)
5. Erasing a customer deletes every `customer_contacts` row and every `entity_tags` row for the customer and its locations; a hard `deleteCustomer` does the same; a request hard-delete removes its tag rows. (Task 7a step 4 tests.)

---

## File map

| file | responsibility |
| --- | --- |
| `drizzle/0047_m0b_config_foundation.sql`, `drizzle/meta/_journal.json`, `drizzle/meta/0047_snapshot.json` | idempotent DDL + seed + backfills |
| `src/lib/db/schema.ts` | enum + 4 tables + 3 columns |
| `src/lib/admin/job-type-types.ts` (+ test) | `jobTypeInputSchema`, `DEFAULT_JOB_TYPES`, `JobTypeRecord` (client-safe) |
| `src/lib/admin/job-type-queries.ts` | list / create / update / seed / resolve |
| `src/lib/admin/tag-types.ts` (+ test) | `TAG_COLOR_TOKENS`, `tagBadgeClass`, `tagTypeInputSchema`, `TagTypeRecord` (client-safe) |
| `src/lib/admin/tag-queries.ts`, `src/lib/admin/tag-entity-lookup.ts` | tag CRUD, `replaceEntityTags`, `taggableExists` |
| `src/lib/admin/contact-types.ts` (+ test), `src/lib/admin/contact-queries.ts` | contact schemas (create + patch), CRUD with encrypt/hash |
| `src/lib/admin/location-queries.ts` (+ existing test) | primary flag on create, `setPrimaryLocation`, `listCustomerLocations` returns `isPrimary` |
| `src/app/api/admin/settings/job-types/route.ts`, `…/[id]/route.ts` | GET (`?active=1`) / POST / PATCH |
| `src/app/api/admin/settings/tags/route.ts`, `…/[id]/route.ts` | GET (`?entity=`) / POST / PATCH |
| `src/app/api/admin/tags/[entity]/[id]/route.ts` | GET / PUT the tag set on one entity |
| `src/app/api/admin/customers/[id]/locations/route.ts`, `…/locations/[lid]/route.ts` | GET locations; PATCH isPrimary |
| `src/app/api/admin/customers/[id]/contacts/route.ts`, `…/contacts/[cid]/route.ts` | GET / POST; PATCH / DELETE |
| `src/lib/admin/create-request.ts` (+ test), `create-request-flow.ts`, `create-request-queries.ts`, `src/lib/requests/persist-job-location.ts`, `src/app/api/admin/requests/route.ts` | new fields, ownership checks, derived `jobType`, duration, tags |
| `src/components/admin/settings/job-types-panel.tsx`, `tags-panel.tsx`, `src/app/admin/(dashboard)/settings/page.tsx` | settings tabs (+ `?tab=`) |
| `src/components/admin/tag-chip-picker.tsx` | shared picker (bound + controlled modes) |
| `src/components/admin/customers/contacts-section.tsx`, `locations-section.tsx`, `src/app/admin/(dashboard)/customers/[id]/page.tsx`, `src/components/admin/request-detail-sheet.tsx` | customer page sections, request tags |
| `src/components/admin/request-create-dialog.tsx` | job type / contact / location / tags |
| `src/lib/admin/erasure-queries.ts` (+ test), `crm-queries.ts` (+ test), `conversation-queries.ts` (+ test), `provisioning.ts` (+ test) | erase / delete / seed |
| `.claude/skills/page-*/SKILL.md`, `replica/features.csv`, `replica/parity.md`, `replica/build-log.md` | docs |

---

### Task 1: Migration 0047 + schema.ts mirror

**Files:**
- Modify: `src/lib/db/schema.ts`
- Create (via the drizzle recipe): `drizzle/0047_m0b_config_foundation.sql`, `drizzle/meta/0047_snapshot.json`; modify `drizzle/meta/_journal.json`

**Interfaces:**
- Produces Drizzle exports `tagEntityEnum`, `tagTypes`, `entityTags`, `customerContacts`, `jobTypes`; columns `customerLocations.isPrimary`, `serviceRequests.jobTypeId`, `serviceRequests.contactId`.

- [ ] **Step 1: Baseline** — `npx drizzle-kit generate` → "No schema changes".

- [ ] **Step 2: `schema.ts`**

Add `check`, `foreignKey`, `primaryKey`, `unique`, `smallint` to the `drizzle-orm/pg-core` import (the current import has `pgTable, uuid, text, timestamp, integer, boolean, pgEnum, index, uniqueIndex, varchar, jsonb, doublePrecision, date`). Declare the enum and `tagTypes`/`entityTags`/`jobTypes` right after `customerLocations`, and `customerContacts` after them:

```ts
export const tagEntityEnum = pgEnum("tag_entity", ["customer", "location", "job"]);

// M0b: org-defined tags for customers, locations and requests ("job" is the
// enum value; UI copy says request). `color` is a tag-types.ts token, never hex.
export const tagTypes = pgTable(
  "tag_types",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
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
// tables); deleteCustomer / anonymizeCustomer / the request hard-delete remove rows.
export const entityTags = pgTable(
  "entity_tags",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    tagTypeId: uuid("tag_type_id").notNull(),
    entity: tagEntityEnum("entity").notNull(),
    entityId: uuid("entity_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ name: "entity_tags_tag_type_id_entity_entity_id_pk", columns: [table.tagTypeId, table.entity, table.entityId] }),
    foreignKey({
      name: "entity_tags_tag_type_fk",
      columns: [table.tagTypeId, table.organizationId, table.entity],
      foreignColumns: [tagTypes.id, tagTypes.organizationId, tagTypes.entity],
    }).onDelete("cascade"),
    index("entity_tags_org_entity_idx").on(table.organizationId, table.entity, table.entityId),
  ],
);

// M0b: org-configurable job types. `kind` is the canonical job_type enum the
// AI intake, duration table and FP/HCP mappers keep reading.
export const jobTypes = pgTable(
  "job_types",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
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

// M0b: extra people on a customer account (tenant, property manager…). Same
// encrypt + blind-index shape as customers. NEVER part of the identity lookup.
export const customerContacts = pgTable(
  "customer_contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
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
    uniqueIndex("customer_contacts_one_primary_idx").on(table.customerId).where(sql`${table.isPrimary} = true`),
  ],
);
```

In `customerLocations` add after `zone`:
```ts
    // M0b: exactly one primary per customer (partial unique index below).
    isPrimary: boolean("is_primary").notNull().default(false),
```
and to its index list: `uniqueIndex("customer_locations_one_primary_idx").on(table.customerId).where(sql`${table.isPrimary} = true`),`.

In `serviceRequests` add after `jobType`:
```ts
    // M0b: the org-defined job type row; `jobType` (enum) is derived from its kind.
    jobTypeId: uuid("job_type_id").references(() => jobTypes.id, { onDelete: "set null" }),
    // M0b: the person to contact for this visit (a customer_contacts row).
    contactId: uuid("contact_id").references(() => customerContacts.id, { onDelete: "set null" }),
```
and to its index list: `index("requests_job_type_id_idx").on(table.jobTypeId),`. (`serviceRequests` is at ~line 490 and `customerLocations` at ~2188, so the new tables land after `serviceRequests`; the `() =>` thunks resolve at runtime, exactly as `serviceRequests` already references `customers`, declared at ~724.)

- [ ] **Step 3: Generate** — `npx drizzle-kit generate --name m0b_config_foundation`. Open the generated SQL and confirm it creates exactly: type `tag_entity`; tables `tag_types`, `entity_tags`, `customer_contacts` (incl. `customer_contacts_one_primary_idx`), `job_types`; the two `service_requests` columns + FKs + index; `customer_locations.is_primary` + partial unique index; the constraint names above (drizzle-kit 0.31 generates `service_requests_job_type_id_job_types_id_fk`-style FK names, matching the hand SQL). If anything differs, fix `schema.ts` (recipe step 4) and regenerate.

- [ ] **Step 4: Overwrite the SQL** with this idempotent version (same objects + seed + backfills):

```sql
-- M0b config foundation: tags, contacts, primary location, job types.
-- Every statement is idempotent: the neon-http migrator autocommits per
-- statement and records the file only after all pending files succeed.
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
  ALTER TABLE "tag_types" ADD CONSTRAINT "tag_types_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
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
  ALTER TABLE "entity_tags" ADD CONSTRAINT "entity_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "entity_tags" ADD CONSTRAINT "entity_tags_tag_type_fk" FOREIGN KEY ("tag_type_id","organization_id","entity") REFERENCES "public"."tag_types"("id","organization_id","entity") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_tags_org_entity_idx" ON "entity_tags" USING btree ("organization_id","entity","entity_id");
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
  ALTER TABLE "job_types" ADD CONSTRAINT "job_types_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
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
  ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_location_id_customer_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."customer_locations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_contacts_org_customer_idx" ON "customer_contacts" USING btree ("organization_id","customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_contacts_org_phone_hash_idx" ON "customer_contacts" USING btree ("organization_id","phone_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_contacts_one_primary_idx" ON "customer_contacts" USING btree ("customer_id") WHERE "customer_contacts"."is_primary" = true;
--> statement-breakpoint
ALTER TABLE "customer_locations" ADD COLUMN IF NOT EXISTS "is_primary" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_locations_one_primary_idx" ON "customer_locations" USING btree ("customer_id") WHERE "customer_locations"."is_primary" = true;
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN IF NOT EXISTS "job_type_id" uuid;
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN IF NOT EXISTS "contact_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_job_type_id_job_types_id_fk" FOREIGN KEY ("job_type_id") REFERENCES "public"."job_types"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_contact_id_customer_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."customer_contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "requests_job_type_id_idx" ON "service_requests" USING btree ("job_type_id");
--> statement-breakpoint
-- Backfill: the oldest location per customer becomes primary (runs against
-- the pre-update snapshot, so exactly one row per customer).
UPDATE "customer_locations" l SET "is_primary" = true
  WHERE NOT l."is_primary"
    AND l."id" = (SELECT x."id" FROM "customer_locations" x WHERE x."customer_id" = l."customer_id" ORDER BY x."created_at", x."id" LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM "customer_locations" p WHERE p."customer_id" = l."customer_id" AND p."is_primary");
--> statement-breakpoint
-- Seed one job type per enum value for every existing org (durations from
-- src/lib/ai/dispatch/duration.ts JOB_DURATION_DEFAULTS); ON CONFLICT makes
-- re-runs no-ops. New orgs are seeded by provisioning (Task 2).
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
-- One-off: point existing requests at their org's row for their enum value.
-- AI, FieldPulse and HCP paths keep inserting with job_type_id NULL; readers
-- fall back by kind.
UPDATE "service_requests" r SET "job_type_id" = jt."id"
FROM "job_types" jt
WHERE r."job_type_id" IS NULL AND r."job_type" IS NOT NULL
  AND jt."organization_id" = r."organization_id" AND jt."kind" = r."job_type";
```

- [ ] **Step 5:** `npx drizzle-kit generate` → "No schema changes". `git status --short drizzle` → exactly the three expected entries.

- [ ] **Step 6: Apply twice on dev and verify**

Run: `npm run db:migrate && npm run db:migrate` → both "Migrations complete!".
Probe (DB probe recipe):
```sql
select (select count(*) from job_types) as job_types,
       (select count(*) from service_requests where job_type is not null and job_type_id is null) as unlinked,
       (select count(*) from (select customer_id from customer_locations group by customer_id having count(*) filter (where is_primary) <> 1) x) as bad_primary;
```
Expected: `job_types` ≥ 9 × orgs, `unlinked` 0, `bad_primary` 0.

- [ ] **Step 7: Gates + commit**

Run: `npx tsc --noEmit && npx eslint src/lib/db/schema.ts && npx vitest run 2>&1 | tail -3`
```bash
git add drizzle/0047_m0b_config_foundation.sql drizzle/meta/_journal.json drizzle/meta/0047_snapshot.json src/lib/db/schema.ts
git commit -m "feat(db): M0b config foundation — tags, contacts, primary location, job types

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Job type types + queries + seeding on provision

**Files:**
- Create: `src/lib/admin/job-type-types.ts`, `src/lib/admin/job-type-types.test.ts`, `src/lib/admin/job-type-queries.ts`
- Modify: `src/lib/admin/provisioning.ts` (next to the `seedCommunicationTemplates` call at ~line 289, which runs once for both the first attempt and the slug retry), `src/lib/admin/provisioning.test.ts` (add `vi.mock("./job-type-queries", () => ({ seedDefaultJobTypes: vi.fn().mockResolvedValue(undefined) }))` — mandatory: its schema mock has no `jobTypeEnum`/`urgencyEnum`, so the real module would throw at import)

**Interfaces:**
- `job-type-types.ts` (no DB import):
  ```ts
  export type JobTypeKind = "service_call"|"no_heat"|"no_cool"|"maintenance"|"install"|"estimate"|"warranty"|"diagnostic"|"inspection";  // = jobTypeValues from @/lib/ai/extraction-schema
  export interface JobTypeRecord { id: string; name: string; kind: JobTypeKind; defaultDurationMinutes: number; defaultPriority: "low"|"medium"|"high"|"emergency"; active: boolean; position: number }
  export const jobTypeInputSchema; export type JobTypeInput; export const jobTypePatchSchema = jobTypeInputSchema.partial();
  export const DEFAULT_JOB_TYPES: readonly { name; kind; minutes; priority }[]
  ```
- `job-type-queries.ts`: `listJobTypes(orgId, { activeOnly? })`, `createJobType(orgId, input) → JobTypeRecord | { conflict: true }`, `updateJobType(orgId, id, patch) → JobTypeRecord | null | { conflict: true }`, `seedDefaultJobTypes(orgId)`, `resolveJobTypeForRequest(orgId, id) → { id, kind, defaultDurationMinutes } | null` (active only).

- [ ] **Step 1: Failing tests** (`job-type-types.test.ts`, pure — this module imports only zod and `@/lib/ai/extraction-schema`):

```ts
import { describe, it, expect } from "vitest";
import { jobTypeInputSchema, jobTypePatchSchema, DEFAULT_JOB_TYPES } from "./job-type-types";

describe("jobTypeInputSchema", () => {
  it("accepts a valid job type and trims the name", () => {
    const r = jobTypeInputSchema.safeParse({ name: " Tune-up ", kind: "maintenance", defaultDurationMinutes: 60, defaultPriority: "low" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe("Tune-up");
  });
  it("rejects a duration outside 15..1440, a blank name and an unknown kind", () => {
    expect(jobTypeInputSchema.safeParse({ name: "x", kind: "install", defaultDurationMinutes: 10, defaultPriority: "medium" }).success).toBe(false);
    expect(jobTypeInputSchema.safeParse({ name: "  ", kind: "install", defaultDurationMinutes: 60, defaultPriority: "medium" }).success).toBe(false);
    expect(jobTypeInputSchema.safeParse({ name: "Repair", kind: "repair", defaultDurationMinutes: 60, defaultPriority: "medium" }).success).toBe(false);
  });
  it("patch schema accepts a lone active flag", () => {
    expect(jobTypePatchSchema.safeParse({ active: false }).success).toBe(true);
  });
});

describe("DEFAULT_JOB_TYPES", () => {
  it("covers every job_type enum value exactly once", () => {
    expect([...DEFAULT_JOB_TYPES.map((d) => d.kind)].sort()).toEqual(["diagnostic","estimate","inspection","install","maintenance","no_cool","no_heat","service_call","warranty"]);
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run src/lib/admin/job-type-types.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `job-type-types.ts`**

```ts
import { z } from "zod";
import { jobTypeValues, urgencyValues } from "@/lib/ai/extraction-schema";

export type JobTypeKind = (typeof jobTypeValues)[number];
export type JobTypePriority = (typeof urgencyValues)[number];

export interface JobTypeRecord {
  readonly id: string; readonly name: string; readonly kind: JobTypeKind;
  readonly defaultDurationMinutes: number; readonly defaultPriority: JobTypePriority;
  readonly active: boolean; readonly position: number;
}

export const jobTypeInputSchema = z.object({
  name: z.string().transform((v) => v.trim()).pipe(z.string().min(1, "Name is required.").max(80, "Name must be 80 characters or fewer.")),
  kind: z.enum(jobTypeValues),
  defaultDurationMinutes: z.number().int().min(15).max(1440),
  defaultPriority: z.enum(urgencyValues),
  active: z.boolean().optional(),
  position: z.number().int().min(0).max(999).optional(),
});
export type JobTypeInput = z.infer<typeof jobTypeInputSchema>;
export const jobTypePatchSchema = jobTypeInputSchema.partial();
export type JobTypePatch = z.infer<typeof jobTypePatchSchema>;

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
] as const satisfies readonly { name: string; kind: JobTypeKind; minutes: number; priority: JobTypePriority }[];
```
(Verify `jobTypeValues` and `urgencyValues` are exported from `@/lib/ai/extraction-schema` — `create-request.ts:12-15` imports them, so they are.)

- [ ] **Step 4: Implement `job-type-queries.ts`**

```ts
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobTypes } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import { DEFAULT_JOB_TYPES, type JobTypeInput, type JobTypePatch, type JobTypeRecord } from "./job-type-types";

function toRecord(row: typeof jobTypes.$inferSelect): JobTypeRecord {
  return { id: row.id, name: row.name, kind: row.kind, defaultDurationMinutes: row.defaultDurationMinutes,
    defaultPriority: row.defaultPriority, active: row.active, position: row.position };
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

export async function updateJobType(organizationId: string, id: string, patch: JobTypePatch): Promise<JobTypeRecord | null | { readonly conflict: true }> {
  const set: Partial<typeof jobTypes.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.defaultDurationMinutes !== undefined) set.defaultDurationMinutes = patch.defaultDurationMinutes;
  if (patch.defaultPriority !== undefined) set.defaultPriority = patch.defaultPriority;
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.position !== undefined) set.position = patch.position;
  try {
    const [row] = await db.update(jobTypes).set(set).where(withTenant(jobTypes, organizationId, eq(jobTypes.id, id))).returning();
    return row ? toRecord(row) : null;
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return { conflict: true };
    throw error;
  }
}

/** One row per enum value; ON CONFLICT (org, name) DO NOTHING so re-runs are no-ops. */
export async function seedDefaultJobTypes(organizationId: string): Promise<void> {
  await db.insert(jobTypes).values(DEFAULT_JOB_TYPES.map((d, i) => ({
    organizationId, name: d.name, kind: d.kind, defaultDurationMinutes: d.minutes, defaultPriority: d.priority, position: i,
  }))).onConflictDoNothing({ target: [jobTypes.organizationId, jobTypes.name] });
}

/** Active, org-scoped lookup the create path uses to derive `job_type` and the duration. */
export async function resolveJobTypeForRequest(organizationId: string, jobTypeId: string): Promise<{ id: string; kind: JobTypeRecord["kind"]; defaultDurationMinutes: number } | null> {
  const [row] = await db.select({ id: jobTypes.id, kind: jobTypes.kind, defaultDurationMinutes: jobTypes.defaultDurationMinutes })
    .from(jobTypes).where(withTenant(jobTypes, organizationId, eq(jobTypes.id, jobTypeId), eq(jobTypes.active, true))).limit(1);
  return row ?? null;
}
```

- [ ] **Step 5: Provisioning** — in `provisioning.ts` next to `seedCommunicationTemplates(...)` (~line 289) add:
```ts
  try {
    await seedDefaultJobTypes(organizationId);
  } catch (seedError: unknown) {
    logger.warn({ error: seedError, organizationId }, "Default job types were not seeded");
  }
```
and the mandatory mock in `provisioning.test.ts`.

- [ ] **Step 6: Run** — `npx vitest run src/lib/admin/job-type-types.test.ts src/lib/admin/provisioning.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/admin/job-type-types.ts src/lib/admin/job-type-types.test.ts src/lib/admin/job-type-queries.ts src/lib/admin/provisioning.ts src/lib/admin/provisioning.test.ts
git commit -m "feat(admin): job type types, queries and seeding on provision

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Job types settings API + panel + settings `?tab=`

**Files:**
- Create: `src/app/api/admin/settings/job-types/route.ts`, `src/app/api/admin/settings/job-types/[id]/route.ts`, `src/components/admin/settings/job-types-panel.tsx`
- Modify: `src/app/admin/(dashboard)/settings/page.tsx` (tab "Job types"; read `useSearchParams().get('tab')` as the Tabs `defaultValue` fallback so screenshots can target a tab)

**Interfaces:**
- `GET /api/admin/settings/job-types?active=1` → `{ jobTypes: JobTypeRecord[] }`; `POST` → 201 `{ jobType }`, 409 `DUPLICATE_NAME`, 409 `LIMIT_REACHED` (100); `PATCH …/[id]` with `jobTypePatchSchema` → `{ jobType }` / 404 `NOT_FOUND` / 409 `DUPLICATE_NAME`.

- [ ] **Step 1: Routes** — copy `src/app/api/admin/settings/faqs/route.ts` exactly and change: imports (`listJobTypes, createJobType` from `job-type-queries`, `jobTypeInputSchema` from `job-type-types`), rate-limit keys `admin:job-types-list` / `admin:job-types-create`, the GET reads `request.nextUrl.searchParams.get("active") === "1"` → `{ activeOnly: true }` (GET must take `request: NextRequest`), body via `readJsonBody`, `MAX_JOB_TYPES = 100`, `conflict` → 409 `DUPLICATE_NAME` "A job type with that name already exists.", audit `create_job_type` on entity `job_types`. `[id]/route.ts` PATCH: UUID regex check (copy from `src/app/api/admin/technicians/[id]/route.ts`), `jobTypePatchSchema`, `null` → 404, `conflict` → 409, audit `update_job_type` with `details: JSON.stringify({ fields: Object.keys(parsed.data) })`.

- [ ] **Step 2: Panel** (`job-types-panel.tsx`; compose like `custom-faqs-panel.tsx`; spec: `replica/design/components.md` "Job-type row editor"). Self-fetching: `useEffect` → `fetch('/api/admin/settings/job-types')`. Rows: name (`Input`), kind (`Select` over `jobTypeValues` with `JOB_TYPE_LABELS` from `@/lib/admin/create-request`), default duration (`Input type="number" step={15} className="font-mono w-24"`), default priority (`Select` with `URGENCY_LABELS`), position (`Input type="number" className="w-16"`), active (`Switch`). Save a row on blur/change with `PATCH`; inline add row at the bottom posts. Errors: 409 → "A job type with that name already exists."; other → "Couldn't save the job type. Please try again."

- [ ] **Step 3: Settings tab** — in `settings/page.tsx` add `<TabsTrigger value="job-types"><ClipboardList className="size-4" />Job types</TabsTrigger>` after Services and `<TabsContent value="job-types"><JobTypesPanel /></TabsContent>`; make `defaultValue` come from `useSearchParams().get('tab') ?? 'branding'` (the page is `'use client'` inside a dynamic layout; no `Suspense` wrapper is needed, and `<Tabs>` mounts only after settings load so `defaultValue` takes effect).

- [ ] **Step 4: Probe**

```bash
TOKEN=$(npx tsx scripts/agent/mint-admin-session.mjs)
H='content-type: application/json'
curl -s -b "hvac_admin_session=$TOKEN" http://localhost:3000/api/admin/settings/job-types | head -c 300; echo
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X POST http://localhost:3000/api/admin/settings/job-types -d '{"name":"Duct cleaning","kind":"maintenance","defaultDurationMinutes":120,"defaultPriority":"low"}'; echo
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X POST http://localhost:3000/api/admin/settings/job-types -d '{"name":"Duct cleaning","kind":"maintenance","defaultDurationMinutes":120,"defaultPriority":"low"}'; echo
```
Expected: ≥ 9 rows; 201; **409 `DUPLICATE_NAME`** (this is the `isUniqueViolation` check).

- [ ] **Step 5: Probe Review Focus 4**

```bash
ID=<Duct cleaning id>
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X PATCH http://localhost:3000/api/admin/settings/job-types/$ID -d '{"active":false}'; echo
curl -s -b "hvac_admin_session=$TOKEN" "http://localhost:3000/api/admin/settings/job-types?active=1" | grep -c "$ID"   # 0
curl -s -b "hvac_admin_session=$TOKEN" "http://localhost:3000/api/admin/settings/job-types" | grep -c "$ID"            # 1
```
Then `node scripts/agent/screenshot-page.mjs "/admin/settings?tab=job-types" 1440` and look at it.

- [ ] **Step 6: Gates + commit**

```bash
git add src/app/api/admin/settings/job-types src/components/admin/settings/job-types-panel.tsx 'src/app/admin/(dashboard)/settings/page.tsx'
git commit -m "feat(settings): configurable job types with default duration

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Locations — primary flag, list endpoint, customer-page section

**Files:**
- Modify: `src/lib/admin/location-queries.ts`, `src/lib/admin/location-queries.test.ts` (existing; mock has `db: { select, insert }` — add `execute`)
- Create: `src/app/api/admin/customers/[id]/locations/route.ts` (GET), `src/app/api/admin/customers/[id]/locations/[lid]/route.ts` (PATCH `{ isPrimary: true }`)
- Create: `src/components/admin/customers/locations-section.tsx`; modify `src/app/admin/(dashboard)/customers/[id]/page.tsx` (mount it after the header card; the page has no locations block today)

**Interfaces:**
- `listCustomerLocations` rows gain `isPrimary: boolean` (the `CustomerLocation` type is declared in `location-queries.ts:27`).
- `setPrimaryLocation(orgId, customerId, locationId): Promise<boolean>`; `locationBelongsToCustomer(orgId, customerId, locationId): Promise<boolean>` (used by Tasks 7a and 8).
- `GET /api/admin/customers/[id]/locations` → `{ locations: CustomerLocation[] }` (addresses decrypted; admin-only like the customer detail route).

- [ ] **Step 1: Failing tests** (append to `location-queries.test.ts`; follow its existing `mockSelectOnce` / insert-mock helpers, and add `execute: vi.fn()` to the `@/lib/db` mock):

```ts
it("marks the first location primary with a guarded UPDATE and returns the id", async () => {
  mockSelectOnce([]);                      // no existing by hash
  // insert mock returns [{ id: "loc-new" }] as in the existing "inserts and returns" test
  vi.mocked(db.execute).mockResolvedValueOnce({ rows: [] } as never);
  await expect(upsertCustomerLocation(ORG, CUST, { address: "9 Elm St" })).resolves.toBe("loc-new");
  expect(db.execute).toHaveBeenCalledTimes(1);
});
it("swallows a lost primary race (wrapped 23505)", async () => {
  mockSelectOnce([]);
  vi.mocked(db.execute).mockRejectedValueOnce(Object.assign(new Error("q"), { cause: { code: "23505", constraint: "customer_locations_one_primary_idx" } }));
  await expect(upsertCustomerLocation(ORG, CUST, { address: "9 Elm St" })).resolves.toBe("loc-new");
});
it("rethrows a non-unique error from the primary UPDATE", async () => {
  mockSelectOnce([]);
  vi.mocked(db.execute).mockRejectedValueOnce(new Error("boom"));
  await expect(upsertCustomerLocation(ORG, CUST, { address: "9 Elm St" })).rejects.toThrow("boom");
});
```
(Read the existing file first and reuse its exact helper names and constants. Set the insert mock explicitly in EACH of the three tests — do not rely on a mock left in place by an earlier test.)

- [ ] **Step 2: Implement** in `location-queries.ts` (add `import { sql } from "drizzle-orm"` and `import { isUniqueViolation } from "@/lib/db/unique-violation"`). `upsertCustomerLocation` has three returns: the dedupe hit (`return existing.id`, ~line 64) stays as is and skips the primary step (an existing location already went through it). Replace the two later returns (`created.id`, `winner!.id`) with a single `const locationId = created?.id ?? winner!.id;` followed by:

```ts
  // First location becomes primary. A separate guarded UPDATE (never part of
  // the insert) so a lost race on customer_locations_one_primary_idx is
  // harmless: the predicate re-checks at write time, and a wrapped 23505 from
  // a concurrent winner is swallowed.
  try {
    await db.execute(sql`
      UPDATE customer_locations SET is_primary = true
      WHERE id = ${locationId} AND organization_id = ${organizationId}
        AND NOT EXISTS (SELECT 1 FROM customer_locations p WHERE p.customer_id = ${customerId} AND p.is_primary)`);
  } catch (error: unknown) {
    if (!isUniqueViolation(error, "customer_locations_one_primary_idx")) throw error;
  }
  return locationId;
```
Add:
```ts
export async function locationBelongsToCustomer(organizationId: string, customerId: string, locationId: string): Promise<boolean> {
  const [row] = await db.select({ id: customerLocations.id }).from(customerLocations)
    .where(withTenant(customerLocations, organizationId, eq(customerLocations.id, locationId), eq(customerLocations.customerId, customerId))).limit(1);
  return Boolean(row);
}

export async function setPrimaryLocation(organizationId: string, customerId: string, locationId: string): Promise<boolean | { readonly reason: "race" }> {
  if (!(await locationBelongsToCustomer(organizationId, customerId, locationId))) return false;
  try { await db.batch([
    db.update(customerLocations).set({ isPrimary: false })
      .where(withTenant(customerLocations, organizationId, eq(customerLocations.customerId, customerId), eq(customerLocations.isPrimary, true))),
    db.update(customerLocations).set({ isPrimary: true })
      .where(withTenant(customerLocations, organizationId, eq(customerLocations.id, locationId))),
  ]); } catch (error: unknown) {
    // Two concurrent "make primary" calls: the second set trips the partial unique index.
    if (isUniqueViolation(error, "customer_locations_one_primary_idx")) return { reason: "race" };
    throw error;
  }
  return true;
}
```
and include `isPrimary: customerLocations.isPrimary` in `listCustomerLocations`'s select + mapped output. (There is no location delete path in the codebase, so no re-selection is needed.)

- [ ] **Step 3: Routes** — GET: `getAdminSession`, `adminRead` limit, UUID check, confirm the customer exists in the org (`db.select({ id: customers.id }).from(customers).where(withTenant(customers, orgId, eq(customers.id, id))).limit(1)` → 404), return `listCustomerLocations`. PATCH: `adminMutation` limit, body `z.object({ isPrimary: z.literal(true) })` via `readJsonBody`, `setPrimaryLocation` → `false` → 404, `{ reason: "race" }` → 409 "Someone else just changed the primary location. Reload and try again.", audit `set_primary_location` (entity `customer_locations`, entityId `lid`, details `{ customerId }`).

- [ ] **Step 4: Section** (`locations-section.tsx`): `SectionCard` "Service locations"; rows: address, label muted, "Primary" chip, zone muted; row menu "Make primary" (PATCH then refetch). Mount in `customers/[id]/page.tsx`. (The location tag picker is mounted in Task 7b once the picker exists.)

- [ ] **Step 5: Probe**

```bash
CID=<customer with 2+ locations: select customer_id from customer_locations group by 1 having count(*)>1 limit 1>
curl -s -b "hvac_admin_session=$TOKEN" http://localhost:3000/api/admin/customers/$CID/locations; echo
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X PATCH http://localhost:3000/api/admin/customers/$CID/locations/<non-primary lid> -d '{"isPrimary":true}'; echo
```
Expected: list shows exactly one `isPrimary: true`; after PATCH the other one is primary; the Task 1 `bad_primary` probe is still 0. Screenshot `/admin/customers/$CID` at 1440.

- [ ] **Step 6: Gates + commit**

```bash
git add src/lib/admin/location-queries.ts src/lib/admin/location-queries.test.ts 'src/app/api/admin/customers/[id]/locations' src/components/admin/customers/locations-section.tsx 'src/app/admin/(dashboard)/customers/[id]/page.tsx'
git commit -m "feat(customers): service locations list with one primary per customer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Tag types + queries

**Files:**
- Create: `src/lib/admin/tag-types.ts`, `src/lib/admin/tag-types.test.ts`, `src/lib/admin/tag-queries.ts`, `src/lib/admin/tag-entity-lookup.ts`

**Interfaces:**
- `tag-types.ts` (client-safe):
  ```ts
  export const TAG_ENTITIES = ["customer", "location", "job"] as const; export type TagEntity = (typeof TAG_ENTITIES)[number];
  export const TAG_COLOR_TOKENS = ["graphite", "marker", "danger", "success", "warning", "info"] as const; export type TagColor = …;
  export interface TagTypeRecord { id; entity: TagEntity; name; color: TagColor; visibleOnBoard: boolean; active: boolean }
  export const tagTypeInputSchema; export const tagTypePatchSchema (no entity); export function tagBadgeClass(color: TagColor): string
  ```
- `tag-queries.ts`: `listTagTypes(orgId, { entity?, activeOnly? })`, `createTagType`, `updateTagType` (conflict handling via `isUniqueViolation`), `listEntityTags(orgId, entity, entityIds) → ReadonlyMap<string, TagTypeRecord[]>`, `validateTagTypeIds(orgId, entity, ids) → { ok: true; ids: string[] } | { ok: false }` (active, right kind, right org, de-duplicated), `replaceEntityTags(orgId, entity, entityId, ids) → { ok: true } | { ok: false; reason: "unknown_tag" }`.
- `tag-entity-lookup.ts`: `taggableExists(orgId, entity, id): Promise<boolean>`.

- [ ] **Step 1: Failing tests** (`tag-types.test.ts`, pure):

```ts
import { describe, it, expect } from "vitest";
import { tagTypeInputSchema, tagTypePatchSchema, tagBadgeClass, TAG_COLOR_TOKENS } from "./tag-types";

describe("tagTypeInputSchema", () => {
  it("trims the name and accepts a token colour", () => {
    const r = tagTypeInputSchema.safeParse({ entity: "job", name: " VIP ", color: "danger" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe("VIP");
  });
  it("rejects a hex colour, an unknown entity, and a patch that changes entity", () => {
    expect(tagTypeInputSchema.safeParse({ entity: "job", name: "VIP", color: "#ff0000" }).success).toBe(false);
    expect(tagTypeInputSchema.safeParse({ entity: "invoice", name: "VIP", color: "marker" }).success).toBe(false);
    expect("entity" in tagTypePatchSchema.shape).toBe(false);
  });
});
describe("tagBadgeClass", () => {
  it("returns a class string for every token", () => {
    for (const c of TAG_COLOR_TOKENS) expect(tagBadgeClass(c)).toMatch(/^bg-/);
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement `tag-types.ts`**

```ts
import { z } from "zod";

export const TAG_ENTITIES = ["customer", "location", "job"] as const;
export type TagEntity = (typeof TAG_ENTITIES)[number];
export const TAG_COLOR_TOKENS = ["graphite", "marker", "danger", "success", "warning", "info"] as const;
export type TagColor = (typeof TAG_COLOR_TOKENS)[number];

export interface TagTypeRecord {
  readonly id: string; readonly entity: TagEntity; readonly name: string;
  readonly color: TagColor; readonly visibleOnBoard: boolean; readonly active: boolean;
}

export const tagTypeInputSchema = z.object({
  entity: z.enum(TAG_ENTITIES),
  name: z.string().transform((v) => v.trim()).pipe(z.string().min(1, "Name is required.").max(40, "Name must be 40 characters or fewer.")),
  color: z.enum(TAG_COLOR_TOKENS),
  visibleOnBoard: z.boolean().optional(),
  active: z.boolean().optional(),
});
export type TagTypeInput = z.infer<typeof tagTypeInputSchema>;
export const tagTypePatchSchema = tagTypeInputSchema.omit({ entity: true }).partial();
export type TagTypePatch = z.infer<typeof tagTypePatchSchema>;

/** Token → the text/background pairs status-colors.ts proves ≥ 4.5:1. */
const BADGE: Record<TagColor, string> = {
  graphite: "bg-muted text-muted-foreground border-border",
  marker: "bg-marker-light text-marker-strong border-marker-border",
  danger: "bg-danger-light text-danger-strong border-danger-border",
  success: "bg-success-light text-success-strong border-success-border",
  warning: "bg-warning-light text-warning-strong border-warning-border",
  info: "bg-info-light text-info-strong border-info-border",
};
export function tagBadgeClass(color: TagColor): string { return BADGE[color] ?? BADGE.graphite; }
export function isTagColor(v: string): v is TagColor { return (TAG_COLOR_TOKENS as readonly string[]).includes(v); }
```
Every class pair above already exists in `src/lib/admin/status-colors.ts` (the `info` pair is used by `SESSION_STATUS_BADGE`).

- [ ] **Step 4: Implement `tag-queries.ts`**

```ts
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { tagTypes, entityTags } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import { isTagColor, type TagEntity, type TagTypeInput, type TagTypePatch, type TagTypeRecord } from "./tag-types";

function toRecord(row: typeof tagTypes.$inferSelect): TagTypeRecord {
  return { id: row.id, entity: row.entity, name: row.name, color: isTagColor(row.color) ? row.color : "graphite", visibleOnBoard: row.visibleOnBoard, active: row.active };
}

export async function listTagTypes(organizationId: string, opts: { readonly entity?: TagEntity; readonly activeOnly?: boolean } = {}): Promise<readonly TagTypeRecord[]> {
  const rows = await db.select().from(tagTypes)
    .where(withTenant(tagTypes, organizationId,
      ...(opts.entity ? [eq(tagTypes.entity, opts.entity)] : []),
      ...(opts.activeOnly ? [eq(tagTypes.active, true)] : [])))
    .orderBy(asc(tagTypes.entity), asc(tagTypes.name));
  return rows.map(toRecord);
}

export async function createTagType(organizationId: string, input: TagTypeInput): Promise<TagTypeRecord | { readonly conflict: true }> {
  try {
    const [row] = await db.insert(tagTypes).values({ organizationId, entity: input.entity, name: input.name, color: input.color,
      visibleOnBoard: input.visibleOnBoard ?? false, active: input.active ?? true }).returning();
    if (!row) throw new Error("Failed to create tag");
    return toRecord(row);
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return { conflict: true };
    throw error;
  }
}

export async function updateTagType(organizationId: string, id: string, patch: TagTypePatch): Promise<TagTypeRecord | null | { readonly conflict: true }> {
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

/** Tags for many entities at once; map key = entityId. */
export async function listEntityTags(organizationId: string, entity: TagEntity, entityIds: readonly string[]): Promise<ReadonlyMap<string, readonly TagTypeRecord[]>> {
  const out = new Map<string, TagTypeRecord[]>();
  if (entityIds.length === 0) return out;
  const rows = await db.select({ entityId: entityTags.entityId, tag: tagTypes }).from(entityTags)
    .innerJoin(tagTypes, eq(tagTypes.id, entityTags.tagTypeId))
    .where(withTenant(entityTags, organizationId, eq(entityTags.entity, entity), inArray(entityTags.entityId, [...entityIds])))
    .orderBy(asc(tagTypes.name));
  for (const r of rows) { const list = out.get(r.entityId) ?? []; list.push(toRecord(r.tag)); out.set(r.entityId, list); }
  return out;
}

/** Re-read tag ids under the org with the right kind and active = true. */
export async function validateTagTypeIds(organizationId: string, entity: TagEntity, ids: readonly string[]): Promise<{ readonly ok: true; readonly ids: readonly string[] } | { readonly ok: false }> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { ok: true, ids: [] };
  const found = await db.select({ id: tagTypes.id }).from(tagTypes)
    .where(withTenant(tagTypes, organizationId, eq(tagTypes.entity, entity), eq(tagTypes.active, true), inArray(tagTypes.id, unique)));
  return found.length === unique.length ? { ok: true, ids: unique } : { ok: false };
}

/** Replace the tag set on one entity. The CALLER verified the entity belongs
 * to the org. Delete + insert in one batch. */
export async function replaceEntityTags(organizationId: string, entity: TagEntity, entityId: string, tagTypeIds: readonly string[]): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: "unknown_tag" }> {
  const valid = await validateTagTypeIds(organizationId, entity, tagTypeIds);
  if (!valid.ok) return { ok: false, reason: "unknown_tag" };
  const del = db.delete(entityTags).where(withTenant(entityTags, organizationId, eq(entityTags.entity, entity), eq(entityTags.entityId, entityId)));
  if (valid.ids.length === 0) { await del; return { ok: true }; }
  await db.batch([del, db.insert(entityTags).values(valid.ids.map((tagTypeId) => ({ organizationId, tagTypeId, entity, entityId })))]);
  return { ok: true };
}
```

`tag-entity-lookup.ts`:
```ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers, customerLocations, serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import type { TagEntity } from "./tag-types";

/** True when `[entity]/[id]` exists in this org. Path ids are never trusted. */
export async function taggableExists(organizationId: string, entity: TagEntity, id: string): Promise<boolean> {
  const query =
    entity === "customer" ? db.select({ id: customers.id }).from(customers).where(withTenant(customers, organizationId, eq(customers.id, id)))
    : entity === "location" ? db.select({ id: customerLocations.id }).from(customerLocations).where(withTenant(customerLocations, organizationId, eq(customerLocations.id, id)))
    : db.select({ id: serviceRequests.id }).from(serviceRequests).where(withTenant(serviceRequests, organizationId, eq(serviceRequests.id, id)));
  const [row] = await query.limit(1);
  return Boolean(row);
}
```

- [ ] **Step 5: Run tests + commit**

```bash
npx vitest run src/lib/admin/tag-types.test.ts
git add src/lib/admin/tag-types.ts src/lib/admin/tag-types.test.ts src/lib/admin/tag-queries.ts src/lib/admin/tag-entity-lookup.ts
git commit -m "feat(admin): tag types and entity tag queries

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Tag routes, settings panel, chip picker

**Files:**
- Create: `src/app/api/admin/settings/tags/route.ts` (GET `?entity=&active=1`, POST), `…/tags/[id]/route.ts` (PATCH with `tagTypePatchSchema`)
- Create: `src/app/api/admin/tags/[entity]/[id]/route.ts` (GET, PUT)
- Create: `src/components/admin/settings/tags-panel.tsx`, `src/components/admin/tag-chip-picker.tsx`
- Modify: `src/app/admin/(dashboard)/settings/page.tsx` (tab "Tags", icon `Tag`)

**Interfaces:**
- `PUT /api/admin/tags/{customer|location|job}/{id}` body `{ tagTypeIds: string[] }` (≤ 20) → 200 `{ tags }`, 404 when the entity isn't in the org, 400 `UNKNOWN_TAG`. `GET` → `{ tags }`.
- `TagChipPicker` props (final, both modes, defined here):
  ```ts
  interface TagChipPickerProps {
    readonly entity: TagEntity;
    /** Bound mode: PUTs on every change. Controlled mode (null): no network; value/onChange drive state. */
    readonly entityId: string | null;
    readonly initialTags?: readonly TagTypeRecord[];   // bound mode; when absent the picker GETs /api/admin/tags/{entity}/{id}
    readonly value?: readonly string[];                 // controlled mode
    readonly onChange?: (ids: readonly string[]) => void;
    readonly size?: "sm" | "md";
  }
  ```

- [ ] **Step 1: `tags/[entity]/[id]/route.ts`**

```ts
import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { listEntityTags, replaceEntityTags } from "@/lib/admin/tag-queries";
import { TAG_ENTITIES, type TagEntity } from "@/lib/admin/tag-types";
import { taggableExists } from "@/lib/admin/tag-entity-lookup";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bodySchema = z.object({ tagTypeIds: z.array(z.string().regex(UUID_REGEX)).max(20) });

function parseParams(p: { entity: string; id: string }): { entity: TagEntity; id: string } | null {
  if (!(TAG_ENTITIES as readonly string[]).includes(p.entity) || !UUID_REGEX.test(p.id)) return null;
  return { entity: p.entity as TagEntity, id: p.id };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ entity: string; id: string }> }) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const p = parseParams(await params);
    if (!p || !(await taggableExists(session.organizationId, p.entity, p.id))) return errorResponse("Not found", "NOT_FOUND", 404);
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
    if (!body.ok) return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    const parsed = bodySchema.safeParse(body.data);
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

- [ ] **Step 2: `settings/tags/route.ts` + `[id]/route.ts`** — copy Task 3's job-types routes; GET takes `entity` (validated against `TAG_ENTITIES`) and `active=1`; POST uses `tagTypeInputSchema`, 409 `DUPLICATE_NAME` "A tag with that name already exists for this type."; cap 100 per org; PATCH uses `tagTypePatchSchema`; audit `create_tag_type` / `update_tag_type` on entity `tag_types`.

- [ ] **Step 3: Chip picker** (`tag-chip-picker.tsx`, spec "Tag chip picker"). Chips: `<span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[12px]", tagBadgeClass(tag.color))}>` with an × `button` (`aria-label="Remove tag <name>"`); Backspace on a focused chip removes it. "Add tag" opens a `DropdownMenu` whose items are `DropdownMenuCheckboxItem`s for the org's active tag types of `entity` (fetched once from `/api/admin/settings/tags?entity=…&active=1`), plus a "New tag…" item that CLOSES the menu and reveals an inline name `Input` + colour `Select` below the chips (a text input inside the base-ui menu would fight its keyboard navigation), which POSTs to `/api/admin/settings/tags`. Bound mode: every change PUTs the full id set, optimistic, revert + inline "Couldn't save tags. Please try again." on failure; when `initialTags` is absent, GET on mount. Controlled mode: `value`/`onChange` only. Chips with `visibleOnBoard` get `title="Shown on board"`.

- [ ] **Step 4: Settings panel** (`tags-panel.tsx`): three `Card`s titled "Customers", "Locations", "Requests"; rows: name `Input`, colour `Select` over `TAG_COLOR_TOKENS` rendering a swatch `span` with `tagBadgeClass`, "Show on board" `Switch` (Requests group only), active `Switch`; inline add row per group. Tab wired in `settings/page.tsx` as "Tags" (`value="tags"`).

- [ ] **Step 5: Probe**

```bash
TOKEN=$(npx tsx scripts/agent/mint-admin-session.mjs); H='content-type: application/json'
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X POST http://localhost:3000/api/admin/settings/tags -d '{"entity":"job","name":"Callback","color":"danger","visibleOnBoard":true}'; echo
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X POST http://localhost:3000/api/admin/settings/tags -d '{"entity":"customer","name":"VIP","color":"marker"}'; echo
RID=<a request id in this org>; JOBTAG=<Callback id>; CUSTTAG=<VIP id>; CID=<customer id>
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X PUT http://localhost:3000/api/admin/tags/job/$RID -d "{\"tagTypeIds\":[\"$JOBTAG\"]}"; echo        # 200, tags: [Callback]
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X PUT http://localhost:3000/api/admin/tags/customer/$CID -d "{\"tagTypeIds\":[\"$CUSTTAG\"]}"; echo  # 200
```

- [ ] **Step 6: Probe Review Focus 1 (wrong kind + other org)**

```bash
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X PUT http://localhost:3000/api/admin/tags/job/$RID -d "{\"tagTypeIds\":[\"$CUSTTAG\"]}"; echo   # 400 UNKNOWN_TAG
OTHER_ORG=<id of another org on dev: select id from organizations where id <> '<this org>' limit 1>
TOKEN2=$(MINT_ORG_ID=$OTHER_ORG npx tsx scripts/agent/mint-admin-session.mjs)
OTHERTAG=$(curl -s -b "hvac_admin_session=$TOKEN2" -H "$H" -X POST http://localhost:3000/api/admin/settings/tags -d '{"entity":"job","name":"Foreign","color":"info"}' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X PUT http://localhost:3000/api/admin/tags/job/$RID -d "{\"tagTypeIds\":[\"$OTHERTAG\"]}"; echo   # 400 UNKNOWN_TAG, never 500
```
Screenshot `/admin/settings?tab=tags` at 1440 and look at it.

- [ ] **Step 7: Gates + commit**

```bash
git add src/app/api/admin/settings/tags src/app/api/admin/tags src/components/admin/settings/tags-panel.tsx src/components/admin/tag-chip-picker.tsx 'src/app/admin/(dashboard)/settings/page.tsx'
git commit -m "feat(admin): tag types settings, entity tag routes, chip picker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7a: Contacts — types, queries, routes, erase and delete coverage

**Files:**
- Create: `src/lib/admin/contact-types.ts`, `src/lib/admin/contact-types.test.ts`, `src/lib/admin/contact-queries.ts`
- Create: `src/app/api/admin/customers/[id]/contacts/route.ts` (GET, POST), `…/contacts/[cid]/route.ts` (PATCH, DELETE)
- Modify: `src/lib/admin/erasure-queries.ts` + `erasure-queries.test.ts` (schema mock at lines ~113–134 gains `customerContacts`, `entityTags`; add `inArray` if the mock stubs drizzle-orm), `src/lib/admin/crm-queries.ts` `deleteCustomer` + `crm-queries.test.ts` (schema mock at ~138–187 gains `entityTags`, `customerLocations`; `expect(statements).toHaveLength(7)` → 9), `src/lib/admin/conversation-queries.ts` + `conversation-queries.test.ts` (schema mock at ~58–78 gains `entityTags`; `toHaveLength(6)` → 7)

**Interfaces:**
- `contact-types.ts`: `ContactRecord { id; customerId; locationId: string|null; name; role: string|null; phone: string|null; email: string|null; isPrimary; position }`, `contactInputSchema` (create: name required), `contactPatchSchema` (every field optional, NO `undefined → null` transform; `null` means "clear").
- `contact-queries.ts`: `listContacts`, `createContact → ContactRecord | { reason: "location_not_owned" }`, `updateContact → ContactRecord | null | { reason: "location_not_owned" }`, `deleteContact → boolean`, `contactBelongsToCustomer → boolean`, `toContactRow(name, phone, email)`.

- [ ] **Step 1: Failing tests** (`contact-types.test.ts`; pure — read `sanitizePhone` at `src/lib/ai/sanitize-fields.ts:98` first: it returns the input formatted as-is for a valid 10-digit number, so assert the exact string it returns):

```ts
import { describe, it, expect } from "vitest";
import { contactInputSchema, contactPatchSchema } from "./contact-types";

describe("contactInputSchema", () => {
  it("sanitises name, phone and email", () => {
    const r = contactInputSchema.safeParse({ name: "  jane   DOE ", phone: "(423) 555-0100", email: " Jane@Example.com " });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe("Jane Doe");
      expect(r.data.phone).toBe("(423) 555-0100");
      expect(r.data.email).toBe("jane@example.com");
    }
  });
  it("rejects a 7-digit phone, a bad email and a missing name", () => {
    expect(contactInputSchema.safeParse({ name: "Jane", phone: "555-0100" }).success).toBe(false);
    expect(contactInputSchema.safeParse({ name: "Jane", email: "nope" }).success).toBe(false);
    expect(contactInputSchema.safeParse({ phone: "4235550100" }).success).toBe(false);
  });
});
describe("contactPatchSchema", () => {
  it("leaves omitted fields undefined (so PATCH {isPrimary:true} clears nothing)", () => {
    const r = contactPatchSchema.safeParse({ isPrimary: true });
    expect(r.success).toBe(true);
    if (r.success) { expect(r.data.phone).toBeUndefined(); expect(r.data.email).toBeUndefined(); expect(r.data.role).toBeUndefined(); }
  });
  it("accepts null to clear a field", () => {
    const r = contactPatchSchema.safeParse({ phone: null });
    expect(r.success && r.data.phone === null).toBe(true);
  });
});
```

- [ ] **Step 2: Implement `contact-types.ts`**

```ts
import { z } from "zod";
import { sanitizeName, sanitizePhone, sanitizeEmail } from "@/lib/ai/sanitize-fields";
import { isPhoneComplete } from "@/lib/ai/extraction-schema";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const phoneField = z.string().max(40).transform((v) => sanitizePhone(v)).refine((v) => isPhoneComplete(v), "Phone must be a 10-digit US number.");
const emailField = z.string().max(254).transform((v) => sanitizeEmail(v)).refine((v) => z.email().safeParse(v).success, "Email address isn't valid.");
const roleField = z.string().max(60).transform((v) => v.trim());
const nameField = z.string().transform((v) => sanitizeName(v)).pipe(z.string().min(1, "Name is required.").max(200));

export const contactInputSchema = z.object({
  name: nameField,
  role: roleField.nullable().optional().transform((v) => (v ? v : null)),
  phone: phoneField.nullable().optional().transform((v) => v ?? null),
  email: emailField.nullable().optional().transform((v) => v ?? null),
  locationId: z.string().regex(UUID_REGEX).nullable().optional().transform((v) => v ?? null),
  isPrimary: z.boolean().optional(),
});
export type ContactInput = z.infer<typeof contactInputSchema>;

/** PATCH: omitted = unchanged (undefined), null = clear. No undefined→null transform. */
export const contactPatchSchema = z.object({
  name: nameField.optional(),
  role: roleField.nullable().optional(),
  phone: phoneField.nullable().optional(),
  email: emailField.nullable().optional(),
  locationId: z.string().regex(UUID_REGEX).nullable().optional(),
  isPrimary: z.boolean().optional(),
});
export type ContactPatch = z.infer<typeof contactPatchSchema>;

export interface ContactRecord {
  readonly id: string; readonly customerId: string; readonly locationId: string | null;
  readonly name: string; readonly role: string | null; readonly phone: string | null; readonly email: string | null;
  readonly isPrimary: boolean; readonly position: number;
}
```
(Verified with a zod probe: the schemas behave exactly as the tests expect. Blank strings are rejected by `phoneField`/`emailField`, so the Task 7b dialog sends `null` (or omits the key) for an empty input.)

- [ ] **Step 3: Implement `contact-queries.ts`**

```ts
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerContacts } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { encrypt, decrypt } from "@/lib/crypto";
import { computeContactHashes } from "@/lib/admin/crm-queries";
import { locationBelongsToCustomer } from "@/lib/admin/location-queries";
import type { ContactInput, ContactPatch, ContactRecord } from "./contact-types";

function safeDecrypt(v: string | null): string | null { if (!v) return null; try { return decrypt(v); } catch { return null; } }
function toRecord(r: typeof customerContacts.$inferSelect): ContactRecord {
  return { id: r.id, customerId: r.customerId, locationId: r.locationId, name: safeDecrypt(r.nameEncrypted) ?? "", role: r.role,
    phone: safeDecrypt(r.phoneEncrypted), email: safeDecrypt(r.emailEncrypted), isPrimary: r.isPrimary, position: r.position };
}

/** Encrypt + blind-index exactly like customers (same normaliser). */
export function toContactRow(name: string, phone: string | null, email: string | null) {
  const hashes = computeContactHashes({ email, phone });
  return { nameEncrypted: encrypt(name), phoneEncrypted: phone ? encrypt(phone) : null, phoneHash: hashes.phoneHash,
    emailEncrypted: email ? encrypt(email) : null, emailHash: hashes.emailHash };
}

export async function listContacts(organizationId: string, customerId: string): Promise<readonly ContactRecord[]> {
  const rows = await db.select().from(customerContacts)
    .where(withTenant(customerContacts, organizationId, eq(customerContacts.customerId, customerId)))
    .orderBy(asc(customerContacts.position), asc(customerContacts.createdAt));
  return rows.map(toRecord);
}

export async function contactBelongsToCustomer(organizationId: string, customerId: string, contactId: string): Promise<boolean> {
  const [row] = await db.select({ id: customerContacts.id }).from(customerContacts)
    .where(withTenant(customerContacts, organizationId, eq(customerContacts.id, contactId), eq(customerContacts.customerId, customerId))).limit(1);
  return Boolean(row);
}

/** One primary per customer (customer_contacts_one_primary_idx). Setting a
 * new primary unsets the others in the same batch. */
function unsetPrimary(organizationId: string, customerId: string) {
  return db.update(customerContacts).set({ isPrimary: false })
    .where(withTenant(customerContacts, organizationId, eq(customerContacts.customerId, customerId), eq(customerContacts.isPrimary, true)));
}

export async function createContact(organizationId: string, customerId: string, input: ContactInput): Promise<ContactRecord | { readonly reason: "location_not_owned" }> {
  if (input.locationId && !(await locationBelongsToCustomer(organizationId, customerId, input.locationId))) return { reason: "location_not_owned" };
  const id = randomUUID();
  const insert = db.insert(customerContacts).values({
    id, organizationId, customerId, locationId: input.locationId, role: input.role, isPrimary: input.isPrimary ?? false,
    ...toContactRow(input.name, input.phone, input.email),
  });
  if (input.isPrimary) await db.batch([unsetPrimary(organizationId, customerId), insert]); else await insert;
  const [row] = await db.select().from(customerContacts).where(withTenant(customerContacts, organizationId, eq(customerContacts.id, id))).limit(1);
  if (!row) throw new Error("Failed to create contact");
  return toRecord(row);
}

export async function updateContact(organizationId: string, customerId: string, contactId: string, patch: ContactPatch): Promise<ContactRecord | null | { readonly reason: "location_not_owned" }> {
  if (patch.locationId && !(await locationBelongsToCustomer(organizationId, customerId, patch.locationId))) return { reason: "location_not_owned" };
  const [existing] = await db.select().from(customerContacts)
    .where(withTenant(customerContacts, organizationId, eq(customerContacts.id, contactId), eq(customerContacts.customerId, customerId))).limit(1);
  if (!existing) return null;
  const name = patch.name ?? safeDecrypt(existing.nameEncrypted) ?? "";
  const phone = patch.phone === undefined ? safeDecrypt(existing.phoneEncrypted) : patch.phone;
  const email = patch.email === undefined ? safeDecrypt(existing.emailEncrypted) : patch.email;
  const update = db.update(customerContacts).set({
    ...toContactRow(name, phone, email),
    role: patch.role === undefined ? existing.role : patch.role,
    locationId: patch.locationId === undefined ? existing.locationId : patch.locationId,
    isPrimary: patch.isPrimary ?? existing.isPrimary,
    updatedAt: new Date(),
  }).where(withTenant(customerContacts, organizationId, eq(customerContacts.id, contactId)));
  if (patch.isPrimary === true && !existing.isPrimary) await db.batch([unsetPrimary(organizationId, customerId), update]); else await update;
  const [row] = await db.select().from(customerContacts).where(withTenant(customerContacts, organizationId, eq(customerContacts.id, contactId))).limit(1);
  return row ? toRecord(row) : null;
}

export async function deleteContact(organizationId: string, customerId: string, contactId: string): Promise<boolean> {
  const rows = await db.delete(customerContacts)
    .where(withTenant(customerContacts, organizationId, eq(customerContacts.id, contactId), eq(customerContacts.customerId, customerId)))
    .returning({ id: customerContacts.id });
  return rows.length > 0;
}
```

- [ ] **Step 4: Routes** — `contacts/route.ts` GET/POST and `[cid]/route.ts` PATCH/DELETE in the faqs shape: UUID-check params; confirm the customer exists in the org (404); `readJsonBody`; `contactInputSchema` / `contactPatchSchema`; `location_not_owned` → 400 "That location doesn't belong to this customer."; cap 20 contacts (409 `LIMIT_REACHED` "A customer can have at most 20 contacts."); audit `create_contact` / `update_contact` / `delete_contact` on entity `customer_contacts`, details `{ customerId }`.

- [ ] **Step 5: Erase + delete coverage (Review Focus 5)**

`erasure-queries.ts` batch — add three statements (contacts carry their own PII, delete outright; tags are not PII but must not dangle):
```ts
    db.delete(customerContacts).where(withTenant(customerContacts, organizationId, eq(customerContacts.customerId, customerId))),
    db.delete(entityTags).where(withTenant(entityTags, organizationId, eq(entityTags.entity, "customer"), eq(entityTags.entityId, customerId))),
    db.delete(entityTags).where(withTenant(entityTags, organizationId, eq(entityTags.entity, "location"),
      inArray(entityTags.entityId, db.select({ id: customerLocations.id }).from(customerLocations).where(withTenant(customerLocations, organizationId, eq(customerLocations.customerId, customerId)))))),
```
`crm-queries.ts` `deleteCustomer` batch — add the same two `entityTags` deletes before the `customers` delete (contacts cascade by FK). `conversation-queries.ts` request hard-delete — add, BEFORE the `delete(serviceRequests)` statement ("1b"), using the existing `sessionRequestIds` subquery (~line 431):
```ts
    db.delete(entityTags).where(withTenant(entityTags, organizationId, eq(entityTags.entity, "job"), inArray(entityTags.entityId, sessionRequestIds))),
```
Tests: in `erasure-queries.test.ts` add `customerContacts`, `entityTags`, `customerLocations` (if absent) to the schema mock and assert the batch includes deletes on `customer_contacts` and `entity_tags` in the existing assertion style; in `crm-queries.test.ts` add `entityTags`, `customerLocations` to the mock and bump `toHaveLength(7)` → `9`; in `conversation-queries.test.ts` add `entityTags` and bump `toHaveLength(6)` → `7`.

- [ ] **Step 6: Run** — `npx vitest run src/lib/admin/contact-types.test.ts src/lib/admin/erasure-queries.test.ts src/lib/admin/crm-queries.test.ts src/lib/admin/conversation-queries.test.ts` → PASS.

- [ ] **Step 7: Probe**

```bash
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X POST http://localhost:3000/api/admin/customers/$CID/contacts -d '{"name":"Pat Tenant","role":"tenant","phone":"4235550199"}'; echo
curl -s -b "hvac_admin_session=$TOKEN" http://localhost:3000/api/admin/customers/$CID/contacts; echo
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X PATCH http://localhost:3000/api/admin/customers/$CID/contacts/<cid2> -d '{"isPrimary":true}'; echo   # phone still present
```
Erase probe on a throwaway customer (seed one with `scripts/agent/seed-org.mjs` or create via the customers API): add a contact + a customer tag, `POST /api/admin/customers/<id>/erase` (read the route for its body), then DB probe `select (select count(*) from customer_contacts where customer_id='<id>'), (select count(*) from entity_tags where entity_id='<id>')` → `0, 0`.

- [ ] **Step 8: Gates + commit**

```bash
git add src/lib/admin/contact-types.ts src/lib/admin/contact-types.test.ts src/lib/admin/contact-queries.ts 'src/app/api/admin/customers/[id]/contacts' src/lib/admin/erasure-queries.ts src/lib/admin/erasure-queries.test.ts src/lib/admin/crm-queries.ts src/lib/admin/crm-queries.test.ts src/lib/admin/conversation-queries.ts src/lib/admin/conversation-queries.test.ts
git commit -m "feat(customers): contacts with encrypted PII; erase and delete paths cover contacts and tags

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7b: Contacts section + tag pickers on the customer page and request sheet

**Files:**
- Create: `src/components/admin/customers/contacts-section.tsx`
- Modify: `src/app/admin/(dashboard)/customers/[id]/page.tsx` (mount `ContactsSection`; mount `<TagChipPicker entity="customer" entityId={customer.id} />` in the header area), `src/components/admin/customers/locations-section.tsx` (add `<TagChipPicker entity="location" entityId={loc.id} size="sm" />` per row), `src/components/admin/request-detail-sheet.tsx` (a "Tags" row with `<TagChipPicker entity="job" entityId={request.id} />` — read `.claude/skills/page-requests/SKILL.md` first)

- [ ] **Step 1: `contacts-section.tsx`** (spec "Contacts editor"): `SectionCard` "Contacts"; self-fetch `/api/admin/customers/<id>/contacts`; rows: name, role muted, phone/email `font-mono text-[13px]`, "Primary" chip; row `DropdownMenu`: Edit, Make primary, Remove (`ConfirmDialog`); add/edit `Dialog` with name, role, phone, email, location `Select` (from `/api/admin/customers/<id>/locations`), "Primary" `Switch`; blank phone/email/role inputs are sent as `null` (create) or omitted (edit), never as `""`. Copy: "Couldn't save the contact. Please try again."
- [ ] **Step 2: Mount** the pickers and section as listed.
- [ ] **Step 3: Screenshots**: `node scripts/agent/screenshot-page.mjs /admin/customers/$CID 1440` and `… 390`; `/admin/requests` with the detail sheet open is not scriptable by path, so verify the request tags via the Task 6 curl and the sheet by the Playwright snippet in Task 8 step 8 (same script, click a request row instead of "New request"). Look at every image; nothing overflows at 390.
- [ ] **Step 4: Gates + commit**

```bash
git add src/components/admin/customers/contacts-section.tsx src/components/admin/customers/locations-section.tsx 'src/app/admin/(dashboard)/customers/[id]/page.tsx' src/components/admin/request-detail-sheet.tsx
git commit -m "feat(customers): contacts section and tag pickers on customers, locations and requests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: New request dialog — job type, contact, location, tags

**Files:**
- Modify: `src/lib/admin/create-request.ts` (`bodySchema` ~line 129, `CreateRequestInput` ~159–171, the `data` mapping in `parseCreateRequestBody` ~234–247, the `hasId === hasInline` check ~214–218, `CreateRequestDraft` + `buildCreateRequestPayload` ~390), `src/lib/admin/create-request.test.ts` (uses `parse = (raw) => parseCreateRequestBody(raw, TODAY)` and `baseBody()`; v4-shaped UUIDs like `11111111-1111-4111-8111-111111111111`; the typed `CreateRequestDraft` literal at ~195–208 must gain the new optional fields)
- Modify: `src/lib/admin/create-request-flow.ts` (`CreateAdminRequestResult` ~36–50: add reasons), `src/lib/admin/create-request-queries.ts`, `src/lib/requests/persist-job-location.ts` (skip the `locationId` overwrite when the request already has one), `src/app/api/admin/requests/route.ts` (map the new reasons), `src/components/admin/request-create-dialog.tsx`

**Interfaces:**
- POST body gains `jobTypeId?: uuid`, `contactId?: uuid`, `locationId?: uuid`, `tagTypeIds?: uuid[] (≤10)`. `contactId`/`locationId` require `customerId` (not an inline customer). New 400 codes: `JOB_TYPE_NOT_FOUND`, `CONTACT_NOT_OWNED`, `LOCATION_NOT_OWNED`, `UNKNOWN_TAG`. `estimatedDurationSource` value `"job_type"`. When `jobTypeId` is sent, the server derives `jobType` from `job_types.kind` and ignores a client `jobType`.

- [ ] **Step 1: Failing tests** (append to `create-request.test.ts`, using its helpers):

```ts
describe("M0b fields", () => {
  const JT = "22222222-2222-4222-8222-222222222222", CT = "33333333-3333-4333-8333-333333333333", LOC = "44444444-4444-4444-8444-444444444444", TAG = "55555555-5555-4555-8555-555555555555";
  it("accepts jobTypeId, contactId, locationId and tags with an existing customer", () => {
    const r = parse({ ...baseBody(), jobTypeId: JT, contactId: CT, locationId: LOC, tagTypeIds: [TAG] });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.data.jobTypeId).toBe(JT); expect(r.data.contactId).toBe(CT); expect(r.data.locationId).toBe(LOC); expect(r.data.tagTypeIds).toEqual([TAG]); }
  });
  it("rejects contactId/locationId with an inline customer", () => {
    const body = { ...baseBody(), customerId: undefined, customer: { name: "New Person" }, contactId: CT };
    const r = parse(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/existing customer/i);
  });
  it("rejects more than 10 tags", () => {
    const r = parse({ ...baseBody(), tagTypeIds: Array.from({ length: 11 }, (_, i) => `66666666-6666-4666-8666-${String(i).padStart(12, "0")}`) });
    expect(r.ok).toBe(false);
  });
});
```
(Match `baseBody()`'s real inline-customer shape — read the file; if inline customers are `customer: {...}` with no `customerId`, build the body that way.)

- [ ] **Step 2: Run** → the three new tests FAIL.

- [ ] **Step 3: `create-request.ts`** — add to `bodySchema`: `jobTypeId: z.uuid().optional()`, `contactId: z.uuid().optional()`, `locationId: z.uuid().optional()`, `tagTypeIds: z.array(z.uuid()).max(10).optional()`. After the `hasId === hasInline` check add: `if (!hasId && (b.contactId || b.locationId)) return { ok: false, message: "Pick an existing customer to choose a contact or location." };` (`b` is the parsed body; `raw` is `unknown`; same return shape as the XOR failure). Add the four fields to `CreateRequestInput` (`readonly jobTypeId: string | null; readonly contactId: string | null; readonly locationId: string | null; readonly tagTypeIds: readonly string[]`) and to the `data` mapping (`?? null` / `?? []`). Add optional `jobTypeId`, `contactId`, `locationId`, `tagTypeIds` to `CreateRequestDraft` and send them from `buildCreateRequestPayload`; when `draft.jobTypeId` is set do NOT send `jobType`.

- [ ] **Step 4: `create-request-flow.ts`** — extend `CreateAdminRequestResult` failures with `reason: "job_type_not_found" | "contact_not_owned" | "location_not_owned" | "unknown_tag"`.

- [ ] **Step 5: `create-request-queries.ts`** — in `createAdminRequest` before `deps`:
```ts
  const jobTypeRow = input.jobTypeId ? await resolveJobTypeForRequest(organizationId, input.jobTypeId) : null;
  if (input.jobTypeId && !jobTypeRow) return { ok: false, reason: "job_type_not_found" };
  if (input.customer.kind === "existing") {   // CreateRequestCustomer = { kind: "existing"; customerId } (create-request.ts:144)
    if (input.contactId && !(await contactBelongsToCustomer(organizationId, input.customer.customerId, input.contactId))) return { ok: false, reason: "contact_not_owned" };
    if (input.locationId && !(await locationBelongsToCustomer(organizationId, input.customer.customerId, input.locationId))) return { ok: false, reason: "location_not_owned" };
  }
  const tags = await validateTagTypeIds(organizationId, "job", input.tagTypeIds);
  if (!tags.ok) return { ok: false, reason: "unknown_tag" };
  // The server derives the enum from the row; a client-sent jobType is ignored when jobTypeId is set.
  const jobType = jobTypeRow ? jobTypeRow.kind : resolveJobType(input.issueType, input.jobType);   // REPLACES the existing `const jobType = …` at ~line 202
```
In the `serviceRequests` insert add `jobTypeId: jobTypeRow?.id ?? null, contactId: input.contactId, locationId: input.locationId,` and when `jobTypeRow` is set `estimatedDurationMinutes: jobTypeRow.defaultDurationMinutes, estimatedDurationSource: "job_type"`. Audit `details` gains `jobTypeId`, `contactId`, `locationId`, `tagTypeIds` (ids only). After the save (next to `recordCreated`), when `tags.ids.length > 0`: `await replaceEntityTags(organizationId, "job", requestId, tags.ids)` in try/catch logging `"Office booking saved but tags failed"`.

`persist-job-location.ts` (~54–70): only `.set({ locationId })` when the request's `locationId` is null — add `isNull(serviceRequests.locationId)` to that UPDATE's where (read how it is called from `create-request-queries.ts:349-357`).

`route.ts`: map the four reasons to 400 with codes `JOB_TYPE_NOT_FOUND` "That job type isn't available.", `CONTACT_NOT_OWNED` "That contact doesn't belong to this customer.", `LOCATION_NOT_OWNED` "That location doesn't belong to this customer.", `UNKNOWN_TAG` "One of those tags doesn't exist."

- [ ] **Step 6: Dialog** — bind the job-type `Select` to `draft.jobTypeId` (items from `/api/admin/settings/job-types?active=1`: `{ value: jt.id, label: jt.name }`, plus "Auto (match the issue)" → `''`); on pick, prefill `urgency` from `defaultPriority` when the user has not touched urgency. After a customer is picked: fetch `/api/admin/customers/<id>/contacts` and `/api/admin/customers/<id>/locations`; show "Contact" (optional) and "Service location" `Select`s; default location = the primary; picking one fills `address`. `clearCustomer()` resets `contactId`/`locationId`. "Tags" row: `<TagChipPicker entity="job" entityId={null} value={draft.tagTypeIds ?? []} onChange={(ids) => patch({ tagTypeIds: ids })} />`.

- [ ] **Step 7: Probe Review Focus 2 + the happy path**

```bash
OTHER_CONTACT=<a contact id belonging to a different customer>
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X POST http://localhost:3000/api/admin/requests -d "{\"customerId\":\"$CID\",\"contactId\":\"$OTHER_CONTACT\",\"address\":\"1 Main St\",\"description\":\"no heat\",\"issueType\":\"heating_not_working\",\"urgency\":\"high\"}"; echo   # 400 CONTACT_NOT_OWNED
INSTALL=<Installation job type id>
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X POST http://localhost:3000/api/admin/requests -d "{\"customerId\":\"$CID\",\"jobTypeId\":\"$INSTALL\",\"tagTypeIds\":[\"$JOBTAG\"],\"address\":\"1 Main St\",\"description\":\"replace furnace\",\"issueType\":\"installation\",\"urgency\":\"medium\"}"; echo
```
DB probe on the new request: `select job_type, job_type_id, estimated_duration_minutes, estimated_duration_source from service_requests where id = '<new id>'` → `install`, the id, `480`, `job_type`; `GET /api/admin/tags/job/<new id>` → Callback.

- [ ] **Step 8: Dialog screenshots** (inline Playwright; `playwright` is a devDependency):

```bash
cat > /tmp/dialog-shot.mjs <<'EOF'
import { chromium } from "playwright";
const token = process.argv[2], width = Number(process.argv[3] ?? 1440), out = process.argv[4] ?? `/tmp/dialog-${width}.png`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
await ctx.addCookies([{ name: "hvac_admin_session", value: token, domain: "localhost", path: "/" }]);
const page = await ctx.newPage();
await page.goto("http://localhost:3000/admin/requests", { waitUntil: "networkidle" });
await page.getByRole("button", { name: "New request" }).click();
await page.getByPlaceholder(/search/i).first().fill("Testy");
await page.waitForTimeout(800);
await page.getByRole("option").first().click().catch(() => page.locator("[data-customer-result]").first().click());
await page.waitForTimeout(500);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(out);
EOF
node /tmp/dialog-shot.mjs "$TOKEN" 1440 && node /tmp/dialog-shot.mjs "$TOKEN" 390
```
(Adjust the selectors to the dialog's real markup.) Look at both images: job type select, Contact, Service location and Tags rows are all present.

- [ ] **Step 9: Gates + commit**

```bash
git add src/lib/admin/create-request.ts src/lib/admin/create-request.test.ts src/lib/admin/create-request-flow.ts src/lib/admin/create-request-queries.ts src/lib/requests/persist-job-location.ts src/app/api/admin/requests/route.ts src/components/admin/request-create-dialog.tsx
git commit -m "feat(requests): job type, contact, location and tags on the New request dialog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Docs, skills, parity

- [ ] Update `.claude/skills/page-settings/SKILL.md` (Job types + Tags tabs, `?tab=`, routes), `page-customers/SKILL.md` (contacts, locations + primary, tags, erase coverage), `page-requests/SKILL.md` (POST body additions + 400 codes, tags on the sheet). `node scripts/agent/verify-skills.mjs` → 0 missing.
- [ ] `replica/features.csv`: flip `clone` to `yes` on rows "Customer and location tags" (27), "Job tags with color and dispatch visibility" (55), "Org-configurable job types" (56), "Job type default duration" (83), "Multiple service locations per customer" (23), "Create job from admin with customer / contact / location" (49); row "Multiple contacts per customer with per-method preferences" (22) → `partial` with note "contacts + roles + primary shipped; per-contact comms routing is M6". Regenerate: `python3 .claude/skills/replica-diff/parity.py replica/features.csv --markdown > replica/parity.md`. Append `replica/build-log.md` lines for S04, S07, S28 in the existing format.
- [ ] Commit:

```bash
git add .claude/skills replica/features.csv replica/parity.md replica/build-log.md
git commit -m "docs(replica): M0b in page skills, feature matrix and build log

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: tables + columns (T1), job types + seed (T2–T3), primary location + list + section (T4), tags (T5–T6), contacts + erase (T7a–7b), S07 wiring incl. duration and ownership (T8), docs (T9). Deferred by spec: zones, capacity adjustments, workflows.
- Review Focus pins: 1 → T6 step 6; 2 → T8 step 7; 3 → T4 step 1 tests; 4 → T3 step 5; 5 → T7a steps 5–7.
- Type names used across tasks: `JobTypeRecord`, `TagTypeRecord`, `TagEntity`, `ContactRecord`, `locationBelongsToCustomer`, `contactBelongsToCustomer`, `validateTagTypeIds`, `replaceEntityTags`, `resolveJobTypeForRequest` — each defined once in T2/T4/T5/T7a and consumed by name.
