import { z } from 'zod';

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

// The fields that gate submission. Phone is now required (the dispatch primary
// key — a dispatcher cannot act on a request with no way to reach the customer).
// Name is required too: dispatch needs a person to ask for at the door.
export const REQUIRED_EXTRACTION_FIELDS = [
  'issueType',
  'urgency',
  'address',
  'customerPhone',
  'customerName',
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
export function isAddressComplete(address: string | null): boolean {
  if (address === null) return false;
  const trimmed = address.trim();
  if (trimmed.length === 0) return false;

  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 4) return false;

  // First token must start with a digit (the street number).
  if (!/^\d/.test(tokens[0])) return false;

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

export function isExtractionComplete(extraction: ExtractionResult): boolean {
  return (
    extraction.issueType !== null &&
    extraction.urgency !== null &&
    isAddressComplete(extraction.address) &&
    isNameComplete(extraction.customerName) &&
    extraction.customerPhone !== null &&
    extraction.customerPhone.length > 0
  );
}

// Validated service request data (after customer confirms). Phone is required;
// the new intake fields are optional enrichment.
export const serviceRequestSchema = z.object({
  issueType: z.enum(issueTypeValues),
  urgency: z.enum(urgencyValues),
  address: z.string().min(1),
  customerName: z.string().nullable(),
  customerPhone: z.string().min(1),
  customerEmail: z.string().email().nullable(),
  description: z.string().min(1),
  ...optionalIntakeFields,
});

export type ServiceRequestData = z.infer<typeof serviceRequestSchema>;
