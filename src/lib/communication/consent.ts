/**
 * Outbound communication consent gate (TCPA / CAN-SPAM foundation).
 *
 * Every customer-facing send MUST pass through checkSendAllowed before it leaves
 * the system. It reads the per-customer communicationPreferences (global
 * do-not-contact, per-channel toggles, per-type toggles, timezone) and enforces
 * quiet hours for non-transactional message types. This is the safety primitive
 * Stage 1 of the roadmap exists to provide — without it, every later AI-initiated
 * or cron-driven send risks a compliance violation.
 *
 * Inbound STOP/HELP/START keyword handling lives here too so the SMS webhook can
 * suppress a customer BEFORE the conversational agent ever sees the message.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers, communicationPreferences } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { blindIndex } from "@/lib/crypto";
import { normalizePhone } from "@/lib/admin/crm-queries";
import type { communicationTriggerTypeEnum } from "@/lib/db/schema";

export type CommChannel = "sms" | "email" | "voice";
export type CommTrigger = (typeof communicationTriggerTypeEnum.enumValues)[number];

/** Quiet-hours window in the customer's local time: [21:00, 24) ∪ [0, 08:00). */
const QUIET_START_HOUR = 21;
const QUIET_END_HOUR = 8;
const DEFAULT_TZ = "America/New_York";

type PrefToggle =
  | "appointmentReminders"
  | "automatedConfirmations"
  | "reviewRequests"
  | "marketingMessages";

interface TriggerRule {
  /** The per-type preference toggle that must be on, or null = always allowed. */
  readonly toggle: PrefToggle | null;
  /** Whether quiet hours apply (transactional/urgent messages are exempt). */
  readonly quietHours: boolean;
}

/** Map every trigger to its consent category. Transactional confirmations and
 *  en-route/arrival are time-sensitive and exempt from quiet hours; reminders,
 *  review requests, and follow-ups are quiet-hours-gated. */
export const TRIGGER_RULES: Record<CommTrigger, TriggerRule> = {
  appointment_scheduled: { toggle: "automatedConfirmations", quietHours: false },
  appointment_reminder_24h: { toggle: "appointmentReminders", quietHours: true },
  appointment_reminder_2h: { toggle: "appointmentReminders", quietHours: true },
  appointment_rescheduled: { toggle: "automatedConfirmations", quietHours: false },
  appointment_cancelled: { toggle: "automatedConfirmations", quietHours: false },
  technician_enroute: { toggle: "automatedConfirmations", quietHours: false },
  technician_arrived: { toggle: "automatedConfirmations", quietHours: false },
  job_completed: { toggle: "automatedConfirmations", quietHours: false },
  review_request: { toggle: "reviewRequests", quietHours: true },
  follow_up: { toggle: "marketingMessages", quietHours: true },
  escalation: { toggle: null, quietHours: false },
  // Money-loop triggers. estimate_sent + payment_receipt are TRANSACTIONAL
  // (an approval link the customer is waiting on; a receipt for money just
  // taken) — exempt from quiet hours and gated only by automatedConfirmations.
  // invoice_overdue is a dunning nudge — quiet-hours-gated like other reminders.
  estimate_sent: { toggle: "automatedConfirmations", quietHours: false },
  payment_receipt: { toggle: "automatedConfirmations", quietHours: false },
  invoice_overdue: { toggle: "appointmentReminders", quietHours: true },
  // Lead-gen warranty-expiry nudge — marketing-ish: gated by the marketing
  // preference (off by default) and quiet-hours-respecting.
  warranty_expiring: { toggle: "marketingMessages", quietHours: true },
};

/** Preference defaults when a customer has no preferences row yet — mirrors the
 *  DB column defaults so "no row" and "default row" behave identically. */
const DEFAULT_PREFS = {
  smsEnabled: true,
  emailEnabled: true,
  voiceEnabled: false,
  appointmentReminders: true,
  automatedConfirmations: true,
  reviewRequests: true,
  marketingMessages: false,
  doNotContact: false,
  timezone: DEFAULT_TZ as string | null,
};

export interface SendDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

