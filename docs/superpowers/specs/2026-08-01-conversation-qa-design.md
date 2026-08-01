# Conversation QA scoring (Avoca Phase A) — design (round 2)

**Date:** 2026-08-01 · **Status:** revised after 2-critic round 1
**Premise:** the pure QA modules exist and are offline-tested —
`src/lib/ai/eval/judge.ts` (judgeTranscript, degrade-safe, judgeAvailable),
`src/lib/ai/qa/transcript-adapter.ts`, `qa/transcript-flags.ts`,
`qa/call-qa.ts`, `qa/call-outcome.ts`. This feature wires them at conversation
end, persists one QA row per session, surfaces scores in admin. Guardrail
regexes untouched. ONE types-only change to a pure module is allowed:
`judgeTranscript`'s FIRST parameter narrows to
`Pick<GoldenTranscript, "description" | "userTurns">` — exactly the two
fields `renderConversation` reads. (`botReplies` is NOT a GoldenTranscript
field; it stays the separate second parameter.) The call from score-session:
`judgeTranscript({ description: t.description, userTurns: t.userTurns },
t.botReplies, entry.id)` where `t` is the adapter's JudgeReadyTranscript.
Zero behavior change.

## Definitions

**QA-terminal** := `status IN ('submitted', 'escalated', 'abandoned')`.
Do NOT use `isTerminalState()` — the repo's `TERMINAL_STATES` excludes
`submitted` (state-machine canon; `submitted: []` makes it behaviorally
terminal). The state machine guarantees no transitions out of any QA-terminal
state, so `ON CONFLICT (session_id) DO NOTHING` is sufficient idempotency
(confirmed: escalated→submitted is impossible).

## Behavior

New module `src/lib/ai/qa/score-session.ts`:
`scoreConversationQa({ organizationId, sessionId, definiteOutcome })` where
`definiteOutcome: "booked" | "escalated" | "abandoned"` is passed BY THE
CALLER — never read from `customer_sessions.outcome`, which is written
concurrently by `summarizeAndClassifySession` (race confirmed in review).
`classifyCallOutcome` receives this parameter directly.

Flow: read session row (turnCount, channel) + messages in one batch →
**truncate to the LAST 20 turn PAIRS** (a turn = one user+bot exchange pair
in the adapter's paired arrays, so ≤40 messages; when trimmed, prepend a
synthetic user turn "[Earlier turns omitted]" so the judge knows) →
`assessTranscriptFlags` (ALL messages, untruncated — regexes are cheap) →
judge decision → persist. Intentional asymmetry, state it in admin copy:
`hard_fail` reflects flags over the WHOLE conversation; judge scores describe
the (possibly truncated) tail — a high-scoring row with hardFail=true is
coherent (early violation, good late service).
Empty messages: flags are zero-flags (pure fns accept empty arrays — assert
in tests), judge skipped `too_short`.

Judge runs only when: `definiteOutcome !== "abandoned"` AND `turnCount >= 2`
AND `judgeAvailable(entry.id)`. Model chain, spelled out:
`const entry = await resolveModelEntry(organizationId)` (provider.ts — org's
configured model, DB read, default fallback) → pass `entry.id` as the
`modelId` argument to `judgeAvailable`/`judgeTranscript`. Never pass orgId to
judgeTranscript.

`judge_skipped_reason` enum (complete): `no_key` | `too_short` | `abandoned`
| `judge_error` (judge attempted, `scores === null` — store the JudgeResult
`note` in `judge_rationale` for debuggability). Scores null ⇒ reason set;
scores present ⇒ reason null.

### Hook sites (each a NEW, SEPARATE `after()` registration with its own
try/catch + logger.warn — a QA throw must never affect its neighbors)

| Terminal | Site | definiteOutcome |
|---|---|---|
| submitted | `src/lib/requests/submit-session-request.ts` ~line 499, a sibling `after()` next to the summarize registration | "booked" |
| escalated | `src/lib/ai/escalate-service.ts` ~line 83, sibling `after()` | "escalated" |
| abandoned | `src/app/api/cron/cleanup/route.ts` — REQUIRES two changes: the abandon UPDATE gains `.returning({ id, organizationId })` (neon-http returns nothing from UPDATE otherwise), and `after` must be imported from next/server (other crons do). Loop the returned pairs. | "abandoned" |

### Coverage self-heal (closes the after()-drop gap)

