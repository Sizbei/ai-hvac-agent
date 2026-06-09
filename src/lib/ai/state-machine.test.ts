import { describe, it, expect } from 'vitest';
import {
  SESSION_STATES,
  TERMINAL_STATES,
  ALL_STATES,
  canTransition,
  transition,
  isTerminalState,
  determineNextState,
} from '@/lib/ai/state-machine';

describe('constants', () => {
  it('should have 4 session states', () => {
    expect(SESSION_STATES).toEqual(['chatting', 'extracting', 'confirmed', 'submitted']);
  });

  it('should have 2 terminal states', () => {
    expect(TERMINAL_STATES).toEqual(['escalated', 'abandoned']);
  });

  it('should have 6 total states', () => {
    expect(ALL_STATES).toHaveLength(6);
  });
});

describe('canTransition', () => {
  // Valid transitions from chatting
  it('should allow chatting -> extracting', () => {
    expect(canTransition('chatting', 'extracting')).toBe(true);
  });

  it('should allow chatting -> escalated', () => {
    expect(canTransition('chatting', 'escalated')).toBe(true);
  });

  it('should allow chatting -> abandoned', () => {
    expect(canTransition('chatting', 'abandoned')).toBe(true);
  });

  // Invalid transitions from chatting
  it('should NOT allow chatting -> confirmed', () => {
    expect(canTransition('chatting', 'confirmed')).toBe(false);
  });

  it('should NOT allow chatting -> submitted', () => {
    expect(canTransition('chatting', 'submitted')).toBe(false);
  });

  // Valid transitions from extracting
  it('should allow extracting -> confirmed', () => {
    expect(canTransition('extracting', 'confirmed')).toBe(true);
  });

  it('should allow extracting -> chatting (correction flow)', () => {
    expect(canTransition('extracting', 'chatting')).toBe(true);
  });

  it('should allow extracting -> escalated', () => {
    expect(canTransition('extracting', 'escalated')).toBe(true);
  });

  it('should allow extracting -> abandoned', () => {
    expect(canTransition('extracting', 'abandoned')).toBe(true);
  });

  // Invalid transitions from extracting
  it('should NOT allow extracting -> submitted', () => {
    expect(canTransition('extracting', 'submitted')).toBe(false);
  });

  // Valid transitions from confirmed
  it('should allow confirmed -> submitted', () => {
    expect(canTransition('confirmed', 'submitted')).toBe(true);
  });

  it('should allow confirmed -> chatting (edit flow)', () => {
    expect(canTransition('confirmed', 'chatting')).toBe(true);
  });

  it('should allow confirmed -> escalated', () => {
    expect(canTransition('confirmed', 'escalated')).toBe(true);
  });

  it('should allow confirmed -> abandoned', () => {
    expect(canTransition('confirmed', 'abandoned')).toBe(true);
  });

  // Terminal states: no transitions allowed
  it('should NOT allow submitted -> any state', () => {
    for (const target of ALL_STATES) {
      expect(canTransition('submitted', target)).toBe(false);
    }
  });

  it('should NOT allow escalated -> any state', () => {
    for (const target of ALL_STATES) {
      expect(canTransition('escalated', target)).toBe(false);
    }
  });

  it('should NOT allow abandoned -> any state', () => {
    for (const target of ALL_STATES) {
      expect(canTransition('abandoned', target)).toBe(false);
    }
  });
});

describe('transition', () => {
  it('should return success: true for valid transition', () => {
    const result = transition('chatting', 'extracting');
    expect(result.success).toBe(true);
    expect(result.newState).toBe('extracting');
    expect(result.reason).toBeUndefined();
  });

  it('should return success: false with reason for invalid transition', () => {
    const result = transition('chatting', 'submitted');
    expect(result.success).toBe(false);
    expect(result.newState).toBe('chatting'); // stays in current state
    expect(result.reason).toContain('Cannot transition');
    expect(result.reason).toContain('chatting');
    expect(result.reason).toContain('submitted');
  });

  it('should return success: true with already_in_state for same-state transition', () => {
    const result = transition('chatting', 'chatting');
    expect(result.success).toBe(true);
    expect(result.newState).toBe('chatting');
    expect(result.reason).toBe('already_in_state');
  });

  it('should return success: true with already_in_state for terminal same-state', () => {
    const result = transition('escalated', 'escalated');
    expect(result.success).toBe(true);
    expect(result.newState).toBe('escalated');
    expect(result.reason).toBe('already_in_state');
  });
});

describe('isTerminalState', () => {
  it('should return true for escalated', () => {
    expect(isTerminalState('escalated')).toBe(true);
  });

  it('should return true for abandoned', () => {
    expect(isTerminalState('abandoned')).toBe(true);
  });

  it('should return false for chatting', () => {
    expect(isTerminalState('chatting')).toBe(false);
  });

  it('should return false for extracting', () => {
    expect(isTerminalState('extracting')).toBe(false);
  });

  it('should return false for confirmed', () => {
    expect(isTerminalState('confirmed')).toBe(false);
  });

  it('should return false for submitted', () => {
    expect(isTerminalState('submitted')).toBe(false);
  });
});

describe('determineNextState', () => {
  it('should transition chatting -> extracting when extraction is complete', () => {
    expect(determineNextState('chatting', true, 3)).toBe('extracting');
  });

  it('should stay chatting when extraction is not complete', () => {
    expect(determineNextState('chatting', false, 3)).toBe('chatting');
  });

  it('should stay in terminal state regardless of extraction', () => {
    expect(determineNextState('escalated', true, 1)).toBe('escalated');
    expect(determineNextState('abandoned', true, 1)).toBe('abandoned');
  });

  it('should stay submitted regardless of extraction', () => {
    expect(determineNextState('submitted', true, 1)).toBe('submitted');
  });

  it('should stay confirmed regardless of extraction', () => {
    expect(determineNextState('confirmed', true, 1)).toBe('confirmed');
  });

  it('should stay chatting when turnCount >= maxTurns', () => {
    expect(determineNextState('chatting', false, 15, 15)).toBe('chatting');
  });

  it('should stay chatting when turnCount exceeds maxTurns even with extraction', () => {
    // maxTurns check runs before extraction check in the code
    expect(determineNextState('chatting', true, 16, 15)).toBe('chatting');
  });

  it('should use default maxTurns of 15', () => {
    expect(determineNextState('chatting', true, 14)).toBe('extracting');
    expect(determineNextState('chatting', true, 15)).toBe('chatting');
  });

  it('should handle extracting state - stays extracting', () => {
    // extracting is not chatting, confirmed, submitted, or terminal
    // so it falls through to return currentState
    expect(determineNextState('extracting', true, 3)).toBe('extracting');
    expect(determineNextState('extracting', false, 3)).toBe('extracting');
  });
});
