/**
 * Intake triage — the "smart questions" layer.
 *
 * A pure, deterministic state function that, given what we already know about a
 * conversation, decides the SINGLE next question to ask. It encodes a
 * best-in-class HVAC intake order (researched against ServiceTitan + others):
 *
 *   1. Safety screen FIRST — confirm no active gas/CO/burning/flooding hazard
 *      before booking anything. A hazard short-circuits to escalation.
 *
 * IMPORTANT (where safety is actually enforced in production): the chat and
 * voice routes pass `safetyScreenPassed: true` into this engine, because the
 * authoritative safety gate is the deterministic INTENT ROUTER's emergency
 * detection (knowledge-base.ts emergency intents + escalateSession) — it fires
 * on ANY turn a hazard is mentioned, not just when this screen is asked, and is
 * what the system prompt reinforces. The `safety_screen` step here is therefore
 * a self-contained backstop for callers that DON'T have the router in front of
 * them (and keeps the engine correct in isolation/tests). If you wire a caller
 * without the emergency router, pass the real screen state instead of `true`.
 *   2. ServiceTitan "Step 3" qualifying questions — is the system fully down or
 *      partly working, and how long has it been happening. These disambiguate
 *      urgency far better than guessing.
 *   3. Required dispatch fields — service address, then phone (the dispatch
 *      primary key).
 *   4. Comprehensive enrichment (optional, skippable) — system type, equipment
 *      age/brand, property type, owner/renter, warranty, access notes, vulnerable
 *      occupants, preferred window, contact preference, lead source.
 *
 * Every question carries quick-reply chips so the common path is 0-token. The
 * caller (chat/voice route) renders the question, then feeds the customer's
 * answer back through `applyTriageAnswer`. Optional steps accept "skip"/"I don't
 * know" and are never re-asked. No I/O — fully unit-tested.
 */
export interface QuickReply {
  readonly label: string;
  readonly value: string;
}

export interface TriageStep {
  /** Stable id for the question (also the slot it fills). */
  readonly id: string;
  /** The question to ask the customer. */
  readonly question: string;
  /** Quick-reply chips (may be empty for free-text answers). */
  readonly quickReplies: readonly QuickReply[];
  /** True for enrichment questions the customer may skip. */
  readonly optional: boolean;
}

// Slots the triage engine reasons over. `extras` mirrors chat-slots' extras bag.
export interface TriageSlots {
  issueType: string | null;
  urgency: string | null;
  address: string | null;
  // The customer's full name (first + last). A CORE field like address/phone:
  // written by the caller's slot extraction, gated here only to sequence the
  // NAME_STEP question. Not an extras key.
  name: string | null;
  phone: string | null;
  // The customer's email. A CORE required field (booking confirmation channel),
  // written by the caller's slot extraction; gated here only to sequence the
  // EMAIL_STEP question. Not an extras key.
  email: string | null;
  safetyScreenPassed: boolean;
  safetyHazardReported?: boolean;
  extras: Record<string, unknown>;
  // Optional enrichment steps the customer explicitly skipped (so we don't
  // re-ask them). Keyed by step id.
  skipped?: Record<string, true>;
}

// The hard gate: a request cannot be submitted until these are satisfied.
export const REQUIRED_FOR_SUBMIT = [
  "safetyScreenPassed",
  "issueType",
  "urgency",
  "address",
  "name",
  "phone",
  "email",
] as const;

// Core fields a "skip" must NEVER satisfy — the engine re-asks until they carry a
// real value. The slot gates in nextTriageStep already key on the slot value, so
// a "skip" answer (which writes nothing to these top-level slots) naturally
// re-asks. Exported for the route, which uses it to refuse a skip on core fields.
export const UNSKIPPABLE_CORE = [
  "issueType",
  "address",
  "name",
  "email",
  "phone",
] as const;

/**
 * Local mirror of extraction-schema.isAddressComplete: a COMPLETE service
 * address has >=4 whitespace tokens, the first token starts with a digit
 * (street number), and it contains a 5-digit ZIP. Duplicated here (not imported)
 * so the pure triage engine has no dependency on the extraction schema.
 */
