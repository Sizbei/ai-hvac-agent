# Chat Intake Overhaul — "much better" HVAC intake

Date: 2026-06-08
Status: Approved (proceeding to implementation)

## Goal

Make the customer chat (and phone) intake best-in-class for HVAC dispatch:
run a **safety screen first**, ask **smart triage questions**, and capture the
**comprehensive field set** a dispatcher needs to send the right tech, prepared,
in one visit — while keeping completion high and preserving the deterministic-
first / cost-aware architecture. Grounded in competitor research
(ServiceTitan/Housecall Pro/Jobber/Thumbtack + HVAC AI receptionists).

## ServiceTitan model adopted (deep research)

We mirror as much of ServiceTitan's data model as makes sense without a
billing/routing/marketing backend. Key adopted concepts:

- **Customer (payer) / Location (site) / Job (work) split — "soft split".** We do
  NOT add a separate `locations` table yet (95%+ of chats are residential where
  billing == service address). Instead: the customer row is the financially-
  responsible identity; the **service address lives on the service_request** (=
  the location). Documented upgrade path: promote to a real `locations` table if
  commercial/property-management becomes a segment.
- **Job type vs symptom.** Keep `issueType` as the customer-language symptom; add
  a **`jobType`** enum that classifies the work using ST's HVAC taxonomy:
  `service_call`, `no_heat`, `no_cool`, `maintenance`, `install`, `estimate`,
  `warranty`, `diagnostic`, `inspection`.
- **Customer class + flags.** `customers.type` (`residential`/`commercial`),
  `customers.membershipStatus` (`none`/`active`/`suspended`/`expired`/`cancelled`),
  `customers.doNotService` (bot refuses to book / warns).
- **Arrival window, not exact time.** Requests get `arrivalWindowStart` /
  `arrivalWindowEnd` (ST never books an exact time). The chat captures a
  preferred window (Morning/Afternoon/Evening/ASAP) which maps to a window.
- **SMS consent per booking** (`smsConsent` on the request) — consent is per-
  interaction in ST, and arrival-window texts need a mobile.
- **Lead source** (`leadSource` enum on the request): `google`, `facebook`,
  `yelp`, `referral`, `repeat_customer`, `website`, `direct_mail`, `other` —
  the one marketing field an owner actually reads; asked conversation-only.
- **Tags** (small enum + join, seeded): `do_not_service`, `gate_code`, `dog`,
  `member`, `follow_up`, `replacement_opp`, `high_value`. `gate_code`/`dog`/
  `do_not_service` are the load-bearing ones (access + safety + refuse-to-book).
- **Equipment**: split labor warranty from parts (`laborWarrantyExpiration`),
  and link equipment to the request (request↔equipment).
