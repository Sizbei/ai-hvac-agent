/**
 * Human copy for the technician sign-in form (pure). Server text is never
 * shown: the status and code pick one of these lines.
 */
export const LOGIN_NO_MATCH = "That email and password don't match.";
export const LOGIN_TOO_MANY = "Too many tries. Wait a minute, then try again.";
export const LOGIN_FAILED = "Couldn't sign you in. Try again.";
export const LOGIN_OFFLINE = "Couldn't reach the server. Try again.";

export function techLoginErrorCopy(status: number | null, code: string | null | undefined): string {
  if (status === null) return LOGIN_OFFLINE;
  if (status === 401 || code === "INVALID_CREDENTIALS") return LOGIN_NO_MATCH;
  if (status === 429 || code === "RATE_LIMITED") return LOGIN_TOO_MANY;
  return LOGIN_FAILED;
}
