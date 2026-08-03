### Task 1: Migration 0041 + schema.ts columns

Adds the four telemetry columns to `dispatch_decisions`. Nothing reads them yet; this unblocks Tasks 2–4. No test file (schema/migration only); the gate is `tsc` + the schema-consuming test suites staying green.

**Files:**
- Create: `drizzle/0041_dispatch_telemetry.sql`
- Create: `drizzle/meta/0041_snapshot.json`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/lib/db/schema.ts` (dispatchDecisions table, ~line 2449 before `createdAt`)

**Interfaces:**
- Consumes: nothing.
- Produces: `dispatchDecisions.overriddenTechnicianId: uuid|null`, `.overriddenByUserId: uuid|null`, `.overriddenAt: Date|null`, `.isShadow: boolean` (drizzle column refs for later tasks). Also extends the `candidates` JSONB `$type` with an optional `skillMatched?: boolean` (a `$type`-only change, no DDL) that Task 3 stores and Task 6 reads.

- [ ] **Step 1: Write the migration SQL.** Create `drizzle/0041_dispatch_telemetry.sql` (idempotent — `ADD COLUMN IF NOT EXISTS`, and FK adds guarded so re-run never errors):
```sql
ALTER TABLE "dispatch_decisions" ADD COLUMN IF NOT EXISTS "overridden_technician_id" uuid;--> statement-breakpoint
ALTER TABLE "dispatch_decisions" ADD COLUMN IF NOT EXISTS "overridden_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "dispatch_decisions" ADD COLUMN IF NOT EXISTS "overridden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dispatch_decisions" ADD COLUMN IF NOT EXISTS "is_shadow" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dispatch_decisions" ADD CONSTRAINT "dispatch_decisions_overridden_technician_id_users_id_fk" FOREIGN KEY ("overridden_technician_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dispatch_decisions" ADD CONSTRAINT "dispatch_decisions_overridden_by_user_id_users_id_fk" FOREIGN KEY ("overridden_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
```

- [ ] **Step 2: Append the journal entry.** In `drizzle/meta/_journal.json`, append to the `entries` array (after the `0040_faulty_manta` object, idx 40). Add a comma after the `0040` closing brace, then:
```json
    {
      "idx": 41,
      "version": "7",
      "when": 1784500000000,
      "tag": "0041_dispatch_telemetry",
      "breakpoints": true
    }
```

- [ ] **Step 3: Create the snapshot.** Copy `drizzle/meta/0040_snapshot.json` to `drizzle/meta/0041_snapshot.json`, then edit the copy exactly as follows:
  1. Change the top-level `"id"` to a new random UUID (any distinct UUIDv4, e.g. `"a1a2a3a4-b1b2-c1c2-d1d2-e1e2e3e4e5e6"`).
  2. Change the top-level `"prevId"` to the OLD file's `"id"` value: `"d4306722-6f32-4d29-95f8-c4e2eb7e7b31"`.
  3. In `tables["public.dispatch_decisions"].columns`, add these four entries (place them after `"candidates"` and before `"created_at"`):
```json
    "overridden_technician_id": {
      "name": "overridden_technician_id",
      "type": "uuid",
      "primaryKey": false,
      "notNull": false
    },
    "overridden_by_user_id": {
      "name": "overridden_by_user_id",
      "type": "uuid",
      "primaryKey": false,
      "notNull": false
    },
    "overridden_at": {
      "name": "overridden_at",
      "type": "timestamp with time zone",
      "primaryKey": false,
      "notNull": false
    },
    "is_shadow": {
      "name": "is_shadow",
      "type": "boolean",
      "primaryKey": false,
      "notNull": true,
      "default": false
    },
```
  4. In `tables["public.dispatch_decisions"].foreignKeys`, add these two entries (alongside the existing three):
```json
    "dispatch_decisions_overridden_technician_id_users_id_fk": {
      "name": "dispatch_decisions_overridden_technician_id_users_id_fk",
      "tableFrom": "dispatch_decisions",
      "tableTo": "users",
      "columnsFrom": ["overridden_technician_id"],
      "columnsTo": ["id"],
      "onDelete": "set null",
      "onUpdate": "no action"
    },
    "dispatch_decisions_overridden_by_user_id_users_id_fk": {
      "name": "dispatch_decisions_overridden_by_user_id_users_id_fk",
      "tableFrom": "dispatch_decisions",
      "tableTo": "users",
      "columnsFrom": ["overridden_by_user_id"],
      "columnsTo": ["id"],
      "onDelete": "set null",
      "onUpdate": "no action"
    },
```

- [ ] **Step 4: Add the schema columns.** In `src/lib/db/schema.ts`, inside `dispatchDecisions` (after the `candidates` field, before `createdAt` at ~line 2449):
```ts
    // ── Override telemetry (0041): the human's final pick recorded against the
    // autopilot decision. Set by stampDispatchOverride on any HUMAN (re)assignment
    // when chosen_technician_id IS DISTINCT FROM the pick. Last-write-wins.
    overriddenTechnicianId: uuid("overridden_technician_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    overriddenByUserId: uuid("overridden_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    overriddenAt: timestamp("overridden_at", { withTimezone: true }),
    // Shadow mode (0041): true for a would-be decision recorded for an autopilot-
    // OFF org (preview + tuning dataset); never touches service_requests. Operational
    // reads filter is_shadow=false; tuning/health reads split both.
    isShadow: boolean("is_shadow").notNull().default(false),
```
  Also extend the `candidates` JSONB `$type` (~line 2437) to carry the per-candidate `skillMatched` flag Task 3 will store and Task 6 will read back (optional so legacy rows without it still typecheck). Change the `.$type<Array<{ ... }>>()` to add `skillMatched?: boolean;`:
```ts
    candidates: jsonb("candidates")
      .$type<
        Array<{
          technicianId: string;
          score: number;
          reasons: string[];
          travelKm?: number | null;
          travelMinutes?: number | null;
          // Stored by recordDispatchDecision (Task 3); read by the decision panel
          // (Task 6). Optional: rows recorded before this field omit it (unknown).
          skillMatched?: boolean;
        }>
      >()
      .notNull()
      .default(sql`'[]'::jsonb`),
```
  (This is a `$type`-only change — no column DDL, so migration 0041 is unaffected.)

- [ ] **Step 5: Run the gate.**
```bash
npx tsc --noEmit
npx eslint src/lib/db/schema.ts
npx vitest run src/lib/admin/scheduling-queries.test.ts src/lib/ai/dispatch/signals.test.ts
```
Expected: 0 tsc errors, 0 eslint problems, all suites green (the new columns are additive; existing tests untouched).

- [ ] **Step 6: Commit.**
```bash
git add drizzle/0041_dispatch_telemetry.sql drizzle/meta/0041_snapshot.json drizzle/meta/_journal.json src/lib/db/schema.ts
git commit -m "$(cat <<'EOF'
feat(dispatch): 0041 telemetry columns — override stamp + is_shadow

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

