import { describe, expect, it } from 'vitest';
import { buildStatusConfirmCopy, isTerminalStatus, techStatusLabel } from './tech-status-confirm';

describe('isTerminalStatus', () => {
  it('is true for cancelled', () => {
    expect(isTerminalStatus('cancelled')).toBe(true);
  });

  it('is true for completed', () => {
    expect(isTerminalStatus('completed')).toBe(true);
  });

  it('is false for the non-terminal manual targets', () => {
    expect(isTerminalStatus('scheduled')).toBe(false);
    expect(isTerminalStatus('in_progress')).toBe(false);
    expect(isTerminalStatus('on_hold')).toBe(false);
  });

  it('is false for an unrecognized status', () => {
    expect(isTerminalStatus('pending')).toBe(false);
    expect(isTerminalStatus('assigned')).toBe(false);
  });
});

describe('buildStatusConfirmCopy', () => {
  it('builds copy for cancelled', () => {
    const copy = buildStatusConfirmCopy('cancelled');
    expect(copy.question).toBe("Mark this request cancelled? This can't be undone.");
    expect(copy.confirmLabel).toBe('Yes, mark cancelled');
    expect(copy.cancelLabel).toBe('No, go back');
  });

  it('builds copy for completed', () => {
    const copy = buildStatusConfirmCopy('completed');
    expect(copy.question).toBe("Mark this request completed? This can't be undone.");
    expect(copy.confirmLabel).toBe('Yes, mark completed');
    expect(copy.cancelLabel).toBe('No, go back');
  });

  it('humanizes a snake_case status', () => {
    const copy = buildStatusConfirmCopy('on_hold');
    expect(copy.question).toContain('on hold');
  });
});

describe('techStatusLabel', () => {
  it('gives field wording to the new taps and keeps humanized defaults', () => {
    expect(techStatusLabel('en_route')).toBe('On my way');
    expect(techStatusLabel('arrived')).toBe("I've arrived");
    expect(techStatusLabel('in_progress')).toBe('In progress');
    expect(techStatusLabel('completed')).toBe('Completed');
  });

  it('does not route the new taps through the terminal confirm gate', () => {
    expect(isTerminalStatus('en_route')).toBe(false);
    expect(isTerminalStatus('arrived')).toBe(false);
  });
});
