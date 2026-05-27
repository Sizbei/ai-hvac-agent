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

// Schema for what GPT-4o extracts from the conversation
export const extractionSchema = z.object({
  issueType: z.enum(issueTypeValues).nullable().describe('Type of HVAC issue the customer is experiencing'),
  urgency: z.enum(urgencyValues).nullable().describe('How urgent the issue is based on customer description'),
  address: z.string().nullable().describe('Service address provided by the customer'),
  customerName: z.string().nullable().describe('Customer name if provided'),
  customerPhone: z.string().nullable().describe('Customer phone number if provided'),
  customerEmail: z.string().email().nullable().describe('Customer email if provided'),
  description: z.string().describe('Summary of the issue in 1-2 sentences'),
  isHvacRelated: z.boolean().describe('Whether the customer request is related to HVAC services'),
});

export type ExtractionResult = z.infer<typeof extractionSchema>;

// The 3 required fields that trigger extraction completion per D-02
export const REQUIRED_EXTRACTION_FIELDS = ['issueType', 'urgency', 'address'] as const;

export function isExtractionComplete(extraction: ExtractionResult): boolean {
  return (
    extraction.issueType !== null &&
    extraction.urgency !== null &&
    extraction.address !== null &&
    extraction.address.length > 0
  );
}

// Validated service request data (after customer confirms)
export const serviceRequestSchema = z.object({
  issueType: z.enum(issueTypeValues),
  urgency: z.enum(urgencyValues),
  address: z.string().min(1),
  customerName: z.string().nullable(),
  customerPhone: z.string().nullable(),
  customerEmail: z.string().email().nullable(),
  description: z.string().min(1),
});

export type ServiceRequestData = z.infer<typeof serviceRequestSchema>;
