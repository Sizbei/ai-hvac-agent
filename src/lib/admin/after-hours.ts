/**
 * After-hours detection + surcharge (ServiceTitan-style emergency/after-hours
 * pricing). A request that arrives outside business hours (after 6pm, before
 * 8am, or on a weekend by default) is flagged and carries an after-hours
 * surcharge so dispatch + the customer record reflect the higher rate.
 *
 * All time math is done in the ORG's configured IANA timezone (a request's
 * "after hours" depends on the company's local clock, not the server's or the
 * customer's). Pure — no Date.now(), no I/O — so it tests deterministically.
 */
import { z } from "zod";

/** Validate an IANA timezone by attempting to construct a formatter for it. */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const afterHoursConfigSchema = z
  .object({
    enabled: z.boolean(),
    // Business day: [endHour, startHour) is normal; outside it is after-hours.
    // e.g. startHour 18 (6pm), endHour 8 (8am) → after-hours is 6pm–8am.
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(0).max(23),
    weekendsAreAfterHours: z.boolean(),
    timezone: z.string().refine(isValidTimezone, "Invalid IANA timezone"),
    // Flat after-hours fee (whole dollars) and the multiplier applied to it for
    // an emergency-urgency after-hours call.
    flatFee: z.number().min(0).max(100000),
    emergencyMultiplier: z.number().min(1).max(10),
  })
  .strict();

export type AfterHoursConfig = z.infer<typeof afterHoursConfigSchema>;

export const DEFAULT_AFTER_HOURS_CONFIG: AfterHoursConfig = {
  enabled: true,
  startHour: 18, // 6pm
  endHour: 8, // 8am
  weekendsAreAfterHours: true,
  timezone: "America/New_York",
  flatFee: 150,
  emergencyMultiplier: 1.5,
};

/** Resolve a stored (jsonb) value into a valid config, defaulting on absence/junk. */
export function resolveAfterHoursConfig(
  stored: unknown,
): AfterHoursConfig {
  if (stored == null) return DEFAULT_AFTER_HOURS_CONFIG;
  const parsed = afterHoursConfigSchema.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_AFTER_HOURS_CONFIG;
}

// Extract the hour (0-23) and weekday (0=Sun..6=Sat) of an instant in a tz.
function partsInTimezone(at: Date, timezone: string): { hour: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
    weekday: "short",
  });
  const parts = fmt.formatToParts(at);
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  // hour12:false can render midnight as "24"; normalize to 0.
  const hour = Number(hourStr) % 24;
  const wdStr = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const WEEKDAYS: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return { hour, weekday: WEEKDAYS[wdStr] ?? 0 };
}

/** Whether `at` falls in the org's after-hours window. */
export function isAfterHours(at: Date, config: AfterHoursConfig): boolean {
  if (!config.enabled) return false;
  const { hour, weekday } = partsInTimezone(at, config.timezone);

  if (config.weekendsAreAfterHours && (weekday === 0 || weekday === 6)) {
    return true;
  }

  // After-hours when the hour is at/after startHour OR before endHour
  // (the window wraps past midnight: e.g. 18:00–08:00).
  if (config.startHour > config.endHour) {
    return hour >= config.startHour || hour < config.endHour;
  }
  // Non-wrapping window (unusual, but supported): after-hours strictly inside.
  return hour >= config.startHour && hour < config.endHour;
}

/**
 * The surcharge (whole dollars) for a request: 0 when not after-hours, the flat
 * fee otherwise, multiplied by the emergency multiplier when urgency is
 * "emergency".
 */
export function computeSurcharge(
  afterHours: boolean,
  urgency: string | null,
  config: AfterHoursConfig,
): number {
  if (!afterHours) return 0;
  const base = config.flatFee;
  const amount = urgency === "emergency" ? base * config.emergencyMultiplier : base;
  return Math.round(amount);
}