function addressLooksComplete(address: string | null | undefined): boolean {
  if (!address) return false;
  const trimmed = address.trim();
  if (trimmed.length === 0) return false;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 4) return false;
  if (!/^\d/.test(tokens[0])) return false;
  if (!/\b\d{5}\b/.test(trimmed)) return false;
  return true;
}

const SKIP_PATTERNS = [
  "skip",
  "i don't know",
  "i dont know",
  "don't know",
  "dont know",
  "not sure",
  "no idea",
  "unsure",
  "n/a",
  "na",
  "pass",
];

/** True when the customer's answer means "skip / I don't know" for an optional field. */
export function isSkip(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return SKIP_PATTERNS.includes(a);
}

const YES_PATTERNS = ["yes", "y", "yeah", "yep", "yup", "correct", "i do", "there is"];
const NO_PATTERNS = ["no", "n", "nope", "none", "no smell", "all clear", "everything's fine", "im fine", "i'm fine"];

function isYes(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return YES_PATTERNS.some((p) => a === p || a.startsWith(p + " "));
}
function isNo(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return NO_PATTERNS.some((p) => a === p || a.startsWith(p + " "));
}

// ── Step definitions ──

const SAFETY_STEP: TriageStep = {
  id: "safety_screen",
  question:
    "First, a quick safety check: do you smell gas, smell something burning, hear a carbon monoxide alarm, or have water actively flooding? (If none of these, just say \"no\".)",
  quickReplies: [
    { label: "No — all clear", value: "no" },
    { label: "Yes — one of these", value: "yes" },
  ],
  optional: false,
};

const SYSTEM_DOWN_STEP: TriageStep = {
  id: "system_down",
  question: "Is the system completely down, or is it still partly working?",
  quickReplies: [
    { label: "Completely down", value: "fully_down" },
    { label: "Partly working", value: "partially_working" },
    { label: "Not sure", value: "unknown" },
  ],
  optional: false,
};

const DURATION_STEP: TriageStep = {
  id: "duration",
  question: "How long has this been happening?",
  quickReplies: [
    { label: "Just started today", value: "today" },
    { label: "A few days", value: "a few days" },
    { label: "A week or more", value: "a week or more" },
  ],
  optional: false,
};

const ADDRESS_STEP: TriageStep = {
  id: "address",
  question: "What's the service address where you'd like the technician to come?",
  quickReplies: [],
  optional: false,
};

// Asked ONCE when an address is present but not yet complete (no comma and fails
// the strict check) — captures the missing city/ZIP. The route appends the answer
// as ", <answer>", which adds a comma, so this step never re-fires afterward.
const ADDRESS_PARTS_STEP: TriageStep = {
  id: "address_parts",
  question: "Thanks. What city and ZIP code is that in?",
  quickReplies: [],
  optional: false,
};

const PHONE_STEP: TriageStep = {
  id: "phone",
  question: "What's the best phone number to reach you to confirm the visit?",
  quickReplies: [],
  optional: false,
};

const NAME_STEP: TriageStep = {
  id: "name",
  question: "And what's your full name — first and last?",
  quickReplies: [],
  optional: false,
};

const EMAIL_STEP: TriageStep = {
  id: "email",
  question: "What's the best email address for your booking confirmation?",
  quickReplies: [],
  optional: false,
};

const URGENCY_STEP: TriageStep = {
  id: "urgency",
  question: "How urgent is this — an emergency, or can it wait a little while?",
  quickReplies: [
    { label: "Emergency", value: "emergency" },
    { label: "Soon (today)", value: "high" },
    { label: "This week", value: "medium" },
    { label: "Routine", value: "low" },
  ],
  optional: false,
};

// Optional enrichment steps, asked in order, each skippable.
const SYSTEM_TYPE_STEP: TriageStep = {
  id: "system_type",
  question: "What kind of system is it? (You can skip if unsure.)",
  quickReplies: [
    { label: "Central AC", value: "central_ac" },
    { label: "Furnace", value: "furnace" },
    { label: "Heat pump", value: "heat_pump" },
    { label: "Mini-split", value: "mini_split" },
    { label: "Boiler", value: "boiler" },
    { label: "Skip", value: "skip" },
  ],
  optional: true,
};

