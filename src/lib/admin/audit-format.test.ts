import { describe, expect, it } from 'vitest';
import { humanizeAuditKey } from './audit-format';

describe('humanizeAuditKey', () => {
  it('sentence-cases snake and dotted keys', () => {
    expect(humanizeAuditKey('update_settings')).toBe('Update settings');
    expect(humanizeAuditKey('invoice.reminder_sent')).toBe('Invoice reminder sent');
    expect(humanizeAuditKey('create')).toBe('Create');
    expect(humanizeAuditKey('')).toBe('');
  });
});
