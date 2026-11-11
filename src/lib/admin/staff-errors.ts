/**
 * Human copy for failed staff/invite saves, keyed by the API error code.
 * The UI never shows the server's raw message.
 */
import { NO_BILLING_ENTRY, seatLimitError } from "./billing-entry";

/** Copy for a refusal on the platform owner's account (403 PLATFORM_PROTECTED).
 * The API routes send it as the message; the dialogs show it by code. */
export const PLATFORM_PROTECTED_MESSAGE =
  "This account is managed by the platform owner and can’t be changed here.";
const STAFF_ERROR_COPY: Record<string, string> = {
  SEAT_LIMIT_REACHED: seatLimitError(NO_BILLING_ENTRY),
  EMAIL_CONFLICT: "Someone on your team already uses this email.",
  INVITE_EXISTS: "There's already a pending invite for this email. Revoke it first to send a new one.",
  FORBIDDEN: "Only a super admin can manage admin accounts.",
  PLATFORM_PROTECTED: PLATFORM_PROTECTED_MESSAGE,
  LAST_ADMIN: "This is your last active admin. Make someone else an admin first.",
  SELF_MUTATION_FORBIDDEN: "You can't change your own role or deactivate yourself.",
  RATE_LIMITED: "Too many changes in a row. Wait a minute and try again.",
  NOT_FOUND: "This person is no longer on your team. Refresh the page.",
  VALIDATION_ERROR: "Check the fields and try again.",
};

/** `seatLimitCopy`: the viewer's SEAT_LIMIT_REACHED line (`seatLimitError`), which
 * names who handles billing or offers the upgrade; omitted, the copy stays neutral. */
export function staffErrorMessage(body: unknown, fallback: string, seatLimitCopy?: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const code = (body as { error?: { code?: unknown } }).error?.code;
  if (code === "SEAT_LIMIT_REACHED" && seatLimitCopy) return seatLimitCopy;
  return (typeof code === "string" && STAFF_ERROR_COPY[code]) || fallback;
}