const EQUIPMENT_AGE_STEP: TriageStep = {
  id: "equipment_age",
  question: "Roughly how old is the system?",
  quickReplies: [
    { label: "Under 5 yrs", value: "under_5" },
    { label: "5–10 yrs", value: "5_to_10" },
    { label: "10–15 yrs", value: "10_to_15" },
    { label: "15+ yrs", value: "over_15" },
    { label: "Not sure", value: "skip" },
  ],
  optional: true,
};

const EQUIPMENT_BRAND_STEP: TriageStep = {
  id: "equipment_brand",
  question: "Do you know the brand? (e.g. Trane, Lennox, Goodman — or skip.)",
  quickReplies: [{ label: "Skip", value: "skip" }],
  optional: true,
};

const PROPERTY_TYPE_STEP: TriageStep = {
  id: "property_type",
  question: "Is this a home or a commercial property?",
  quickReplies: [
    { label: "Home", value: "residential" },
    { label: "Commercial", value: "commercial" },
    { label: "Skip", value: "skip" },
  ],
  optional: true,
};

const OWNER_STEP: TriageStep = {
  id: "owner_occupant",
  question: "Do you own the property, or are you renting?",
  quickReplies: [
    { label: "Own", value: "owner" },
    { label: "Rent", value: "renter" },
    { label: "Skip", value: "skip" },
  ],
  optional: true,
};

const WARRANTY_STEP: TriageStep = {
  id: "under_warranty",
  question: "Is the system still under warranty, do you know?",
  quickReplies: [
    { label: "Yes", value: "yes" },
    { label: "No", value: "no" },
    { label: "Not sure", value: "unknown" },
  ],
  optional: true,
};

const ACCESS_STEP: TriageStep = {
  id: "access_notes",
  question:
    "Anything the technician should know to get to the unit — gate code, pets, parking, or where it's located (attic, roof, basement)? (Or skip.)",
  quickReplies: [{ label: "Nothing special", value: "none" }, { label: "Skip", value: "skip" }],
  optional: true,
};

const VULNERABLE_STEP: TriageStep = {
  id: "vulnerable_occupants",
  question:
    "Is anyone in the home elderly, an infant, or with a medical condition? (This helps us prioritize.)",
  quickReplies: [
    { label: "Yes", value: "yes" },
    { label: "No", value: "no" },
    { label: "Skip", value: "skip" },
  ],
  optional: true,
};

const WINDOW_STEP: TriageStep = {
  id: "preferred_window",
  question: "When works best for a visit? (We'll confirm the exact time.)",
  quickReplies: [
    { label: "Morning", value: "morning" },
    { label: "Afternoon", value: "afternoon" },
    { label: "Evening", value: "evening" },
    { label: "ASAP", value: "asap" },
  ],
  optional: true,
};

const CONTACT_PREF_STEP: TriageStep = {
  id: "contact_preference",
  question: "Would you prefer we call or text you?",
  quickReplies: [
    { label: "Call", value: "call" },
    { label: "Text", value: "text" },
    { label: "Skip", value: "skip" },
  ],
  optional: true,
};

const LEAD_SOURCE_STEP: TriageStep = {
  id: "lead_source",
  question: "Last one — how did you hear about us?",
  quickReplies: [
    { label: "Google", value: "google" },
    { label: "Referral", value: "referral" },
    { label: "Used before", value: "repeat_customer" },
    { label: "Social", value: "facebook" },
    { label: "Skip", value: "skip" },
  ],
  optional: true,
};

// Map each step id to the extras key it fills (core steps fill top-level slots).
const STEP_TO_EXTRA: Record<string, string> = {
  system_down: "systemDownStatus",
  duration: "problemDuration",
  system_type: "systemType",
  equipment_age: "equipmentAgeBand",
  equipment_brand: "equipmentBrand",
  property_type: "propertyType",
  owner_occupant: "ownerOccupant",
  under_warranty: "underWarranty",
  access_notes: "accessNotes",
  vulnerable_occupants: "vulnerableOccupants",
  preferred_window: "preferredWindow",
  contact_preference: "contactPreference",
  lead_source: "leadSource",
};

