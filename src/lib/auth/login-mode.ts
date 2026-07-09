/**
 * Which login UI the admin login page renders.
 *
 * The admin console is Google-only by policy; the password form exists as a
 * fallback, not a peer. It renders only when Google OIDC is not configured
 * (dev/preview/bootstrap — so a deploy can never lock everyone out) or when
 * the URL carries the `?password=1` break-glass override for a Google outage.
 */
export type LoginMode = "google" | "password";

export function resolveLoginMode(input: {
  googleEnabled: boolean;
  /** Raw `password` search param as Next delivers it (string | string[] | undefined). */
  passwordParam: string | string[] | undefined;
}): LoginMode {
  if (!input.googleEnabled) return "password";
  return input.passwordParam === "1" ? "password" : "google";
}
