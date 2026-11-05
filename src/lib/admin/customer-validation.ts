/**
 * Input checks for the customer create/edit forms and their API routes, so a
 * typo like "423-555-01" or "12" can't become a customer's phone number.
 * Pure — shared by the dialogs and the route handlers.
 */

/** An extension suffix such as "x12" or "ext. 12" is allowed and not counted. */
const EXTENSION = /\s*(?:ext\.?|x)\s*\d{1,6}\s*$/i;

/**
 * Null when the phone is acceptable (or empty), else the message to show.
 * Accepts a 10-digit US number, 11 digits with a leading 1, or an
 * international number written with a leading "+" (8–15 digits).
 */
export function phoneInputError(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const main = value.replace(EXTENSION, "");
  if (/[^\d\s().+-]/.test(main)) {
    return "Enter a phone number using digits only, like (423) 555-0187.";
  }
  const digits = main.replace(/\D/g, "");
  if (digits.length === 10) return null;
  if (digits.length === 11 && digits.startsWith("1")) return null;
  if (main.startsWith("+") && digits.length >= 8 && digits.length <= 15) return null;
  return "Enter a 10-digit phone number, like (423) 555-0187.";
}

/**
 * The message a form shows for a failed save. Our own 400/409 messages are
 * written for people and pass through; anything else (a 500, a rate limit, a
 * network failure) becomes the human fallback, never a raw server string.
 */
export function saveErrorMessage(
  status: number | null,
  body: unknown,
  fallback: string,
): string {
  if (status === 400 || status === 409 || status === 422) {
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}
