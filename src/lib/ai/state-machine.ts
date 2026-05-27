export const SESSION_STATES = ['chatting', 'extracting', 'confirmed', 'submitted'] as const;
export const TERMINAL_STATES = ['escalated', 'abandoned'] as const;
export const ALL_STATES = [...SESSION_STATES, ...TERMINAL_STATES] as const;

export type SessionState = (typeof ALL_STATES)[number];

// Valid state transitions
const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  chatting: ['extracting', 'escalated', 'abandoned'],
  extracting: ['chatting', 'confirmed', 'escalated', 'abandoned'],
  confirmed: ['submitted', 'chatting', 'escalated', 'abandoned'],
  submitted: [],
  escalated: [],
  abandoned: [],
} as const;

export interface TransitionResult {
  success: boolean;
  newState: SessionState;
  reason?: string;
}

export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function transition(current: SessionState, target: SessionState): TransitionResult {
  if (current === target) {
    return { success: true, newState: current, reason: 'already_in_state' };
  }

  if (!canTransition(current, target)) {
    return {
      success: false,
      newState: current,
      reason: `Cannot transition from '${current}' to '${target}'`,
    };
  }

  return { success: true, newState: target };
}

export function isTerminalState(state: SessionState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

// Determine next state based on extraction completeness and turn count
export function determineNextState(
  currentState: SessionState,
  extractionComplete: boolean,
  turnCount: number,
  maxTurns: number = 15,
): SessionState {
  if (isTerminalState(currentState)) return currentState;
  if (currentState === 'submitted') return currentState;
  if (currentState === 'confirmed') return currentState;

  // Per D-04: auto-suggest escalation after 15 turns (handled at API layer,
  // but state machine tracks readiness)
  if (turnCount >= maxTurns && currentState === 'chatting') {
    return currentState; // Stay chatting but API layer will suggest escalation
  }

  if (extractionComplete && currentState === 'chatting') {
    return 'extracting';
  }

  return currentState;
}
