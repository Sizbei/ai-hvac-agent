# Intake Fields & Triage Playbook

How the chat/voice agent runs a best-in-class HVAC intake: what it asks, in what
order, why, and what it stores. The design mirrors ServiceTitan's
Customer/Location/Job model and CSR call-script ordering, adapted to a
deterministic-first, cost-aware agent.

> Source of truth for field definitions: `src/lib/ai/extraction-schema.ts`
> (slots) and `src/lib/db/schema.ts` (columns). The question order lives in
> `src/lib/ai/triage.ts`.

## Field model (tiered)

The intake is **tiered** so completion stays high: only a small core blocks
submission; everything else is asked smartly but is skippable ("skip" / "I don't
know" advances and is never re-asked).

### Required — blocks submission

| Field | Notes |
|---|---|
| Safety screen cleared | No active gas/CO/burning/flooding hazard (a hazard escalates instead) |
| `issueType` | Customer-language symptom (also classified into `jobType`) |
| `urgency` | `low` / `medium` / `high` / `emergency` |
| `address` | The service location |
| `customerPhone` | The dispatch primary key — a dispatcher must be able to reach the customer |

### Best-effort — asked smartly, skippable

| Field | Enum / type | Why it matters (ServiceTitan analog) |
|---|---|---|
| `systemDownStatus` | fully_down / partially_working / unknown | Primary triage signal; sets urgency |
| `problemDuration` | free text | Sudden total failure vs intermittent; sets urgency + tech skill |
| `systemType` | central_ac / furnace / heat_pump / mini_split / boiler / packaged_unit / other | Routing + parts prep |
| `equipmentAgeBand` | under_5 / 5_to_10 / 10_to_15 / over_15 / unknown | Repair-vs-replace routing |
| `equipmentBrand` | free text | Parts + tech prep |
| `propertyType` | residential / commercial | Routing, pricing, tech assignment |
| `ownerOccupant` | owner / renter / unknown | Payment authority (renters may need landlord ok) |
| `underWarranty` | yes / no / unknown | Billing + prioritization |
| `accessNotes` | free text | Gate code, pets, parking, unit location (attic/roof/basement) — first-visit success + tech safety |
| `vulnerableOccupants` | boolean | Elderly/infant/medical → bumps urgency a tier |
| `preferredWindow` | morning / afternoon / evening / asap | We capture intent; dispatch confirms the exact time |
| `contactPreference` | call / text | Confirmation/follow-up channel |
| `smsConsent` | boolean | Consent is per-booking; arrival-window texts need a mobile |
| `leadSource` | google / facebook / yelp / referral / repeat_customer / website / direct_mail / other | Marketing attribution — the one lead field owners read |
| `customerName`, `customerEmail` | free text | Optional contact detail |

### Derived

| Field | Notes |
|---|---|
| `jobType` | ServiceTitan work classification derived from `issueType` (`jobTypeForIssue`): no_heat, no_cool, maintenance, install, service_call, … |

### Customer-level (ServiceTitan customer record)

`customers.customerType` (residential/commercial), `customers.membershipStatus`
(none/active/suspended/expired/cancelled), `customers.doNotService`. Equipment
also gains `laborWarrantyExpiration` (ServiceTitan splits parts vs labor
warranty).

**Behavior wired today:**
- `doNotService` — the confirm endpoint refuses to book a flagged customer and
  routes them to call the office (`DO_NOT_SERVICE` response).
- `vulnerableOccupants` — at confirmation, a vulnerable household with a
  non-emergency issue is bumped one urgency tier (capped below "emergency").
- `membershipStatus` — **stored, not yet acted on.** Member-aware greeting /
  priority is a documented future step (the column + admin display exist; no
  intake behavior reads it yet).

## Triage playbook (question order)

The triage engine (`src/lib/ai/triage.ts`) emits ONE question at a time with
quick-reply chips, in this order, skipping anything already known:

1. **Safety screen first.** Before booking anything, confirm there's no active
   gas smell, burning/electrical smell, carbon-monoxide alarm/symptoms, or water
   flooding. A "yes" short-circuits to the existing emergency escalation (which
   also now captures the address/phone so a dispatcher isn't left blind).
2. **Qualifying questions** (ServiceTitan "Step 3"): is the system **completely
   down or partly working**, and **how long** has it been happening. These set
   urgency far better than guessing.
3. **Required dispatch fields:** service address → phone → urgency.
4. **Comprehensive enrichment** (each skippable): system type → equipment age →
   brand → property type → owner/renter → warranty → access notes → vulnerable
   occupants → preferred window → contact preference → lead source.

When everything required is filled and enrichment is answered-or-skipped, the
agent confirms and submits.

**Self-checks / de-escalation.** For "no power / nothing happens / thermostat
blank" the agent first offers safe basic checks (thermostat batteries, the
breaker, a clogged filter) to avoid a wasted truck roll — never anything that
involves opening the unit, wiring, gas, or refrigerant. See the
`selfcheck-*` intents in the knowledge base.

## Channel behavior

Both the web chat (`/api/chat`) and the phone agent (`/api/voice/*`) use the
SAME triage engine. Web renders quick-reply chips; voice asks the high-value
subset (safety via emergency escalation, system-down, duration, address, phone,
urgency, system type, preferred window) so a call doesn't drag, leaving the rest
for the technician to confirm on arrival.

## Where it shows up

Every captured field is persisted on the `service_requests` row at confirmation
and rendered in the admin **request detail** under "Intake Details", so dispatch
sees everything the customer told us.

## Research basis (ServiceTitan + others)

The field set and ordering are drawn from ServiceTitan's published model and CSR
call scripts, cross-checked against Housecall Pro, Jobber, Thumbtack, and HVAC AI
receptionists, plus authoritative gas/CO safety guidance:

- ServiceTitan Customer & Location records — https://help.servicetitan.com/v1/docs/customer-and-location-records-overview
- ServiceTitan CRM API (field shapes) — https://developer.servicetitan.io/docs/api-resources-crm/
- ServiceTitan Web Scheduler (homeowner flow) — https://help.servicetitan.com/v1/docs/set-web-scheduler-for-homeowners
- ServiceTitan HVAC call scripts — https://www.servicetitan.com/blog/hvac-call-scripts
- ServiceTitan job types — https://help.servicetitan.com/how-to/job-types
- ServiceTitan Equipment Systems API — https://developer.servicetitan.io/docs/api-resources-equipment-systems/
- ServiceTitan memberships FAQ — https://help.servicetitan.com/faq/memberships-faq
- ServiceTitan tagging guide — https://www.servicetitan.com/guides/contractor-playbook/tagging-tracking-jobs
- SoCalGas gas-leak / CO protocol — https://www.socalgas.com/safety/emergency-information/carbon-monoxide
- CDC/NIOSH carbon monoxide — https://www.cdc.gov/niosh/carbon-monoxide/about/index.html

## Deferred (documented, not built)

Hard Customer↔Location table split (we use a "soft split": billing identity on
the customer, service address on the request); real calendar/availability
booking; phone-based existing-customer auto-lookup at intake; tags join table;
DNI call-tracking / business units / billing. These need backends we don't have
yet; the schema is shaped to allow promoting them later.