- **ST Step-3 qualifying questions** (duration / system age / # units / severity)
  added to triage — ST's biggest accuracy lever, zero schema.

Skipped (no backend): Business Unit, account balance/billing, DNI call tracking,
custom fields, preferred technician, lifetime revenue.

Sources: ServiceTitan CRM/Job/Equipment API docs, Web Scheduler + CSR call
scripts, tagging guide, memberships FAQ, lead-attribution docs (see
docs/INTAKE-FIELDS.md for the full citation list).

## Field model (tiered)

**Required — blocks submission (5):**
- Safety screen acknowledged/cleared (no active gas/CO/fire/flooding hazard, or
  escalated if present)
- `issueType` (existing symptom) → also classified into `jobType` (ST taxonomy)
- `urgency` (existing; ST priority maps low/medium/high/emergency)
- `address` (existing — the ST "location")
- `customerPhone` (NEW required — the dispatch primary key; today optional)

**Best-effort — asked smartly, skippable ("I don't know"/"skip"):**
- `systemType` (central AC / furnace / heat pump / mini-split / boiler / packaged / other)
- `equipmentAgeYears` (bucketed: <5, 5–10, 10–15, 15+, unknown) — drives repair-vs-replace
- `equipmentBrand` (free text)
- `propertyType` (residential / commercial)
- `ownerOccupant` (owner / renter — payment authority)
- `underWarranty` (yes / no / unknown)
- `accessNotes` (gate code, pets, parking, unit location: attic/crawlspace/roof)
- `preferredWindow` (morning / afternoon / evening / ASAP-emergency)
- `contactPreference` (call / text)
- `customerName`, `customerEmail` (existing optional)
- `systemDownStatus` (fully down / partially working) — triage signal
- `problemDurationText` (free text: "since this morning", "a few days") — triage signal
- `vulnerableOccupants` (boolean — elderly/infant/medical; bumps urgency)

## Smart triage (deterministic-first)

A new deterministic **triage layer** sits in front of the existing router on the
intake path. It contributes, in priority order:

1. **Safety screen** — before booking anything, the bot confirms no active
   gas/CO/burning/flooding. A YES → existing emergency escalation (now with an
   immediate address/phone capture; see Bug 1). This reuses the emergency
   intents already in the knowledge base; the screen just guarantees the
   question is asked rather than waiting for the customer to volunteer it.
2. **System-down + duration** — "Is it completely down or still partly working?"
   and "How long has this been happening?" These set `systemDownStatus` /
   `problemDurationText` and feed urgency (fully-down + extreme temp → high/
   emergency).
3. **Vulnerable occupants** — asked when urgency is borderline; YES bumps a tier.
4. **De-escalation self-checks** — for "no power"/"no heat"/"thermostat blank",
   offer the quick thermostat-battery/breaker/filter check (new low-harm KB
   intents) to avoid a wasted truck roll.

Triage questions are emitted as canned prompts with **quick-reply chips**
(0-token where possible); novel/ambiguous answers fall back to the LLM. The
LLM system prompt is upgraded with the full triage playbook for the fallback
path so phrasing stays smart there too.

## Question order (skippable extras gated so we never nag)

1. Greeting + issue description → classify `issueType`
2. Safety screen (if any hazard signal or always-once) → escalate or continue
3. System-down status + duration (triage)
4. Service address  → 5. Phone (required)  → name/email (optional, one ask)
5. System type → equipment age/brand → property type/owner → warranty (each a
   single quick ask; "skip"/"don't know" advances)
6. Access notes + preferred window + contact preference
7. Confirmation summary → submit

The bot **never re-asks a filled slot** and accepts "skip"/"I don't know" for any
best-effort field. Once the 5 required are present, the customer can submit at
any point even if best-effort fields are blank.

## Persistence (schema + admin)

New nullable columns (migration 0010, hand-authored per the project's
drizzle-kit-collision pattern).

On `service_requests`: `job_type` (enum), `system_type`, `equipment_age_band`,
`equipment_brand`, `property_type`, `owner_occupant`, `under_warranty`,
`access_notes`, `arrival_window_start`, `arrival_window_end`, `preferred_window`,
`contact_preference`, `sms_consent`, `lead_source` (enum), `system_down_status`,
`problem_duration`, `vulnerable_occupants`.

On `customers`: `type` (residential/commercial), `membership_status` (enum),
`do_not_service` (bool). On `customer_equipment`: `labor_warranty_expiration`.
New enums: `job_type`, `customer_type`, `membership_status`, `lead_source`,
`system_type`, `property_type`. (Equipment make/brand mirrored into
`customer_equipment` on submit when present, linked to the request.)

The admin **request detail** view renders these in a new "Intake details" /
"Equipment & property" section. Conversation extraction metadata carries the
new slots so the confirm endpoint can persist them.

## Bug fixes (found in audit)

- **Bug 1 — emergency escalation address loss.** On an ESCALATE verdict, if
  address/phone are missing, the bot now asks for them as part of the escalation
  message and persists them, so a dispatcher has the location for an emergency.
- **Bug 2 — re-ask risk.** Broaden `extractSlots` (street-only addresses) and
  ensure a bare address/contact turn fills the slot deterministically rather
  than falling to the LLM that re-asks.

## Architecture fit

- Triage is a pure module (`src/lib/ai/triage.ts`) returning the next question +
  slot updates; unit-tested without I/O — same shape as the existing router.
- Slot schema extended in `extraction-schema.ts` + `chat-slots.ts`; required-set
  logic adds phone + safety to `isExtractionComplete`.
- Both `/api/chat` and the voice path (`voice-turn.ts`) consume the same triage,
  so phone gets the same smart flow (voice persona phrasing).
- Knowledge base gains de-escalation self-check intents + quick-reply metadata.

## Docs

Update README (Highlights: comprehensive smart intake + safety triage),
GUIDE (customer flow + field list + admin), ARCHITECTURE (triage layer + new
columns), docs/KNOWLEDGE-BASE-CATALOG (new intents), and a new
`docs/INTAKE-FIELDS.md` documenting the field model + triage playbook with
research citations.

## Testing (TDD, 80%+)

Unit: triage decision logic, safety-screen gating, urgency bumping, skip/
don't-know handling, extended slot extraction, isExtractionComplete with phone,
de-escalation intents. Integration: confirm endpoint persists new columns;
admin request detail renders them. All existing tests stay green.

## Verification

After implementation, fan out review subagents (code-reviewer + a
research-vs-implementation auditor + security-reviewer for the new input
surface) to sign off before final commit.

## Out of scope
- Real calendar/availability booking (no backend); we capture a preferred window only.
- Phone-based existing-customer auto-lookup at intake (dedupe already happens at submit).
- Photo/error-code upload.
