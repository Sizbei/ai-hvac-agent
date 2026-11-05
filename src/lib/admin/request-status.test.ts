import { describe, it, expect } from 'vitest';

// The state machine imports requestStatusEnum from the schema only for its
// enumValues type; stub it so this unit test needs no DB/schema wiring.
import { vi } from 'vitest';
vi.mock('@/lib/db/schema', () => ({
  requestStatusEnum: {
    enumValues: [
      'pending',
      'assigned',
      'en_route',
      'arrived',
      'scheduled',
      'in_progress',
      'on_hold',
      'completed',
      'cancelled',
    ],
  },
  holdReasonEnum: {
    enumValues: [
      'awaiting_parts',
      'awaiting_customer',
      'awaiting_access',
      'weather',
      'other',
    ],
  },
}));

import {
  canTransition,
  allowedTransitions,
  isTerminal,
  MANUAL_TARGET_STATUSES,
} from './request-status';

describe('request-status state machine', () => {
  it('allows the forward lifecycle edges', () => {
    expect(canTransition('assigned', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'completed')).toBe(true);
  });

  it('allows cancelling from any open state', () => {
    expect(canTransition('pending', 'cancelled')).toBe(true);
    expect(canTransition('assigned', 'cancelled')).toBe(true);
    expect(canTransition('in_progress', 'cancelled')).toBe(true);
  });

  it('rejects skipping states', () => {
    expect(canTransition('pending', 'completed')).toBe(false);
    expect(canTransition('pending', 'in_progress')).toBe(false);
    expect(canTransition('assigned', 'completed')).toBe(false);
  });

  it('rejects any transition out of a terminal state', () => {
    expect(canTransition('completed', 'in_progress')).toBe(false);
    expect(canTransition('cancelled', 'pending')).toBe(false);
    expect(allowedTransitions('completed')).toEqual([]);
    expect(allowedTransitions('cancelled')).toEqual([]);
  });

  it('marks completed and cancelled as terminal', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('assigned')).toBe(false);
  });

  it('does not expose "assigned" as a manual target (assignment is a separate flow)', () => {
    expect(MANUAL_TARGET_STATUSES).not.toContain('assigned');
    expect(MANUAL_TARGET_STATUSES).toContain('in_progress');
    expect(MANUAL_TARGET_STATUSES).toContain('completed');
    expect(MANUAL_TARGET_STATUSES).toContain('cancelled');
  });

  describe('new stages: scheduled + on_hold', () => {
    it('can schedule a pending or assigned request', () => {
      expect(canTransition('pending', 'scheduled')).toBe(true);
      expect(canTransition('assigned', 'scheduled')).toBe(true);
    });

    it('a scheduled request can start, pause, or cancel', () => {
      expect(canTransition('scheduled', 'in_progress')).toBe(true);
      expect(canTransition('scheduled', 'on_hold')).toBe(true);
      expect(canTransition('scheduled', 'cancelled')).toBe(true);
    });

    it('an active job can be put on hold and resumed', () => {
      expect(canTransition('in_progress', 'on_hold')).toBe(true);
      expect(canTransition('on_hold', 'in_progress')).toBe(true);
      expect(canTransition('on_hold', 'scheduled')).toBe(true);
    });

    it('a held job can be completed directly (tech finished while on hold)', () => {
      expect(canTransition('on_hold', 'completed')).toBe(true);
    });

    it('neither new stage is terminal', () => {
      expect(isTerminal('scheduled')).toBe(false);
      expect(isTerminal('on_hold')).toBe(false);
    });

    it('still cannot resume a completed/cancelled job into the new stages', () => {
      expect(canTransition('completed', 'on_hold')).toBe(false);
      expect(canTransition('cancelled', 'scheduled')).toBe(false);
    });

    it('exposes both new stages as manual targets', () => {
      expect(MANUAL_TARGET_STATUSES).toContain('scheduled');
      expect(MANUAL_TARGET_STATUSES).toContain('on_hold');
    });
  });
});

import { IN_FLIGHT_STATUSES, OPEN_STATUSES, ON_SITE_STATUSES, NOT_STARTED_STATUSES, TERMINAL_STATUSES } from './request-status';

describe('en_route / arrived', () => {
  it('tech taps follow assigned → en_route → arrived → in_progress', () => {
    expect(canTransition('assigned', 'en_route')).toBe(true);
    expect(canTransition('scheduled', 'en_route')).toBe(true);
    expect(canTransition('on_hold', 'en_route')).toBe(true);
    expect(canTransition('en_route', 'arrived')).toBe(true);
    expect(canTransition('en_route', 'in_progress')).toBe(true);
    expect(canTransition('en_route', 'scheduled')).toBe(true);
    expect(canTransition('arrived', 'in_progress')).toBe(true);
    expect(canTransition('arrived', 'completed')).toBe(false);
    expect(canTransition('en_route', 'completed')).toBe(false);
  });
  it('are manual targets', () => {
    expect(MANUAL_TARGET_STATUSES).toContain('en_route');
    expect(MANUAL_TARGET_STATUSES).toContain('arrived');
  });
  it('every enum value is in OPEN or TERMINAL, and the derived lists are subsets', () => {
    const all = ['pending','assigned','en_route','arrived','scheduled','in_progress','on_hold','completed','cancelled'];
    for (const s of all) expect([...OPEN_STATUSES, ...TERMINAL_STATUSES]).toContain(s);
    for (const s of IN_FLIGHT_STATUSES) expect(OPEN_STATUSES).toContain(s);
    for (const s of ON_SITE_STATUSES) expect(IN_FLIGHT_STATUSES).toContain(s);
    for (const s of NOT_STARTED_STATUSES) expect(IN_FLIGHT_STATUSES).toContain(s);
    expect(NOT_STARTED_STATUSES).toContain('en_route');
    expect(ON_SITE_STATUSES).not.toContain('en_route');
  });
});

import { REASSIGNABLE_STATUSES, requestStatusLabel } from './request-status';

describe('REASSIGNABLE_STATUSES (sheet reassign matches calendar drag)', () => {
  it('includes scheduled and assigned, so a booked request can change technician', () => {
    expect(REASSIGNABLE_STATUSES).toContain('scheduled');
    expect(REASSIGNABLE_STATUSES).toContain('assigned');
  });
  it('keeps working states (the visit-one guard refuses once there is progress)', () => {
    for (const s of ['en_route', 'arrived', 'in_progress', 'on_hold']) {
      expect(REASSIGNABLE_STATUSES).toContain(s);
    }
  });
  it('never includes pending (no assignee to swap) or terminal states', () => {
    expect(REASSIGNABLE_STATUSES).not.toContain('pending');
    for (const s of TERMINAL_STATUSES) expect(REASSIGNABLE_STATUSES).not.toContain(s);
  });
});

describe('requestStatusLabel', () => {
  it('turns enum values into sentence case', () => {
    expect(requestStatusLabel('in_progress')).toBe('In progress');
    expect(requestStatusLabel('on_hold')).toBe('On hold');
    expect(requestStatusLabel('scheduled')).toBe('Scheduled');
  });
  it('falls back for an empty value', () => {
    expect(requestStatusLabel('')).toBe('Unknown');
  });
});
