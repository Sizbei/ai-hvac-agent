import { describe, it, expect } from 'vitest';
import {
  extractionSchema,
  isExtractionComplete,
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
  it('should contain exactly issueType, urgency, and address', () => {
    expect(REQUIRED_EXTRACTION_FIELDS).toEqual(['issueType', 'urgency', 'address']);
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

  it('should return true even when optional fields are null', () => {
    const extraction: ExtractionResult = {
      ...completeExtraction,
      customerName: null,
      customerPhone: null,
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