`after()` is fire-and-forget: a killed function leaves a session permanently
unscored and silently skews aggregates. The SAME cleanup cron, after the
abandon block, sweeps: QA-terminal sessions with no `conversation_qa` row,
`updatedAt` between 7 days and 10 minutes ago, LIMIT 50 per run →
`scoreConversationQa` each (definiteOutcome mapped from status:
submitted→"booked", escalated→"escalated", abandoned→"abandoned").
Idempotent by the unique constraint. No new cron file (Vercel Hobby daily
cap). Accepted limitation, stated plainly: the cron is DAILY, so a dropped
after() is healed with up to ~24h lag — aggregates self-correct by the next
day, not in near-real-time.

## Storage

Table `conversation_qa`, migration `drizzle/0044_conversation_qa.sql`
(hand-authored recipe: `CREATE TABLE IF NOT EXISTS` idempotency,
statement-breakpoint separators, journal entry idx 44, snapshot copy,
`drizzle-kit generate` reports no changes; run on BOTH Neon branches):
`id uuid pk defaultRandom` · `organization_id uuid notNull → organizations
cascade` · `session_id uuid notNull UNIQUE → customer_sessions cascade` ·
`hard_fail boolean notNull` · `violations jsonb $type<string[]> notNull
default '[]'::jsonb` · `coaching_gaps jsonb $type<string[]> notNull default
'[]'::jsonb` (jsonb is house style — no text[] anywhere in schema) ·
`naturalness integer` · `helpfulness integer` · `completion integer`
(1-5, null = judge skipped; integer not smallint — house style) ·
`judge_rationale text` · `judge_model text` · `judge_tokens integer notNull
default 0` · `judge_skipped_reason text` · `outcome text notNull` (from
classifyCallOutcome; never null — definiteOutcome guarantees input) ·
`recovery_candidate boolean notNull default false` · `lost_to_violation
boolean notNull default false` · `created_at timestamptz notNull defaultNow`
· index `(organization_id, created_at)`.
No PII. `deleteConversation` needs no change: the migration DDL MUST include
`ON DELETE CASCADE` on session_id (this is a deliberate exception to the
"none of the dependent tables declare ON DELETE CASCADE" comment in
conversation-queries.ts — update that comment), and the deleteConversation
test must assert the QA row is gone.

## Surfaces

1. **Conversation detail** (`conversation-detail-content.tsx`, after the
   AI-summary callout): "Quality" SectionCard, always rendered when a QA row
   exists — hardFail danger badge OR three labeled 1-5 scores; violations +
   coaching gaps as chips using HUMANIZED labels (a `QA_LABELS` map in the
   component, e.g. no-greeting → "No greeting"); judge rationale as muted
   text; skipped state keeps the flags and shows "Judge review skipped —
   <human reason>" (reason map, not the enum value).
2. **Inbox** (three-file cascade, named): `conversation-queries.ts`
   getConversations gains a LEFT JOIN selecting `hard_fail`, `completion`;
   `conversation-types.ts` ConversationSummary gains `qaHardFail: boolean |
   null`, `qaCompletion: number | null`; `conversation-inbox.tsx` row renders
   a red "QA fail" chip on hardFail, an amber "Low score" chip when
   `completion <= 2` (a binary-only chip hides bad-but-not-failing sessions —
   review finding), nothing otherwise.
3. **Insights** (`/admin/insights` bot-analytics area): new
   `getConversationQaStats(orgId, period)` in bot-analytics-queries.ts —
   added as a FOURTH member of the existing `Promise.all` (NOT db.batch — the
   function uses Promise.all; review-corrected). Tiles: sessions scored,
   hard-fail rate, avg completion, top coaching gap (humanized). Chain to
   touch: the queries file, the API route/hook feeding BotAnalyticsSection,
   the section component, types.

## Constraints

Cost: ≤1 judge call/session lifetime; abandoned/short/keyless = zero LLM
tokens; judged input capped at 20 turns; judge tokens recorded in
`judge_tokens`, never charged to the session chat budget. Rough order: a
20-turn judged session ≈ 1.5-3k input tokens on the org's configured model —
recorded, so real cost is measurable in insights later.
Tests: pure vitest for score-session (mock db/judge: flags-only paths, judged
path, all four skip reasons, empty messages, truncation sentinel, idempotent
conflict, judge-throw degrade); sweep query test; deleteConversation cascade
assertion. Suite baseline holds. page-conversations + page-insights-ai
skills updated in the same commits (verify-skills gate). Copy canon
throughout; "QA" acceptable as acronym.

## Out of scope

Historical backfill beyond the 7-day sweep window; human QA override UI;
per-technician coaching rollups; Avoca phases B/E/F; judge-cost billing
surfaces.
