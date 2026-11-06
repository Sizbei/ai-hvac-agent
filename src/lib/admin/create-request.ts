/**
 * Office booking ("New request" on /admin/requests) — the PURE pieces.
 *
 * Body validation + normalisation for POST /api/admin/requests, the "which
 * scheduling path" decision, and the client-side payload builder the dialog
 * uses. No I/O and no server-only imports, so the dialog and the route share
 * one contract and both are unit-tested here. The DB write lives in
 * create-request-queries.ts.
 */
import { z } from "zod";
import {
  issueTypeValues,
  jobTypeValues,
  urgencyValues,
  systemTypeValues,
  preferredWindowValues,
  isPhoneComplete,
  jobTypeForIssue,
  type IssueType,
  type JobType,
} from "@/lib/ai/extraction-schema";
import { isRealIsoDate } from "@/lib/admin/calendar-time";
import { WINDOW_ENDED_MESSAGE, windowHasEnded } from "@/lib/admin/window-ended";
import { sanitizeName, sanitizePhone, sanitizeEmail } from "@/lib/ai/sanitize-fields";

/** The bands the availability surface reports — what the office can book. */
export const BOOKABLE_WINDOWS = ["morning", "afternoon", "evening"] as const;
export type BookableWindow = (typeof BOOKABLE_WINDOWS)[number];

export const DESCRIPTION_MAX = 2000;
const ADDRESS_MAX = 500;
const NAME_MAX = 200;
const ACCESS_NOTES_MAX = 1000;
/** How far ahead the office may book (maintenance is often months out). */
export const SCHEDULE_MAX_DAYS_AHEAD = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Office-facing labels for the issue (symptom) select. */
export const ISSUE_TYPE_LABELS: Record<IssueType, string> = {
  heating_not_working: "Heating not working",
  cooling_not_working: "Cooling not working",
  thermostat_issue: "Thermostat",
  air_quality: "Indoor air quality",
  strange_noises: "Strange noises",
  water_leak: "Water leak",
  maintenance: "Maintenance",
  installation: "Installation / replacement",
  refrigeration: "Refrigeration",
  ice_machine: "Ice machine",
  boiler: "Boiler",
  commercial_appliance: "Commercial appliance",
  other: "Other",
};

/** Same wording as the request detail sheet's job-type labels. */
export const JOB_TYPE_LABELS: Record<JobType, string> = {
  no_heat: "No heat",
  no_cool: "No cooling",
  service_call: "Service call",
  maintenance: "Maintenance",
  install: "Installation",
  estimate: "Estimate",
  warranty: "Warranty",
  diagnostic: "Diagnostic",
  inspection: "Inspection",
};

export const URGENCY_LABELS: Record<(typeof urgencyValues)[number], string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  emergency: "Emergency",
};

export const WINDOW_LABELS: Record<BookableWindow, string> = {
  morning: "Morning (8am–12pm)",
  afternoon: "Afternoon (12–4pm)",
  evening: "Evening (4–8pm)",
};

// ── Server body schema ─────────────────────────────────────────────────────

/** Trim; an all-whitespace string becomes undefined (treated as omitted). */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => {
      const t = v?.trim();
      return t ? t : null;
    });

const requiredText = (max: number, label: string) =>
  z
    .string({ error: `${label} is required.` })
    .transform((v) => v.trim())
    .pipe(
      z
        .string()
        .min(1, `${label} is required.`)
        .max(max, `${label} must be ${max} characters or fewer.`),
    );

const inlineCustomerSchema = z.object({
  name: requiredText(NAME_MAX, "Customer name"),
  phone: optionalText(40).refine(
    (v) => v === null || isPhoneComplete(v),
    "Phone must be a 10-digit US number.",
  ),
  email: optionalText(254).refine(
    (v) => v === null || z.email().safeParse(v).success,
    "Email address isn't valid.",
  ),
});

const scheduleSchema = z.object({
  isoDay: z
    .string()
    .refine(isRealIsoDate, "Pick a real date for the arrival window."),
  window: z.enum(BOOKABLE_WINDOWS, "Pick a morning, afternoon or evening window."),
  technicianId: z
    .uuid("Technician isn't valid.")
    .optional()
    .nullable()
    .transform((v) => v ?? null),
});

