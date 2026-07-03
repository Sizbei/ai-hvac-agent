import { z } from 'zod';
import { addressLooksComplete, MAX_ADDRESS_REPROMPTS } from "./triage";

export const urgencyValues = ['low', 'medium', 'high', 'emergency'] as const;

export const issueTypeValues = [
  'heating_not_working',
  'cooling_not_working',
  'thermostat_issue',
  'air_quality',
  'strange_noises',
  'water_leak',
  'maintenance',
  'installation',
  // Spears service lines beyond forced-air HVAC. These are stored in the
  // `service_requests.issue_type` TEXT column (NOT a pg enum), so adding them
  // needs no DB migration — only this const + the Zod `z.enum(issueTypeValues)`
  // refs that derive from it. They all fall through `jobTypeForIssue`'s default
  // to the `service_call` jobType (a tech diagnoses on site), so the
  // `job_type` pg enum is untouched and likewise needs no migration.
  'refrigeration',
  'ice_machine',
  'boiler',
  'commercial_appliance',
  'other',
] as const;

// ── ServiceTitan-style intake enums (mirror src/lib/db/schema.ts) ──
export const jobTypeValues = [
  'service_call',
  'no_heat',
  'no_cool',
  'maintenance',
  'install',
  'estimate',
  'warranty',
  'diagnostic',
  'inspection',
] as const;
export const systemTypeValues = [
  'central_ac',
  'furnace',
  'heat_pump',
  'mini_split',
  'boiler',
  'packaged_unit',
  'other',
] as const;
export const equipmentAgeBandValues = [
  'under_5',
  '5_to_10',
  '10_to_15',
  'over_15',
  'unknown',
] as const;
export const propertyTypeValues = ['residential', 'commercial'] as const;
export const ownerOccupantValues = ['owner', 'renter', 'unknown'] as const;
export const triStateValues = ['yes', 'no', 'unknown'] as const;
export const systemDownStatusValues = [
  'fully_down',
  'partially_working',
  'unknown',
] as const;
export const preferredWindowValues = [
  'morning',
  'afternoon',
  'evening',
  'asap',
] as const;
export const contactPreferenceValues = ['call', 'text'] as const;
export const leadSourceValues = [
  'google',
  'facebook',
  'yelp',
  'referral',
  'repeat_customer',
  'website',
  'direct_mail',
  'other',
] as const;

export type JobType = (typeof jobTypeValues)[number];
export type IssueType = (typeof issueTypeValues)[number];

/**
 * Map the customer-language symptom (`issueType`) to ServiceTitan's work
 * classification (`jobType`). The symptom is what the customer says; the job
 * type is how dispatch books the truck. Returns null for a null symptom.
 */
export function jobTypeForIssue(issueType: IssueType | null): JobType | null {
  if (issueType === null) return null;
  switch (issueType) {
    case 'heating_not_working':
      return 'no_heat';
    case 'cooling_not_working':
      return 'no_cool';
    case 'maintenance':
      return 'maintenance';
    case 'installation':
      return 'install';
    // Symptoms that don't map to a dedicated ServiceTitan job type become a
    // general service call (the tech diagnoses on site). This includes the
    // Spears non-HVAC service lines (refrigeration, ice_machine, boiler,
    // commercial_appliance) — they intentionally reuse the existing
    // `service_call` jobType so the `job_type` pg enum needs no migration.
    default:
      return 'service_call';
  }
}

// The new intake fields are all OPTIONAL — they enrich the request but never
// block submission (the required gate is issue/urgency/address/phone).
// Free-text fields are length-capped here (the schema boundary) so the public
// confirm endpoint can't be made to persist unbounded strings — the chat
// guardrail's 2000-char cap only protects the chat path, not a direct POST.
const optionalIntakeFields = {
  systemType: z.enum(systemTypeValues).nullable().optional(),
  equipmentBrand: z.string().max(200).nullable().optional(),
  equipmentAgeBand: z.enum(equipmentAgeBandValues).nullable().optional(),
  propertyType: z.enum(propertyTypeValues).nullable().optional(),
  ownerOccupant: z.enum(ownerOccupantValues).nullable().optional(),
  underWarranty: z.enum(triStateValues).nullable().optional(),
  accessNotes: z.string().max(1000).nullable().optional(),
  systemDownStatus: z.enum(systemDownStatusValues).nullable().optional(),
  problemDuration: z.string().max(200).nullable().optional(),
  vulnerableOccupants: z.boolean().nullable().optional(),
  preferredWindow: z.enum(preferredWindowValues).nullable().optional(),
  contactPreference: z.enum(contactPreferenceValues).nullable().optional(),
  smsConsent: z.boolean().nullable().optional(),
  leadSource: z.enum(leadSourceValues).nullable().optional(),
};

