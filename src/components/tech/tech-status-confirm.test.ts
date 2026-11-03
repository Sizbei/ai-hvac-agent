import { describe, expect, it } from 'vitest';
import {
  actionNeedsSheet,
  buildActionSheetCopy,
  buildStatusConfirmCopy,
  describeBlocker,
  holdReasonLabel,
  isTerminalStatus,
  relevantBlockers,
  techStatusLabel,
} from './tech-status-confirm';
import type { Blocker } from '@/lib/tech/status-actions';

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
    expect(techStatusLabel('completed')).toBe('Done');
  });

  it('does not route the new taps through the terminal confirm gate', () => {
    expect(isTerminalStatus('en_route')).toBe(false);
    expect(isTerminalStatus('arrived')).toBe(false);
  });
});

describe('techStatusLabel for the action set', () => {
  it('labels pause, hold and close out', () => {
    expect(techStatusLabel('pause')).toBe('Pause');
    expect(techStatusLabel('on_hold')).toBe('Hold');
    expect(techStatusLabel('close_out')).toBe('Close out');
  });
});

describe('actionNeedsSheet', () => {
  it('sends done, pause, hold and close out through the sheet only', () => {
    for (const a of ['completed', 'pause', 'on_hold', 'close_out']) expect(actionNeedsSheet(a)).toBe(true);
    for (const a of ['en_route', 'arrived', 'in_progress']) expect(actionNeedsSheet(a)).toBe(false);
  });
});

describe('describeBlocker', () => {
  const cases: [Blocker, string][] = [
    [{ kind: 'technician_open', technicianName: 'Ben', technicianId: 't', appointmentNumber: 1 }, 'Ben is still working'],
    [{ kind: 'visit_planned', appointmentNumber: 2, date: '2026-11-12T15:00:00.000Z' }, 'Visit #2 on Nov 12 is planned — put this job on hold'],
    [{ kind: 'visit_planned', appointmentNumber: 3, date: null }, 'Visit #3 is planned — put this job on hold'],
    [{ kind: 'earlier_visit_open', technicianName: 'Ben', appointmentNumber: 1 }, 'Waiting on an earlier visit (Ben, visit #1)'],
    [{ kind: 'request_not_started', status: 'scheduled' }, 'Tap Working first'],
    [{ kind: 'not_lead' }, 'Only the lead technician can close out this request'],
    [{ kind: 'managed_externally' }, 'Managed in FieldPulse'],
  ];
  it.each(cases)('describes %j', (b, text) => {
    expect(describeBlocker(b)).toBe(text);
  });
});

describe('relevantBlockers', () => {
  it('drops not_lead and managed_externally (they are notices, not close-out blockers)', () => {
    const open: Blocker = { kind: 'request_not_started', status: 'scheduled' };
    expect(relevantBlockers([{ kind: 'not_lead' }, { kind: 'managed_externally' }, open])).toEqual([open]);
  });
});

describe('holdReasonLabel', () => {
  it('sentence-cases the enum', () => {
    expect(holdReasonLabel('awaiting_parts')).toBe('Awaiting parts');
  });
});

describe('buildActionSheetCopy', () => {
  it('explains that holding ends the visit', () => {
    expect(buildActionSheetCopy('on_hold').description).toMatch(/ends this visit/i);
  });
  it('has a title and confirm label for every sheet action', () => {
    for (const a of ['completed', 'pause', 'on_hold', 'close_out'] as const) {
      const c = buildActionSheetCopy(a);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.confirmLabel.length).toBeGreaterThan(0);
    }
    expect(buildActionSheetCopy('close_out').description).toMatch(/can't be undone/);
  });
});
