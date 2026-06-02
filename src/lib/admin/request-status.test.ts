import { describe, it, expect } from 'vitest';

// The state machine imports requestStatusEnum from the schema only for its
// enumValues type; stub it so this unit test needs no DB/schema wiring.
import { vi } from 'vitest';
vi.mock('@/lib/db/schema', () => ({
  requestStatusEnum: {
    enumValues: ['pending', 'assigned', 'in_progress', 'completed', 'cancelled'],
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
});
