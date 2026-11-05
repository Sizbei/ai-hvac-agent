/**
 * Human copy for failed staff/invite saves, keyed by the API error code.
 * The UI never shows the server's raw message.
 */
const STAFF_ERROR_COPY: Record<string, string> = {
  SEAT_LIMIT_REACHED:
    "Your plan has no free seats. Deactivate someone or upgrade the plan to add more.",
  EMAIL_CONFLICT: "Someone on your team already uses this email.",
  INVITE_EXISTS: "There's already a pending invite for this email. Revoke it first to send a new one.",
  FORBIDDEN: "Only a super admin can manage admin accounts.",
  LAST_ADMIN: "This is your last active admin. Make someone else an admin first.",
  SELF_MUTATION_FORBIDDEN: "You can't change your own role or deactivate yourself.",
  RATE_LIMITED: "Too many changes in a row. Wait a minute and try again.",
  NOT_FOUND: "This person is no longer on your team. Refresh the page.",
  VALIDATION_ERROR: "Check the fields and try again.",
};

export function staffErrorMessage(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const code = (body as { error?: { code?: unknown } }).error?.code;
  return (typeof code === "string" && STAFF_ERROR_COPY[code]) || fallback;
}
