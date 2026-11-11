import { describe, it, expect } from 'vitest';
import {
  REPLY_MAX_LENGTH,
  canReplyByChannel,
  getReplyLengthError,
  extractConsentReason,
  replyErrorToCopy,
  modeIndicator,
} from './conversation-reply-logic';

describe('canReplyByChannel', () => {
  it('allows sms', () => {
    expect(canReplyByChannel('sms')).toBe(true);
  });

  it('rejects web and phone', () => {
    expect(canReplyByChannel('web')).toBe(false);
    expect(canReplyByChannel('phone')).toBe(false);
  });
});

describe('getReplyLengthError', () => {
  it('rejects empty/whitespace-only input', () => {
    expect(getReplyLengthError('')).toBe('Enter a reply before sending.');
    expect(getReplyLengthError('   ')).toBe('Enter a reply before sending.');
  });

  it('rejects input over the 1600-char server bound', () => {
    const tooLong = 'a'.repeat(REPLY_MAX_LENGTH + 1);
    expect(getReplyLengthError(tooLong)).toMatch(/too long/);
  });

  it('accepts input at the boundary', () => {
    const atLimit = 'a'.repeat(REPLY_MAX_LENGTH);
    expect(getReplyLengthError(atLimit)).toBeNull();
  });

  it('accepts a normal message', () => {
    expect(getReplyLengthError('On my way, thanks for your patience!')).toBeNull();
  });

  it('trims before measuring length', () => {
    const padded = `  ${'a'.repeat(REPLY_MAX_LENGTH)}  `;
    expect(getReplyLengthError(padded)).toBeNull();
  });
});

describe('extractConsentReason', () => {
  it('extracts the reason from the server-shaped message', () => {
    expect(extractConsentReason('Cannot message this customer: do_not_contact')).toBe(
      'do_not_contact',
    );
    expect(
      extractConsentReason('Cannot message this customer: channel_disabled:sms'),
    ).toBe('channel_disabled:sms');
  });

  it('returns null for an unrecognized message shape', () => {
    expect(extractConsentReason('Something else entirely')).toBeNull();
    expect(extractConsentReason('Cannot message this customer: ')).toBeNull();
  });
});

describe('consent reason copy', () => {
  it("maps review_requests_off to 'Review texts are off for this account.' and has no demo copy", () => {
    const copy = replyErrorToCopy({
      code: 'CONSENT_BLOCKED',
      message: 'Cannot message this customer: review_requests_off',
    });
    expect(copy).toBe('Review texts are off for this account.');
    expect(copy.toLowerCase()).not.toContain('demo');
  });
});

describe('replyErrorToCopy', () => {
  it('maps DEMO_RESTRICTED', () => {
    expect(
      replyErrorToCopy({ code: 'DEMO_RESTRICTED', message: 'Sending is disabled for the demo account' }),
    ).toBe('Sending replies is turned off for this account.');
  });

  it('maps RATE_LIMITED', () => {
    expect(replyErrorToCopy({ code: 'RATE_LIMITED', message: 'Rate limit exceeded' })).toMatch(
      /too quickly/,
    );
  });

  it('maps UNSUPPORTED_CHANNEL', () => {
    expect(
      replyErrorToCopy({
        code: 'UNSUPPORTED_CHANNEL',
        message: 'Replying is only supported for active SMS conversations',
      }),
    ).toBe('Replying is only available for active text-message conversations.');
  });

  it('maps CONSENT_BLOCKED with a known reason to human copy, never the raw reason', () => {
    const copy = replyErrorToCopy({
      code: 'CONSENT_BLOCKED',
      message: 'Cannot message this customer: do_not_contact',
    });
    expect(copy).toBe('This customer has asked not to be contacted.');
    expect(copy).not.toMatch(/do_not_contact/);
  });

  it('maps CONSENT_BLOCKED with an unrecognized reason to a generic sentence, not the raw code', () => {
    const copy = replyErrorToCopy({
      code: 'CONSENT_BLOCKED',
      message: 'Cannot message this customer: some_future_reason',
    });
    expect(copy).not.toMatch(/some_future_reason/);
    expect(copy.length).toBeGreaterThan(0);
  });

  it('maps INVALID_INPUT, NOT_FOUND, UNAUTHORIZED', () => {
    expect(replyErrorToCopy({ code: 'INVALID_INPUT', message: 'Message is required' })).toMatch(
      /1 and 1,600/,
    );
    expect(replyErrorToCopy({ code: 'NOT_FOUND', message: 'Conversation not found' })).toMatch(
      /could not be found/,
    );
    expect(replyErrorToCopy({ code: 'UNAUTHORIZED', message: 'Unauthorized' })).toMatch(
      /sign in again/,
    );
  });

  it('falls back to a human sentence for unknown/internal codes, never the raw message', () => {
    expect(replyErrorToCopy({ code: 'INTERNAL_ERROR', message: 'Internal server error' })).toBe(
      'Could not send the reply — try again in a moment.',
    );
    expect(replyErrorToCopy({ code: '', message: 'Unknown error' })).toBe(
      'Could not send the reply — try again in a moment.',
    );
  });
});

describe('modeIndicator', () => {
  it('renders human mode as an Office replying/warning indicator', () => {
    expect(modeIndicator('human')).toEqual({ label: 'Office replying', variant: 'warning' });
  });

  it('renders ai mode (and any other value) as an AI replying/info indicator', () => {
    expect(modeIndicator('ai')).toEqual({ label: 'AI replying', variant: 'info' });
    expect(modeIndicator('unknown')).toEqual({ label: 'AI replying', variant: 'info' });
  });
});
