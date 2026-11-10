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
import { communicationPreferences } from "@/lib/db/schema";
import { findCustomerMatchCandidates } from "@/lib/admin/crm-queries";
import type { CustomerMatchCandidate } from "@/lib/admin/customer-match";
import type { communicationTriggerTypeEnum } from "@/lib/db/schema";
import { getFeatures } from "@/lib/tenancy/features";
import { errorCode, logger } from "@/lib/logger";

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
  // M3b: invoice link on finalize — transactional, same rule as estimate_sent.
  invoice_sent: { toggle: "automatedConfirmations", quietHours: false },
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
 * Trigger types that an org can switch off via `organizations.feature_flags`.
 * Scoped narrowly to `review_request`: that pipeline (a technician marking a
 * job complete -> createReviewRequest -> queueCommunicationJob) has no
 * session/actor in the loop, so this is the one place downstream of it that
 * knows the organizationId AND runs before every send. Appointment
 * confirmations/reminders, receipts and dunning are not switchable.
 */
const FEATURE_GATED_TRIGGERS: ReadonlySet<CommTrigger> = new Set([
  "review_request",
]);

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

  if (FEATURE_GATED_TRIGGERS.has(triggerType)) {
    // Fail closed: a lookup error blocks the send rather than letting it through.
    try {
      const features = await getFeatures(organizationId);
      if (!features.reviewRequests) {
        return { allowed: false, reason: "review_requests_off" };
      }
    } catch (error) {
      logger.error(
        { code: errorCode(error), organizationId },
        "Feature lookup failed; blocking review request",
      );
      return { allowed: false, reason: "review_requests_off" };
    }
  }

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

/** Descending date order with NULLs last (mirrors `customer-match.ts`). */
function compareDatesDesc(a: Date | null, b: Date | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b.getTime() - a.getTime();
}

/**
 * The single row an SMS START may un-suppress, or null when there is none.
 *
 * Deliberately NOT `pickCustomerMatch`: its rule 2 hands the *do-not-service*
 * row the win, so START would re-open the one row the block exists to keep
 * closed. START drops blocked and archived rows entirely, then applies the
 * remaining order — most recently active, newest, id as the determinism
 * backstop. Pure, so the pick is unit-testable without a database.
 */
export function pickStartTarget(
  candidates: readonly CustomerMatchCandidate[],
): string | null {
  const eligible = candidates.filter(
    (candidate) =>
      candidate.anonymizedAt === null &&
      candidate.archivedAt === null &&
      !candidate.doNotService,
  );
  if (eligible.length === 0) return null;

  const [winner] = [...eligible].sort((a, b) => {
    const byActivity = compareDatesDesc(a.lastActivityAt, b.lastActivityAt);
    if (byActivity !== 0) return byActivity;
    const byCreated = compareDatesDesc(a.createdAt, b.createdAt);
    if (byCreated !== 0) return byCreated;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return winner.id;
}

/** The do-not-contact upsert for one customer, as an un-awaited statement so
 *  callers can either await it directly or hand it to `db.batch()`. */
function buildDoNotContactUpsert(
  organizationId: string,
  customerId: string,
  doNotContact: boolean,
  now: Date,
) {
  return db
    .insert(communicationPreferences)
    .values({ organizationId, customerId, doNotContact, updatedAt: now })
    .onConflictDoUpdate({
      target: [
        communicationPreferences.organizationId,
        communicationPreferences.customerId,
      ],
      set: { doNotContact, updatedAt: now },
    });
}

/**
 * Set (or clear) do-not-contact for the customers matching a phone number.
 * Returns true if any row was written. Used by the inbound STOP/START handler
 * (`app/api/sms/incoming/route.ts`), which distinguishes the two directions by
 * this flag.
 *
 * The two directions are NOT symmetric (SPEC §3.5). A phone number no longer
 * resolves to a single customer row — FieldPulse-linked rows may legitimately
 * share one (an accounts-payable line covering several businesses):
 *
 * - **STOP fans out** to every matching row, fail-closed. Silencing one
 *   business while still texting the others on that number is a compliance
 *   defect, not a UX one.
 * - **START applies to exactly one row** and never touches siblings: one texter
 *   must not be able to revoke third parties' opt-outs, which is the same class
 *   of harm in the direction the affected party cannot undo.
 *
 * Both directions take candidates from the SAME resolver — only the ordering
 * differs.
 */
export async function setDoNotContactByPhone(
  organizationId: string,
  phone: string,
  doNotContact: boolean,
): Promise<boolean> {
  // limit: null — STOP is a fan-out, not a winner selection. The resolver's
  // default LIMIT is only safe when picking one winner; a capped STOP would
  // silence 50 businesses on a shared number and keep texting the 51st.
  const candidates = await findCustomerMatchCandidates(
    organizationId,
    { email: null, phone },
    { limit: null },
  );
  if (candidates.length === 0) {
    return false;
  }
  const now = new Date();

  if (!doNotContact) {
    // START — exactly one row, never a sibling.
    const targetId = pickStartTarget(candidates);
    if (!targetId) return false;
    await buildDoNotContactUpsert(organizationId, targetId, false, now);
    return true;
  }

  // STOP — every row on the number, in ONE round trip. neon-http has no
  // interactive transactions (`db.transaction()` throws — AGENTS.md), so this
  // is a batch, which the driver executes as a single non-interactive one.
  const statements = candidates.map((candidate) =>
    buildDoNotContactUpsert(organizationId, candidate.id, true, now),
  );
  type BatchStmt = (typeof statements)[number];
  await db.batch(statements as unknown as [BatchStmt, ...BatchStmt[]]);
  return true;
}