/** The local hour (0-23) for `now` in the given IANA timezone; falls back to the
 *  default tz if the stored timezone is invalid. */
export function localHour(now: Date, timezone: string | null): number {
  const tz = timezone ?? DEFAULT_TZ;
  const read = (zone: string): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: zone,
    }).format(now);
    return parseInt(parts, 10);
  };
  try {
    return read(tz);
  } catch {
    return read(DEFAULT_TZ);
  }
}

/** True if `now` is within the customer's quiet-hours window. */
export function isQuietHours(now: Date, timezone: string | null): boolean {
  const hour = localHour(now, timezone);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/**
 * Decide whether a single outbound message may be sent. Returns allowed:false
 * with a machine-readable reason when blocked. A null customerId means we can't
 * resolve consent (e.g. an ad-hoc admin send to a raw number) — allowed, but the
 * caller should prefer passing a customerId so consent is enforced.
 */
export async function checkSendAllowed(params: {
  readonly organizationId: string;
  readonly customerId: string | null;
  readonly channel: CommChannel;
  readonly triggerType: CommTrigger;
  readonly now?: Date;
}): Promise<SendDecision> {
  const { organizationId, customerId, channel, triggerType } = params;
  const now = params.now ?? new Date();

  if (!customerId) {
    return { allowed: true };
  }

  const [row] = await db
    .select()
    .from(communicationPreferences)
    .where(
      and(
        eq(communicationPreferences.organizationId, organizationId),
        eq(communicationPreferences.customerId, customerId),
      ),
    )
    .limit(1);

  const prefs = row ?? DEFAULT_PREFS;

  if (prefs.doNotContact) {
    return { allowed: false, reason: "do_not_contact" };
  }

  const channelOn =
    channel === "sms"
      ? prefs.smsEnabled
      : channel === "email"
        ? prefs.emailEnabled
        : prefs.voiceEnabled;
  if (!channelOn) {
    return { allowed: false, reason: `channel_disabled:${channel}` };
  }

  const rule = TRIGGER_RULES[triggerType];
  if (rule.toggle && !prefs[rule.toggle]) {
    return { allowed: false, reason: `type_disabled:${triggerType}` };
  }

  if (rule.quietHours && isQuietHours(now, prefs.timezone)) {
    return { allowed: false, reason: "quiet_hours" };
  }

  return { allowed: true };
}

// ── Inbound SMS keyword handling (STOP / HELP / START) ─────────────────────────

export type SmsKeyword = "stop" | "start" | "help" | null;

// CTIA/Twilio standard opt-out, help, and opt-in keywords.
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START_WORDS = new Set(["start", "unstop", "yes"]);
const HELP_WORDS = new Set(["help", "info"]);

/** Classify a raw inbound SMS body as a compliance keyword, or null. Matches the
 *  whole trimmed message (case/punctuation-insensitive) — "stop." counts, but
 *  "please stop calling" does not, mirroring carrier behavior. */
export function classifySmsKeyword(body: string): SmsKeyword {
  const t = body.trim().toLowerCase().replace(/[.!?,]/g, "");
  if (STOP_WORDS.has(t)) return "stop";
  if (START_WORDS.has(t)) return "start";
  if (HELP_WORDS.has(t)) return "help";
  return null;
}

/**
 * Set (or clear) do-not-contact for the customer matching a phone number, by
 * blind-index lookup. Upserts the preferences row. Returns true if a customer
 * matched. Used by the inbound STOP/START handler.
 */
export async function setDoNotContactByPhone(
  organizationId: string,
  phone: string,
  doNotContact: boolean,
): Promise<boolean> {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return false;
  }
  const hash = blindIndex(normalized);
  const [cust] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(withTenant(customers, organizationId, eq(customers.phoneHash, hash)))
    .limit(1);

  if (!cust) {
    return false;
  }

  await db
    .insert(communicationPreferences)
    .values({ organizationId, customerId: cust.id, doNotContact, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [
        communicationPreferences.organizationId,
        communicationPreferences.customerId,
      ],
      set: { doNotContact, updatedAt: new Date() },
    });
  return true;
}
