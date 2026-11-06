import { describe, expect, it } from 'vitest';
import { formatAuditDetails, humanizeAuditKey } from './audit-format';

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
      'Fields: name, is active · Is active: true',
    );
  });

  it('never echoes a non-JSON or non-object payload', () => {
    expect(formatAuditDetails('reason:customer asked, name: Jane Doe')).toBe('(details unavailable)');
    expect(formatAuditDetails('"Jane Doe"')).toBe('(details unavailable)');
    expect(formatAuditDetails(null)).toBeNull();
  });

  it('shows a dash for an empty value', () => {
    expect(formatAuditDetails(JSON.stringify({ note: '' }))).toBe('Note: —');
  });
});