// Schema for what the extraction model + router produce from the conversation.
export const extractionSchema = z.object({
  issueType: z.enum(issueTypeValues).nullable().describe('Type of HVAC issue the customer is experiencing'),
  urgency: z.enum(urgencyValues).nullable().describe('How urgent the issue is based on customer description'),
  address: z
    .string()
    .nullable()
    .describe(
      'Full service address provided by the customer — street number + street name, city, state, and 5-digit ZIP',
    ),
  // Kept as z.string().nullable() (not gated in the schema): completeness is
  // enforced via isNameComplete(), so the async extractor can still report a
  // partial name (e.g. just a first name) without a Zod throw.
  customerName: z
    .string()
    .nullable()
    .describe('Customer full name (first and last) if provided'),
  customerPhone: z.string().nullable().describe('Customer phone number if provided'),
  customerEmail: z.string().email().nullable().describe('Customer email if provided'),
  description: z.string().describe('Summary of the issue in 1-2 sentences'),
  isHvacRelated: z.boolean().describe('Whether the customer request is related to HVAC services'),
  ...optionalIntakeFields,
});

export type ExtractionResult = z.infer<typeof extractionSchema>;

// The fields that gate submission. Phone is required (the dispatch primary
// key — a dispatcher cannot act on a request with no way to reach the customer).
// Name is required too: dispatch needs a person to ask for at the door. Email is
// required as well: it's the channel for the booking confirmation / receipt.
export const REQUIRED_EXTRACTION_FIELDS = [
  'issueType',
  'urgency',
  'address',
  'customerPhone',
  'customerName',
  'customerEmail',
] as const;

// Sentinel a skipped optional step writes (see triage.SKIP_SENTINEL). A name
// that is purely this sentinel is not a real name and must not pass the gate.
const SKIP_SENTINEL = '__skipped__';

/**
 * True when `address` is a COMPLETE service address — one a tech can actually
 * drive to. A complete address needs a street number + street name + city +
 * state + ZIP. Heuristic (lenient but rejects partials like "5 Oak", "Oak St",
 * "downtown"): trimmed, at least 4 whitespace-separated tokens, the first token
 * starts with a digit (street number), AND it contains a 5-digit ZIP.
 */
// Rural/named-route street lines: the road's number follows its name.
const NAMED_ROUTE =
  /\b(?:county\s+(?:road|rd)|state\s+(?:route|highway|hwy|road|rd)|(?:us\s+)?highway|hwy|route|rte|farm\s+to\s+market|fm|cr|sr|rr)\s*#?\s*\d+\b/i;

export function isAddressComplete(address: string | null): boolean {
  if (address === null) return false;
  const trimmed = address.trim();
  if (trimmed.length === 0) return false;

  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 4) return false;

  // First token must start with a digit (the street number) — OR the line is a
  // named rural route ("County Road 120", "Highway 64", "FM 1325"), which is a
  // real dispatchable street line that carries its number after the road name.
  if (!/^\d/.test(tokens[0]) && !NAMED_ROUTE.test(trimmed)) return false;

  // Must contain a 5-digit ZIP somewhere (word-boundary so we don't match a
  // longer run of digits like a phone number).
  if (!/\b\d{5}\b/.test(trimmed)) return false;

  return true;
}

/**
 * True when `name` is a COMPLETE customer name — at least a first and last
 * name. Heuristic: trimmed, at least 2 whitespace-separated tokens each with
 * >= 1 character, and not purely the skip sentinel.
 */
export function isNameComplete(name: string | null): boolean {
  if (name === null) return false;
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === SKIP_SENTINEL) return false;

  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
  return tokens.length >= 2;
}

// Conservative email shape check: a single token with one @, a non-empty local
// part, and a dotted domain. Matches the slot extractor's EMAIL_PATTERN and the
// Zod .email() the schema enforces, so a value that passes here will persist.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * True when `email` is a usable email address. Required for submission — it's
 * how the customer gets their booking confirmation. Rejects null, the skip
 * sentinel, and anything that isn't a well-formed address.
 */