const bodySchema = z.object({
  customerId: z.uuid("Customer isn't valid.").optional().nullable(),
  customer: inlineCustomerSchema.optional().nullable(),
  address: requiredText(ADDRESS_MAX, "Address"),
  issueType: z.enum(issueTypeValues, "Pick what the issue is."),
  jobType: z.enum(jobTypeValues, "Job type isn't valid.").optional().nullable(),
  urgency: z.enum(urgencyValues, "Pick an urgency."),
  description: requiredText(DESCRIPTION_MAX, "Description"),
  accessNotes: optionalText(ACCESS_NOTES_MAX),
  systemType: z.enum(systemTypeValues).optional().nullable(),
  preferredWindow: z.enum(preferredWindowValues).optional().nullable(),
  schedule: scheduleSchema.optional().nullable(),
  override: z.boolean().optional(),
  jobTypeId: z.uuid("Job type isn't valid.").optional(),
  contactId: z.uuid("Contact isn't valid.").optional(),
  locationId: z.uuid("Location isn't valid.").optional(),
  tagTypeIds: z.array(z.uuid("Tag isn't valid.")).max(20, "Pick up to 20 tags.").optional(),
});

export type CreateRequestCustomer =
  | { readonly kind: "existing"; readonly customerId: string }
  | {
      readonly kind: "inline";
      readonly name: string;
      readonly phone: string | null;
      readonly email: string | null;
    };

export interface CreateRequestSchedule {
  readonly isoDay: string;
  readonly window: BookableWindow;
  readonly technicianId: string | null;
}

export interface CreateRequestInput {
  readonly customer: CreateRequestCustomer;
  readonly address: string;
  readonly issueType: IssueType;
  readonly jobType: JobType | null;
  readonly urgency: (typeof urgencyValues)[number];
  readonly description: string;
  readonly accessNotes: string | null;
  readonly systemType: (typeof systemTypeValues)[number] | null;
  readonly preferredWindow: (typeof preferredWindowValues)[number] | null;
  readonly schedule: CreateRequestSchedule | null;
  readonly override: boolean;
  readonly jobTypeId: string | null;
  readonly contactId: string | null;
  readonly locationId: string | null;
  readonly tagTypeIds: readonly string[];
}

/** Whether a business-tz ISO day falls in [today − 1, today + max]. Yesterday
 * is allowed so a late-evening booking across the date line isn't refused. */
