import { describe, expect, it } from 'vitest';
import { auditDetailIds, formatAuditDetails, humanizeAuditKey } from './audit-format';

describe('humanizeAuditKey', () => {
  it('sentence-cases snake and dotted keys', () => {
    expect(humanizeAuditKey('update_settings')).toBe('Update settings');
    expect(humanizeAuditKey('invoice.reminder_sent')).toBe('Invoice reminder sent');
    expect(humanizeAuditKey('create')).toBe('Create');
    expect(humanizeAuditKey('')).toBe('');
  });
});

describe('formatAuditDetails', () => {
  it('reads camelCase keys and ISO dates as words', () => {
    const line = formatAuditDetails(
      JSON.stringify({
        from: '2026-10-06T00:00:00.000Z',
        NativeRowCount: 7,
        syncedRowCount: 0,
      }),
    );
    expect(line).toBe('From: Oct 6, 2026 · Native row count: 7 · Synced row count: 0');
  });

  it('turns field-name values into words', () => {
    expect(formatAuditDetails(JSON.stringify({ keys: ['showOnHome', 'dismissed'] }))).toBe(
      'Keys: show on home, dismissed',
    );
    expect(formatAuditDetails(JSON.stringify({ fields: ['name', 'isActive'], isActive: true }))).toBe(
      'Fields: name, is active · Is active: yes',
    );
  });

  it('never echoes a non-JSON or non-object payload', () => {
    expect(formatAuditDetails('reason:customer asked, name: Jane Doe')).toBeNull();
    expect(formatAuditDetails('"Jane Doe"')).toBeNull();
    expect(formatAuditDetails(null)).toBeNull();
  });

  it('shows a dash for an empty value', () => {
    expect(formatAuditDetails(JSON.stringify({ note: '' }))).toBe('Note: —');
  });
});

const TECH = '85204407-970c-456c-90e2-0a29126ba6e6';
const REQ = '8cc75bb1-fae0-4fd3-9bec-b7f0a4ca403b';

describe('formatAuditDetails ids, money and codes', () => {
  it('shows an id as the label it resolves to and drops the "id" from the key', () => {
    const line = formatAuditDetails(
      JSON.stringify({ serviceRequestId: REQ, appointmentNumber: 1, technicianIds: [TECH] }),
      { [REQ]: 'HVAC-1042', [TECH]: 'Troy McCurry' },
    );
    expect(line).toBe('Service request: HVAC-1042 · Appointment number: 1 · Technicians: Troy McCurry');
  });

  it('never shows a raw id: unresolved ids, nulls and empty lists are left out', () => {
    const line = formatAuditDetails(
      JSON.stringify({ customerId: REQ, technicianId: null, tagTypeIds: [], urgency: 'low' }),
    );
    expect(line).toBe('Urgency: low');
    expect(formatAuditDetails(JSON.stringify({ customerId: REQ }))).toBeNull();
  });

  it('reads cents as dollars and internal codes as words', () => {
    expect(
      formatAuditDetails(
        JSON.stringify({ source: 'fieldpulse_invoice_pull', fieldpulseInvoiceId: '21602036', totalCents: 123456 }),
      ),
    ).toBe('Source: FieldPulse sync · FieldPulse invoice: 21602036 · Total: $1,234.56');
    expect(formatAuditDetails(JSON.stringify({ kind: 'time_off', removesCapacity: true }))).toBe(
      'Kind: time off · Removes capacity: yes',
    );
  });
});

describe('auditDetailIds', () => {
  it('collects every id, lower-cased, from values and lists', () => {
    expect(
      auditDetailIds(JSON.stringify({ a: REQ.toUpperCase(), b: [TECH, 'x'], c: 3 })),
    ).toEqual([REQ, TECH]);
    expect(auditDetailIds('not json')).toEqual([]);
    expect(auditDetailIds(null)).toEqual([]);
  });
});