// Ordered list of OPTIONAL enrichment steps the engine WILL ask after core info
// is captured. Deliberately capped to just two so intake ends quickly: ask
// system type, then a preferred window, then return null so the route surfaces
// "Complete & Submit". Keeping this short is the fix for the never-ending intake.
const ENRICHMENT_ORDER: readonly TriageStep[] = [SYSTEM_TYPE_STEP, WINDOW_STEP];

// Service lines whose equipment is NOT described by the forced-air HVAC
// system-type taxonomy (central_ac / furnace / heat pump / mini-split / boiler).
// Asking "What kind of system is it?" for a walk-in cooler, ice machine, or
// commercial oven/range is nonsensical and produces a misleading answer — e.g. a
// downed commercial range getting stored as systemType "furnace". For these the
// system_type enrichment step is skipped entirely.
const SYSTEM_TYPE_NOT_APPLICABLE: ReadonlySet<string> = new Set([
  "refrigeration",
  "ice_machine",
  "commercial_appliance",
]);

/**
 * Whether an enrichment step is relevant to the given issue type. Only the
 * system_type step is conditional today: it's suppressed for the non-HVAC-system
 * service lines (see SYSTEM_TYPE_NOT_APPLICABLE). Every other step always
 * applies. A null issue type (not yet classified) leaves the step applicable so
 * we never prematurely suppress it.
 */
function enrichmentStepApplies(
  stepId: string,
  issueType: string | null,
): boolean {
  if (stepId === SYSTEM_TYPE_STEP.id && issueType !== null) {
    return !SYSTEM_TYPE_NOT_APPLICABLE.has(issueType);
  }
  return true;
}

// Enrichment steps the engine NEVER proactively asks (documentation only —
// nextTriageStep does NOT iterate this list). If the customer VOLUNTEERS one of
// these (e.g. mentions a business name → propertyType=commercial), the caller's
// extraction still captures it into extras; it just isn't a question we block on.
export const ENRICHMENT_NEVER_BLOCKS: readonly TriageStep[] = [
  EQUIPMENT_AGE_STEP,
  EQUIPMENT_BRAND_STEP,
  PROPERTY_TYPE_STEP,
  OWNER_STEP,
  WARRANTY_STEP,
  ACCESS_STEP,
  VULNERABLE_STEP,
  CONTACT_PREF_STEP,
  LEAD_SOURCE_STEP,
];

function extraFilledOrSkipped(slots: TriageSlots, step: TriageStep): boolean {
  const extraKey = STEP_TO_EXTRA[step.id];
  const filled =
    extraKey !== undefined &&
    slots.extras[extraKey] !== undefined &&
    slots.extras[extraKey] !== null &&
    slots.extras[extraKey] !== "";
  const skipped = Boolean(slots.skipped?.[step.id]);
  return filled || skipped;
}

// Sentinel stored in an extras slot when the customer skipped an optional step,
// so it is treated as resolved (not re-asked) and survives a session reload via
// the metadata round-trip. extraFilledOrSkipped + the schema's optional fields
// tolerate it; it's never rendered (the admin UI maps unknown enum → label, and
// free-text fields show it rarely — callers strip it before display if needed).
export const SKIP_SENTINEL = "__skipped__";

// Reverse lookup: the set of valid enum values for steps backed by an enum
// (used to capture a bare quick-reply answer deterministically, with no LLM
// call). Includes the qualifying-question steps so a tapped chip advances them.
const ENUM_STEP_VALUES: Record<string, readonly string[]> = {
  system_down: ["fully_down", "partially_working", "unknown"],
  system_type: ["central_ac", "furnace", "heat_pump", "mini_split", "boiler", "packaged_unit", "other"],
  equipment_age: ["under_5", "5_to_10", "10_to_15", "over_15"],
  property_type: ["residential", "commercial"],
  owner_occupant: ["owner", "renter"],
  preferred_window: ["morning", "afternoon", "evening", "asap"],
  contact_preference: ["call", "text"],
  lead_source: ["google", "facebook", "yelp", "referral", "repeat_customer", "website", "direct_mail", "other"],
};

