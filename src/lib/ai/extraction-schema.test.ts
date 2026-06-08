import { describe, it, expect } from 'vitest';
import {
  extractionSchema,
  serviceRequestSchema,
  isExtractionComplete,
  jobTypeForIssue,
  REQUIRED_EXTRACTION_FIELDS,
  type ExtractionResult,
} from '@/lib/ai/extraction-schema';

const completeExtraction: ExtractionResult = {
  issueType: 'heating_not_working',
  urgency: 'high',
  address: '123 Main St',
  customerName: 'John Doe',
  customerPhone: '555-0100',
  customerEmail: 'john@example.com',
  description: 'Furnace stopped working last night',
  isHvacRelated: true,
};

describe('REQUIRED_EXTRACTION_FIELDS', () => {
  it('should contain issueType, urgency, address, and customerPhone', () => {
    expect(REQUIRED_EXTRACTION_FIELDS).toEqual([
      'issueType',
      'urgency',
      'address',
      'customerPhone',
    ]);
  });
});

describe('isExtractionComplete', () => {
  it('should return true when issueType, urgency, and address are all present', () => {
    expect(isExtractionComplete(completeExtraction)).toBe(true);
  });

  it('should return false when issueType is null', () => {
    const extraction: ExtractionResult = { ...completeExtraction, issueType: null };
    expect(isExtractionComplete(extraction)).toBe(false);
  });

  it('should return false when urgency is null', () => {
    const extraction: ExtractionResult = { ...completeExtraction, urgency: null };
    expect(isExtractionComplete(extraction)).toBe(false);
  });

  it('should return false when address is null', () => {
    const extraction: ExtractionResult = { ...completeExtraction, address: null };
    expect(isExtractionComplete(extraction)).toBe(false);
  });

  it('should return false when address is empty string', () => {
    const extraction: ExtractionResult = { ...completeExtraction, address: '' };
    expect(isExtractionComplete(extraction)).toBe(false);
  });

  it('should return false when customerPhone is missing (now required)', () => {
    const extraction: ExtractionResult = { ...completeExtraction, customerPhone: null };
    expect(isExtractionComplete(extraction)).toBe(false);
  });

  it('should return true when only name and email (truly optional) are null', () => {
    const extraction: ExtractionResult = {
      ...completeExtraction,
      customerName: null,
      customerEmail: null,
    };
    expect(isExtractionComplete(extraction)).toBe(true);
  });

  it('should return false when all three required fields are null', () => {
    const extraction: ExtractionResult = {
      ...completeExtraction,
      issueType: null,
      urgency: null,
      address: null,
    };
    expect(isExtractionComplete(extraction)).toBe(false);
  });
});

describe('extractionSchema', () => {
  it('should accept valid complete data', () => {
    const result = extractionSchema.parse(completeExtraction);
    expect(result.issueType).toBe('heating_not_working');
    expect(result.urgency).toBe('high');
    expect(result.address).toBe('123 Main St');
  });

  it('should accept data with null optional fields', () => {
    const data = {
      ...completeExtraction,
      customerName: null,
      customerPhone: null,
      customerEmail: null,
    };
    const result = extractionSchema.parse(data);
    expect(result.customerName).toBeNull();
    expect(result.customerPhone).toBeNull();
    expect(result.customerEmail).toBeNull();
  });

  it('should reject invalid urgency value', () => {
    const data = { ...completeExtraction, urgency: 'critical' };
    expect(() => extractionSchema.parse(data)).toThrow();
  });

  it('should reject invalid issueType value', () => {
    const data = { ...completeExtraction, issueType: 'plumbing' };
    expect(() => extractionSchema.parse(data)).toThrow();
  });

  it('should reject invalid email format', () => {
    const data = { ...completeExtraction, customerEmail: 'not-an-email' };
    expect(() => extractionSchema.parse(data)).toThrow();
  });

  it('should require description field', () => {
    const { description, ...withoutDescription } = completeExtraction;
    expect(() => extractionSchema.parse(withoutDescription)).toThrow();
  });

  it('should require isHvacRelated field', () => {
    const { isHvacRelated, ...withoutFlag } = completeExtraction;
    expect(() => extractionSchema.parse(withoutFlag)).toThrow();
  });
});

describe('new ServiceTitan-style optional slots', () => {
  it('accepts all new fields when present', () => {
    const parsed = extractionSchema.parse({
      ...completeExtraction,
      systemType: 'heat_pump',
      equipmentBrand: 'Trane',
      equipmentAgeBand: '10_to_15',
      propertyType: 'residential',
      ownerOccupant: 'owner',
      underWarranty: 'unknown',
      accessNotes: 'gate code 4821, dog in yard',
      systemDownStatus: 'fully_down',
      problemDuration: 'since yesterday',
      vulnerableOccupants: true,
      preferredWindow: 'morning',
      contactPreference: 'text',
      leadSource: 'google',
    });
    expect(parsed.systemType).toBe('heat_pump');
    expect(parsed.preferredWindow).toBe('morning');
    expect(parsed.vulnerableOccupants).toBe(true);
  });

  it('treats every new field as optional (absent is valid)', () => {
    expect(() => extractionSchema.parse(completeExtraction)).not.toThrow();
  });

  it('rejects an out-of-enum systemType', () => {
    expect(
      extractionSchema.safeParse({ ...completeExtraction, systemType: 'spaceship' })
        .success,
    ).toBe(false);
  });
});

describe('jobTypeForIssue (symptom → ServiceTitan job type)', () => {
  it('maps heating/cooling failures to no_heat/no_cool', () => {
    expect(jobTypeForIssue('heating_not_working')).toBe('no_heat');
    expect(jobTypeForIssue('cooling_not_working')).toBe('no_cool');
  });
  it('maps maintenance and installation', () => {
    expect(jobTypeForIssue('maintenance')).toBe('maintenance');
    expect(jobTypeForIssue('installation')).toBe('install');
  });
  it('falls back to service_call for generic symptoms, null for null', () => {
    expect(jobTypeForIssue('strange_noises')).toBe('service_call');
    expect(jobTypeForIssue('other')).toBe('service_call');
    expect(jobTypeForIssue(null)).toBe(null);
  });
});

describe('serviceRequestSchema (confirm payload)', () => {
  it('requires customerPhone', () => {
    const r = serviceRequestSchema.safeParse({
      issueType: 'cooling_not_working',
      urgency: 'high',
      address: '5 Oak St',
      customerName: null,
      customerPhone: null,
      customerEmail: null,
      description: 'AC out',
    });
    expect(r.success).toBe(false);
  });

  it('accepts the new optional fields', () => {
    const parsed = serviceRequestSchema.parse({
      issueType: 'cooling_not_working',
      urgency: 'high',
      address: '5 Oak St',
      customerName: 'Jane',
      customerPhone: '555-123-4567',
      customerEmail: null,
      description: 'AC out',
      systemType: 'central_ac',
      preferredWindow: 'afternoon',
      contactPreference: 'call',
      smsConsent: false,
      leadSource: 'referral',
    });
    expect(parsed.systemType).toBe('central_ac');
    expect(parsed.leadSource).toBe('referral');
  });
});