export function isScheduleDayInRange(isoDay: string, todayIso: string): boolean {
  const diff = (Date.parse(`${isoDay}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / MS_PER_DAY;
  return Number.isFinite(diff) && diff >= -1 && diff <= SCHEDULE_MAX_DAYS_AHEAD;
}

/** The plaintext contact snapshot to encrypt onto the request: the inline
 * customer's fields passed through the SAME sanitizers upsertCustomerByContact
 * applies to the customer row, so both copies match. Null for an existing
 * customer, whose encrypted blobs are copied across as-is. */
export function requestContactSnapshot(customer: CreateRequestCustomer): {
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
} | null {
  if (customer.kind === "existing") return null;
  return {
    name: sanitizeName(customer.name),
    phone: customer.phone ? sanitizePhone(customer.phone) : null,
    email: customer.email ? sanitizeEmail(customer.email) : null,
  };
}

export type ParseResult =
  | { readonly ok: true; readonly data: CreateRequestInput }
  | { readonly ok: false; readonly message: string };

/** Validate + normalise a POST /api/admin/requests body. `todayIso` is the
 * business-tz today, used to bound the schedule day; `now`, when given, also
 * refuses a window that has already ended (the route always passes it). */
export function parseCreateRequestBody(raw: unknown, todayIso: string, now?: Date): ParseResult {
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message =
      issue && /^[A-Z]/.test(issue.message)
        ? issue.message
        : "Check the request details and try again.";
    return { ok: false, message };
  }
  const b = parsed.data;
  const hasId = Boolean(b.customerId);
  const hasInline = Boolean(b.customer);
  if (hasId === hasInline) {
    return { ok: false, message: "Pick a customer or add a new one." };
  }
  if (!hasId && (b.contactId || b.locationId)) {
    return { ok: false, message: "Pick an existing customer to choose a contact or location." };
  }
  if (b.schedule && !isScheduleDayInRange(b.schedule.isoDay, todayIso)) {
    return {
      ok: false,
      message: `Pick a date between yesterday and ${SCHEDULE_MAX_DAYS_AHEAD} days from now.`,
    };
  }
  if (b.schedule && now && windowHasEnded(b.schedule.isoDay, b.schedule.window, now)) {
    return { ok: false, message: WINDOW_ENDED_MESSAGE };
  }
  const customer: CreateRequestCustomer = hasId
    ? { kind: "existing", customerId: b.customerId! }
    : {
        kind: "inline",
        name: b.customer!.name,
        phone: b.customer!.phone,
        email: b.customer!.email,
      };
  return {
    ok: true,
    data: {
      customer,
      address: b.address,
      issueType: b.issueType,
      jobType: b.jobType ?? null,
      urgency: b.urgency,
      description: b.description,
      accessNotes: b.accessNotes,
      systemType: b.systemType ?? null,
      preferredWindow: b.preferredWindow ?? null,
      schedule: b.schedule ?? null,
      override: b.override === true,
      jobTypeId: b.jobTypeId ?? null,
      contactId: b.contactId ?? null,
      locationId: b.locationId ?? null,
      tagTypeIds: b.tagTypeIds ?? [],
    },
  };
}

// ── Decisions ──────────────────────────────────────────────────────────────

export type SchedulePlan =
  | { readonly kind: "none" }
  | { readonly kind: "window_only"; readonly isoDay: string; readonly window: BookableWindow }
  | {
      readonly kind: "assign";
      readonly isoDay: string;
      readonly window: BookableWindow;
      readonly technicianId: string;
    };

/** Which scheduling path a create takes: leave unscheduled, place the window
 * only (no technician — holds band capacity), or place + assign a technician
 * (conflict-checked). */
export function planSchedule(schedule: CreateRequestSchedule | null): SchedulePlan {
  if (!schedule) return { kind: "none" };
  if (!schedule.technicianId) {
    return { kind: "window_only", isoDay: schedule.isoDay, window: schedule.window };
  }
  return {
    kind: "assign",
    isoDay: schedule.isoDay,
    window: schedule.window,
    technicianId: schedule.technicianId,
  };
}

/** An explicit job type wins; otherwise derive it from the issue. */
export function resolveJobType(issueType: IssueType, jobType: JobType | null): JobType {
  return jobType ?? jobTypeForIssue(issueType) ?? "service_call";
}

/** The 409 copy — identical to the reschedule route's so the office reads the
 * same sentence on the calendar and in the create dialog. */
export function scheduleConflictMessage(detail: {
  readonly conflictCount: number;
  readonly outsideAvailability: boolean;
}): string {
  if (detail.outsideAvailability && detail.conflictCount > 0) {
    return "This time overlaps another job and is outside the technician's hours.";
  }
  if (detail.outsideAvailability) {
    return "This time is outside the technician's working hours.";
  }
  return "This time overlaps another job for the technician.";
}

/** Open/capacity counts for one band from an availability payload. */
export function windowAvailability(
  windows: ReadonlyArray<{
    readonly day: string;
    readonly window: string;
    readonly capacity: number;
    readonly available: number;
  }>,
  day: string,
  window: string,
): { readonly capacity: number; readonly available: number } {
  const hit = windows.find((w) => w.day === day && w.window === window);
  return hit
    ? { capacity: hit.capacity, available: hit.available }
    : { capacity: 0, available: 0 };
}

/** "Mon, Nov 2" for a business-tz ISO date. Formatted at UTC noon so the
 * viewer's own timezone can never shift it onto a neighbouring day. */
export function formatIsoDayShort(isoDay: string): string {
  return new Date(`${isoDay}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** The first day with any open band (the dialog's default pick), else the
 * first day, else "" when there are no days. */
export function firstOpenDay(
  days: readonly string[],
  windows: ReadonlyArray<{ readonly day: string; readonly window?: string; readonly available: number }>,
  /** When given, a band that has already ended doesn't count as open. */
  now?: Date,
): string {
  const live = (d: string, w: { readonly window?: string }) =>
    !now || !isBookableWindow(w.window) || !windowHasEnded(d, w.window, now);
  const open = days.find((d) => windows.some((w) => w.day === d && w.available > 0 && live(d, w)));
  return open ?? days.find((d) => !now || BOOKABLE_WINDOWS.some((w) => !windowHasEnded(d, w, now))) ?? days[0] ?? "";
}

function isBookableWindow(w: string | undefined): w is BookableWindow {
  return (BOOKABLE_WINDOWS as readonly string[]).includes(w ?? "");
}

/** The day Add visit opens on: the request's own day when it is offered and
 * still has a band left, else the first open day. */
export function initialVisitDay(
  preferred: string | null,
  days: readonly string[],
  windows: ReadonlyArray<{ readonly day: string; readonly window?: string; readonly available: number }>,
  now: Date,
): string {
  if (preferred && days.includes(preferred) && BOOKABLE_WINDOWS.some((w) => !windowHasEnded(preferred, w, now))) {
    return preferred;
  }
  return firstOpenDay(days, windows, now);
}

// ── Client payload ─────────────────────────────────────────────────────────

/** The dialog's raw form state. Empty string = not chosen. */
export interface CreateRequestDraft {
  readonly customerId: string | null;
  readonly newCustomer: { readonly name: string; readonly phone: string; readonly email: string };
  readonly address: string;
  readonly issueType: string;
  readonly jobType: string;
  readonly urgency: string;
  readonly description: string;
  readonly accessNotes: string;
  readonly scheduleOpen: boolean;
  readonly isoDay: string;
  readonly window: string;
  readonly technicianId: string;
  readonly jobTypeId?: string;
  readonly contactId?: string;
  readonly locationId?: string;
  readonly tagTypeIds?: readonly string[];
}

export interface CreateRequestPayload {
  readonly customerId?: string;
  readonly customer?: { readonly name: string; readonly phone?: string; readonly email?: string };
  readonly address: string;
  readonly issueType: string;
  readonly jobType?: string;
  readonly urgency: string;
  readonly description: string;
  readonly accessNotes?: string;
  readonly schedule?: { readonly isoDay: string; readonly window: string; readonly technicianId?: string };
  readonly override?: boolean;
  readonly jobTypeId?: string;
  readonly contactId?: string;
  readonly locationId?: string;
  readonly tagTypeIds?: readonly string[];
}

/** Build the POST body from the dialog state, dropping blanks. */
export function buildCreateRequestPayload(
  draft: CreateRequestDraft,
  override: boolean,
): CreateRequestPayload {
  const t = (s: string) => s.trim();
  const phone = t(draft.newCustomer.phone);
  const email = t(draft.newCustomer.email);
  const accessNotes = t(draft.accessNotes);
  const technicianId = t(draft.technicianId);
  return {
    ...(draft.customerId
      ? { customerId: draft.customerId }
      : {
          customer: {
            name: t(draft.newCustomer.name),
            ...(phone ? { phone } : {}),
            ...(email ? { email } : {}),
          },
        }),
    address: t(draft.address),
    issueType: draft.issueType,
    ...(draft.jobTypeId
      ? { jobTypeId: draft.jobTypeId }
      : draft.jobType
        ? { jobType: draft.jobType }
        : {}),
    ...(draft.customerId && draft.contactId ? { contactId: draft.contactId } : {}),
    ...(draft.customerId && draft.locationId ? { locationId: draft.locationId } : {}),
    ...(draft.tagTypeIds && draft.tagTypeIds.length > 0 ? { tagTypeIds: draft.tagTypeIds } : {}),
    urgency: draft.urgency,
    description: t(draft.description),
    ...(accessNotes ? { accessNotes } : {}),
    ...(draft.scheduleOpen && draft.isoDay && draft.window
      ? {
          schedule: {
            isoDay: draft.isoDay,
            window: draft.window,
            ...(technicianId ? { technicianId } : {}),
          },
        }
      : {}),
    ...(override ? { override: true } : {}),
  };
}

/**
 * Whether the New request form holds anything the office typed or picked —
 * closing it then asks before discarding (a phone booking was lost to one Esc).
 * Urgency and the schedule panel's open/closed state alone don't count.
 */
export function isDraftDirty(draft: CreateRequestDraft, searchInput = ""): boolean {
  const text = [
    draft.newCustomer.name,
    draft.newCustomer.phone,
    draft.newCustomer.email,
    draft.address,
    draft.issueType,
    draft.jobType,
    draft.jobTypeId ?? "",
    draft.description,
    draft.accessNotes,
    draft.isoDay,
    draft.window,
    draft.technicianId,
    searchInput,
  ];
  return (
    draft.customerId !== null ||
    text.some((v) => v.trim() !== "") ||
    (draft.tagTypeIds?.length ?? 0) > 0
  );
}
