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

## Field model (tiered)

**Required — blocks submission (5):**
- Safety screen acknowledged/cleared (no active gas/CO/fire/flooding hazard, or
  escalated if present)
- `issueType` (existing)
- `urgency` (existing)
- `address` (existing)
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

New nullable columns on `service_requests` (migration 0010, hand-authored per
the project's drizzle-kit-collision pattern):
`system_type`, `equipment_age_band`, `equipment_brand`, `property_type`,
`owner_occupant`, `under_warranty`, `access_notes`, `preferred_window`,
`contact_preference`, `system_down_status`, `problem_duration`,
`vulnerable_occupants`. (Equipment make/brand also mirrored into
`customer_equipment` on submit when present.)

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