// Fuzzy synonym map for enum steps: natural phrasings → the canonical enum
// value. Keyed by step id, then by target enum value, listing the lowercase
// substrings/phrases that map to it. Applied ONLY when the raw answer isn't
// already a valid enum value (so exact chips and skips are untouched). Kept
// conservative — substring containment, longest matching phrase wins so a more
// specific phrase ("completely dead") beats a looser one ("dead"). Other enum
// steps can register their own synonyms here later.
const ENUM_SYNONYMS: Record<string, Record<string, readonly string[]>> = {
  system_down: {
    fully_down: [
      "completely dead",
      "totally dead",
      "not working at all",
      "won't turn on",
      "wont turn on",
      "nothing happens",
      "no power",
      "dead",
      "down",
    ],
    partially_working: [
      "kind of working",
      "still kind of runs",
      "blows but warm",
      "sort of",
      "still runs",
      "partly",
      "weak",
      "barely",
    ],
  },
};

/**
 * Map a natural-language answer to an enum value via the step's synonym map.
 * Matches by substring containment, preferring the LONGEST phrase so a specific
 * phrase wins over a looser one. Returns null when no synonym matches (caller
 * then falls back to the LLM for required steps / sentinel for optional).
 */
function fuzzyEnumMatch(stepId: string, answer: string): string | null {
  const synonyms = ENUM_SYNONYMS[stepId];
  if (!synonyms) return null;
  let best: { value: string; length: number } | null = null;
  for (const [value, phrases] of Object.entries(synonyms)) {
    for (const phrase of phrases) {
      if (answer.includes(phrase) && (best === null || phrase.length > best.length)) {
        best = { value, length: phrase.length };
      }
    }
  }
  return best?.value ?? null;
}

// Steps whose answer is free text (no enum) — any non-empty answer fills them.
const FREE_TEXT_STEPS = new Set(["duration", "equipment_brand", "access_notes"]);

const MAX_FREE_TEXT = 1000;

/**
 * Map the customer's answer to the step we just asked into an extras
 * {key,value} to persist — keeping the common path 0-token. Handles enum chips,
 * free-text steps, the yes/no/unknown steps, and "skip / I don't know" on an
 * optional step (recorded via a sentinel so it isn't re-asked). Returns null
 * only when an answer to a REQUIRED step is unrecognized, so the caller can let
 * the LLM interpret it. `pendingStepId` is the step the customer was just asked.
 */
export function captureEnrichmentAnswer(
  pendingStepId: string | null,
  answer: string,
): { key: string; value: string | boolean } | null {
  if (!pendingStepId) return null;
  const extraKey = STEP_TO_EXTRA[pendingStepId];
  if (!extraKey) return null;
  const trimmed = answer.trim();
  const a = trimmed.toLowerCase();

  // Skip / don't-know on an optional step → record the sentinel so we don't
  // re-ask it. (Required steps — system_down, duration — are not skippable.)
  const optionalStep = pendingStepId !== "system_down" && pendingStepId !== "duration";
  if (optionalStep && isSkip(a)) {
    return { key: extraKey, value: SKIP_SENTINEL };
  }

  if (pendingStepId === "vulnerable_occupants") {
    if (isYes(a)) return { key: extraKey, value: true };
    if (isNo(a)) return { key: extraKey, value: false };
    return null;
  }
  if (pendingStepId === "under_warranty") {
    if (a === "yes" || a === "no" || a === "unknown") return { key: extraKey, value: a };
    return null;
  }

  // Free-text steps: accept any non-empty answer (length-capped).
  if (FREE_TEXT_STEPS.has(pendingStepId)) {
    return trimmed.length > 0
      ? { key: extraKey, value: trimmed.slice(0, MAX_FREE_TEXT) }
      : null;
  }

  const allowed = ENUM_STEP_VALUES[pendingStepId];
  if (allowed && allowed.includes(a)) {
    return { key: extraKey, value: a };
  }

  // Fuzzy fallback: only AFTER the exact-enum check has failed, try to map a
  // natural phrasing onto a canonical enum value (e.g. "my system is dead" →
  // fully_down). Conservative substring match; never overrides an exact value.
  if (allowed) {
    const fuzzy = fuzzyEnumMatch(pendingStepId, a);
    if (fuzzy && allowed.includes(fuzzy)) {
      return { key: extraKey, value: fuzzy };
    }
  }

  return null;
}

