/**
 * Human copy for settings save errors. The settings PATCH answers a zod
 * failure with VALIDATION_ERROR and `details.path` (the failing field's
 * path); the UI turns that into "Check the X." instead of showing zod text
 * like "Too big: expected number to be <=23".
 */

const FIELD_COPY: Record<string, string> = {
  companyName: "Check the company name. It can be up to 120 characters.",
  logoUrl: "Check the logo URL. It must start with https://.",
  primaryColor: "Check the brand colour. Use a hex value like #2563eb.",
  welcomeMessage: "Check the welcome message. It can be up to 500 characters.",
  "businessInfo.serviceArea": "Check the service area. It can be up to 500 characters.",
  "businessInfo.businessHours": "Check the business hours. They can be up to 300 characters.",
  "businessInfo.phone": "Check the phone number. It can be up to 40 characters.",
  "businessInfo.email": "Check the contact email. Use an address like office@yourcompany.com.",
  "businessInfo.website": "Check the website. It must start with https://.",
  "businessInfo.licensedInsured": "Check the licensing statement. It can be up to 300 characters.",
  "businessInfo.paymentMethods": "Check the payment methods. They can be up to 300 characters.",
  allowedOrigins: "Check the allowed websites. Use a domain like acme.com or *.acme.com.",
  chatTokenBudget: "Check the conversation budget. It's outside the allowed range.",
  chatMaxTurns: "Check the maximum turns. It's outside the allowed range.",
  "afterHoursConfig.startHour": "After-hours must begin at a whole hour from 0 to 23.",
  "afterHoursConfig.endHour": "The business day must begin at a whole hour from 0 to 23.",
  "afterHoursConfig.timezone": "Choose a timezone from the list.",
};

const SAVE_FALLBACK = "Couldn't save settings. Please try again.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Copy for a validation issue path such as ["afterHoursConfig", "startHour"]. */
export function settingsFieldErrorCopy(path: readonly PropertyKey[]): string | null {
  // Array entries (allowedOrigins.3) share their parent's copy.
  const named = path.filter((p): p is string => typeof p === "string");
  for (let n = named.length; n > 0; n--) {
    const copy = FIELD_COPY[named.slice(0, n).join(".")];
    if (copy) return copy;
  }
  return null;
}

/** Copy for a failed settings PATCH body. Never echoes the server's message. */
export function settingsSaveErrorMessage(body: unknown): string {
  if (!isRecord(body) || !isRecord(body.error)) return SAVE_FALLBACK;
  const { code, details } = body.error;
  if (code === "RATE_LIMITED") return "Too many saves in a row. Wait a minute and try again.";
  if (code === "VALIDATION_ERROR") {
    const path = isRecord(details) && Array.isArray(details.path) ? (details.path as PropertyKey[]) : [];
    return settingsFieldErrorCopy(path) ?? "Some settings aren't valid. Check the fields and try again.";
  }
  return SAVE_FALLBACK;
}
