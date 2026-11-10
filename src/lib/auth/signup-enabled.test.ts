import { describe, expect, it } from 'vitest';
import { isSignupEnabled } from './signup-enabled';

describe('isSignupEnabled', () => {
  it('is on when the flag is unset', () => {
    expect(isSignupEnabled(undefined)).toBe(true);
  });
  it('is off only for the exact string "false"', () => {
    expect(isSignupEnabled('false')).toBe(false);
  });
  it.each(['true', '', '0', 'FALSE', ' false', 'no'])('stays on for %j', (v) => {
    expect(isSignupEnabled(v)).toBe(true);
  });
});
