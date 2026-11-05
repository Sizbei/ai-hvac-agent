import { describe, it, expect } from 'vitest';
import { selectLabel } from './select-label';

const OPTS = [
  { value: 'a89e5fac-0000-4000-8000-000000000001', label: 'Better — $367.92' },
  { value: 'name', label: 'Name (A–Z)' },
];

describe('selectLabel', () => {
  it('returns the label of the picked option, not its value', () => {
    expect(selectLabel(OPTS, 'a89e5fac-0000-4000-8000-000000000001', 'Pick')).toBe('Better — $367.92');
    expect(selectLabel(OPTS, 'name', 'Sort')).toBe('Name (A–Z)');
  });

  it('falls back for empty, null or unknown values instead of leaking them', () => {
    expect(selectLabel(OPTS, '', 'Select a material')).toBe('Select a material');
    expect(selectLabel(OPTS, null, 'Select a material')).toBe('Select a material');
    expect(selectLabel(OPTS, '42f2b837-74b3-0000', 'Select a material')).toBe('Select a material');
    expect(selectLabel(OPTS, '__manual__', 'Manual entry')).toBe('Manual entry');
  });
});