export function isEmailComplete(email: string | null): boolean {
  if (email === null) return false;
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed === SKIP_SENTINEL) return false;
  return EMAIL_RE.test(trimmed);
}

/**
 * True when `phone` is a usable callback number. The dispatcher's primary key to
 * reach the customer, so it must be more than non-empty: a NANP number has 10
 * digits (or 11 with a leading country code 1). Rejects null, the skip sentinel,
 * and junk like "abc" or "5" that a non-empty check would wave through.
 */
export function isPhoneComplete(phone: string | null): boolean {
  if (phone === null) return false;
  const trimmed = phone.trim();
  if (trimmed.length === 0 || trimmed === SKIP_SENTINEL) return false;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

/**
 * The address gate shared by every completeness check. It MUST accept whatever
 * triage accepts to advance past the address step, or a customer who answered
 * everything can never finish (deadlock). Triage stops asking when the address is
 * strictly complete, was verified via autocomplete, LOOKS complete (a structured
 * non-US / ZIP-less address), OR the re-prompt cap was hit — honor all four.
 */
export function isAddressResolved(extraction: ExtractionResult): boolean {
  return (
    isAddressComplete(extraction.address) ||
    (extraction.address !== null &&
      ((extraction as Record<string, unknown>).addressVerified === "yes" ||
        addressLooksComplete(extraction.address) ||
        Number((extraction as Record<string, unknown>).addressAttempts ?? 0) >=
          MAX_ADDRESS_REPROMPTS))
  );
}

export function isExtractionComplete(extraction: ExtractionResult): boolean {
  return (
    extraction.issueType !== null &&
    extraction.urgency !== null &&
    isAddressResolved(extraction) &&
    isNameComplete(extraction.customerName) &&
    isPhoneComplete(extraction.customerPhone) &&
    // A skipped email (the customer declined, or we hit MAX_EMAIL_REPROMPTS)
    // counts as resolved: the intake proceeds and the request stores no email.
    (isEmailComplete(extraction.customerEmail) ||
      extraction.customerEmail === SKIP_SENTINEL)
  );
}

/**
 * Completeness gate for the PHONE intake, which collects a narrower set than web
 * chat. Over the phone we cannot reliably capture a typed email (and the name is
 * confirmed by the technician at the door, not spelled out on a call), so voice
 * gates only on the dispatch essentials it can actually hear: issue, urgency, a
 * drivable address, and a callback phone. The completed voice session leaves its
 * extraction in metadata for a human to action — it does NOT auto-insert a
 * service_request (that's the web confirm path), so omitting email/name here
 * never persists an invalid record; it only lets the call wrap up.
 */
export function isVoiceExtractionComplete(extraction: ExtractionResult): boolean {
  return (
    extraction.issueType !== null &&
    extraction.urgency !== null &&
    // Same address gate as chat — strict-only here deadlocked a voice caller with
    // a structured non-US / ZIP-less address, or one who hit the re-prompt cap.
    isAddressResolved(extraction) &&
    isPhoneComplete(extraction.customerPhone)
  );
}

// Validated service request data (after customer confirms). Phone AND email are
// required (email is the booking-confirmation channel); the new intake fields
// are optional enrichment. customerName stays nullable in the schema but the
// chat gate (isExtractionComplete) requires a real first+last before confirm.
export const serviceRequestSchema = z.object({
  issueType: z.enum(issueTypeValues),
  urgency: z.enum(urgencyValues),
  address: z.string().min(1),
  customerName: z.string().nullable(),
  // Validate phone SHAPE at the write boundary too (not just .min(1)) so a direct
  // POST to /api/session/confirm can't persist a junk/short number that bypassed
  // the chat gate. Matches isPhoneComplete (10 or 11-digit NANP).
  customerPhone: z
    .string()
    .refine(isPhoneComplete, "Phone must be a 10 or 11-digit US number"),
  // Nullable: a customer may skip the email (see MAX_EMAIL_REPROMPTS) — the
  // request is still dispatchable via phone. A PRESENT value must be a real
  // email so junk can't be persisted through a direct POST.
  customerEmail: z.string().email().nullable(),
  description: z.string().min(1),
  ...optionalIntakeFields,
});

export type ServiceRequestData = z.infer<typeof serviceRequestSchema>;
