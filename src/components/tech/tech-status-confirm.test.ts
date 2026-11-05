import { describe, expect, it } from 'vitest';
import {
  closeOutInvoiceWarning,
  actionNeedsSheet,
  buildActionSheetCopy,
  describeBlocker,
  holdReasonLabel,
  labelAssignmentStatus,
  relevantBlockers,
  showRequestBehind,
  techStatusLabel,
} from './tech-status-confirm';
import type { Blocker } from '@/lib/tech/status-actions';

describe('techStatusLabel', () => {
  it('gives field wording to the new taps and keeps humanized defaults', () => {
    expect(techStatusLabel('en_route')).toBe('On my way');
    expect(techStatusLabel('arrived')).toBe("I've arrived");
    expect(techStatusLabel('in_progress')).toBe('Working');
    expect(techStatusLabel('completed')).toBe('Done');
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
    [{ kind: 'technician_open', technicianName: 'Ben', technicianId: 't', appointmentNumber: 1, started: true }, 'Ben is still working'],
    [{ kind: 'technician_open', technicianName: 'Ben', technicianId: 't', appointmentNumber: 1, started: false }, "Ben hasn't started yet"],
    [{ kind: 'visit_planned', appointmentNumber: 2, date: '2026-11-12T15:00:00.000Z' }, 'Visit #2 on Nov 12 is planned — put this request on hold'],
    [{ kind: 'visit_planned', appointmentNumber: 3, date: null }, 'Visit #3 is planned — put this request on hold'],
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
  it('the hold sheet says request, not job', () => {
    const c = buildActionSheetCopy('on_hold');
    expect(c.title).toBe('Put this request on hold?');
    expect(c.confirmLabel).toBe('Hold request');
    expect(`${c.title} ${c.description} ${c.confirmLabel}`).not.toMatch(/\bjob\b/i);
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

describe('showRequestBehind', () => {
  const earlier: Blocker = { kind: 'earlier_visit_open', technicianName: 'Ben', appointmentNumber: 1 };
  it('shows when an earlier visit is open, even after a reload', () => {
    expect(showRequestBehind([earlier], false)).toBe(true);
  });
  it('shows when the last response said behind', () => {
    expect(showRequestBehind([], true)).toBe(true);
  });
  it('shows when both the blocker and the flag are present', () => {
    expect(showRequestBehind([earlier], true)).toBe(true);
  });
  it('hides once the earlier visit closes and no response flag remains', () => {
    expect(showRequestBehind([{ kind: 'not_lead' }], false)).toBe(false);
  });
});

describe('labelAssignmentStatus', () => {
  it('humanizes the enum in sentence case', () => {
    expect(labelAssignmentStatus('in_progress')).toBe('In progress');
    expect(labelAssignmentStatus('on_hold')).toBe('On hold');
    expect(labelAssignmentStatus('en_route')).toBe('En route');
    expect(labelAssignmentStatus('completed')).toBe('Completed');
  });
});

describe('closeOutInvoiceWarning', () => {
  it('draft invoice is not approved yet', () => {
    expect(closeOutInvoiceWarning({ state: 'draft', balanceCents: 68657 })).toBe("The invoice isn't approved yet.");
  });
  it('open invoice with a balance names the amount due', () => {
    expect(closeOutInvoiceWarning({ state: 'open', balanceCents: 68657 })).toBe('The invoice still has $686.57 due.');
  });
  it('nothing to warn about', () => {
    expect(closeOutInvoiceWarning(null)).toBeNull();
    expect(closeOutInvoiceWarning({ state: 'open', balanceCents: 0 })).toBeNull();
    expect(closeOutInvoiceWarning({ state: 'paid', balanceCents: 0 })).toBeNull();
  });
});
