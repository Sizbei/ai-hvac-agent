/**
 * Check numbers are short identifiers, never free text: letters, digits and
 * dashes, 1–32 characters. Shared by the tech and office payment routes and
 * by both forms, so a client refuses "#1234" before the server does.
 */
export const CHECK_NUMBER_PATTERN = /^[A-Za-z0-9-]{1,32}$/;
export const CHECK_NUMBER_COPY = "Use letters, numbers and dashes for the check number.";

export function isValidCheckNumber(value: string): boolean {
  return CHECK_NUMBER_PATTERN.test(value.trim());
}