/**
 * Decide the single next question to ask, or null when the conversation has
 * everything it needs (required filled, enrichment answered-or-skipped).
 */
export function nextTriageStep(slots: TriageSlots): TriageStep | null {
  // 1. Safety screen — always first, before any booking detail.
  if (!slots.safetyScreenPassed && !slots.safetyHazardReported) {
    return SAFETY_STEP;
  }
  // If a hazard was reported the caller escalates; triage stops asking.
  if (slots.safetyHazardReported) return null;

  // 2. ServiceTitan qualifying questions (down status, then duration).
  if (!extraFilledOrSkipped(slots, SYSTEM_DOWN_STEP)) return SYSTEM_DOWN_STEP;
  if (!extraFilledOrSkipped(slots, DURATION_STEP)) return DURATION_STEP;

  // 3. Required dispatch fields.
  if (!slots.address) return ADDRESS_STEP;
  // Address present but not complete (no comma AND fails the strict check): ask
  // ONE city/ZIP follow-up. We infer "already asked parts" from the address
  // shape — once it contains a comma (the route appends ", <answer>") or looks
  // complete, we don't re-ask. No new persisted flag needed.
  if (!addressLooksComplete(slots.address) && !slots.address.includes(",")) {
    return ADDRESS_PARTS_STEP;
  }
  if (!slots.phone) return PHONE_STEP;
  if (!slots.name) return NAME_STEP;
  if (!slots.email) return EMAIL_STEP;
  if (!slots.urgency) return URGENCY_STEP;

  // 4. Optional enrichment, in order; skip any already filled or skipped, and
  // any step that doesn't apply to this issue type (e.g. system_type for a
  // commercial appliance / refrigeration / ice machine).
  for (const step of ENRICHMENT_ORDER) {
    if (!enrichmentStepApplies(step.id, slots.issueType)) continue;
    if (!extraFilledOrSkipped(slots, step)) return step;
  }

  return null;
}

/**
 * Fold a customer's answer to `step` back into the triage slots. Optional steps
 * accept skip / I-don't-know (recorded so they're not re-asked). The safety
 * screen sets safetyScreenPassed / safetyHazardReported.
 */
export function applyTriageAnswer(
  slots: TriageSlots,
  step: TriageStep,
  answer: string,
): TriageSlots {
  const next: TriageSlots = {
    ...slots,
    extras: { ...slots.extras },
    skipped: { ...(slots.skipped ?? {}) },
  };

  // Address city/ZIP follow-up: append the answer to the existing street so the
  // address becomes "<street>, <city ZIP>". The added comma makes the address
  // satisfy the "already asked parts" check, so it is never re-asked.
  if (step.id === "address_parts") {
    const street = (next.address ?? "").trim();
    const part = answer.trim();
    if (street && part) {
      next.address = `${street}, ${part}`.slice(0, MAX_FREE_TEXT);
    }
    return next;
  }

  if (step.id === "safety_screen") {
    if (isYes(answer)) {
      next.safetyHazardReported = true;
      next.safetyScreenPassed = false;
    } else if (isNo(answer)) {
      next.safetyScreenPassed = true;
    } else {
      // Ambiguous → treat as not-yet-cleared; caller may fall back to the LLM.
      next.safetyScreenPassed = false;
    }
    return next;
  }

  // Optional step skipped → record so we don't re-ask.
  if (step.optional && isSkip(answer)) {
    next.skipped![step.id] = true;
    return next;
  }

  // Core triage signals + enrichment write into extras.
  const extraKey = STEP_TO_EXTRA[step.id];
  if (extraKey) {
    if (step.id === "vulnerable_occupants") {
      next.extras[extraKey] = isYes(answer) ? true : isNo(answer) ? false : null;
      if (next.extras[extraKey] === null) delete next.extras[extraKey];
    } else if (isSkip(answer)) {
      if (step.optional) next.skipped![step.id] = true;
    } else {
      next.extras[extraKey] = answer.trim();
    }
    return next;
  }

  // Core dispatch fields (address/phone/name/urgency) are written by the caller
  // via the existing slot extraction; triage just sequenced the question.
  return next;
}
