/**
 * The mid-chat issue chips shown before the issue type is known (and under the
 * provider-down fallback). Each `message` is phrased to hit a deterministic
 * intake intent in knowledge-base.ts, so tapping one moves the intake forward
 * even when the model is unavailable. issue-suggestions.test.ts pins that.
 */
export interface IssueSuggestion {
  readonly label: string;
  readonly message: string;
}

export const ISSUE_SUGGESTIONS: readonly IssueSuggestion[] = [
  { label: 'AC not cooling', message: 'My air conditioner is running but not cooling — it just blows warm air.' },
  { label: 'No heat', message: 'My furnace is running but the house is not getting warm.' },
  { label: 'Thermostat issue', message: 'My thermostat has no display.' },
];
