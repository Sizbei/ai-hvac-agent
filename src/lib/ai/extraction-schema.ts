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
    // general service call (the tech diagnoses on site).
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
  address: z.string().nullable().describe('Service address provided by the customer'),
  customerName: z.string().nullable().describe('Customer name if provided'),
  customerPhone: z.string().nullable().describe('Customer phone number if provided'),
  customerEmail: z.string().email().nullable().describe('Customer email if provided'),
  description: z.string().describe('Summary of the issue in 1-2 sentences'),
  isHvacRelated: z.boolean().describe('Whether the customer request is related to HVAC services'),
  ...optionalIntakeFields,
});

export type ExtractionResult = z.infer<typeof extractionSchema>;

// The fields that gate submission. Phone is now required (the dispatch primary
// key — a dispatcher cannot act on a request with no way to reach the customer).
export const REQUIRED_EXTRACTION_FIELDS = [
  'issueType',
  'urgency',
  'address',
  'customerPhone',
] as const;

export function isExtractionComplete(extraction: ExtractionResult): boolean {
  return (
    extraction.issueType !== null &&
    extraction.urgency !== null &&
    extraction.address !== null &&
    extraction.address.length > 0 &&
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
