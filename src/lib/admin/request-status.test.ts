import { describe, it, expect } from 'vitest';

// The state machine imports requestStatusEnum from the schema only for its
// enumValues type; stub it so this unit test needs no DB/schema wiring.
import { vi } from 'vitest';
vi.mock('@/lib/db/schema', () => ({
  requestStatusEnum: {
    enumValues: [
      'pending',
      'assigned',
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
