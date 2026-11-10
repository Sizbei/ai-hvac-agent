/**
 * Self-serve signup switch. `NEXT_PUBLIC_SIGNUP_ENABLED=false` turns it off:
 * the sign-in page hides "Create an account" and /signup + /api/auth/signup/*
 * 404. Anything else (including unset) leaves signup on.
 *
 * NEXT_PUBLIC_* is inlined at BUILD time, so callers must pass the literal
 * `process.env.NEXT_PUBLIC_SIGNUP_ENABLED` (see `signupEnabledFromEnv`).
 */
export function isSignupEnabled(flag: string | undefined): boolean {
  return flag !== 'false';
}

export function signupEnabledFromEnv(): boolean {
  return isSignupEnabled(process.env.NEXT_PUBLIC_SIGNUP_ENABLED);
}
