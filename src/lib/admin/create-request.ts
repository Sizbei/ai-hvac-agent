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

/** The bands the availability surface reports — what the office can book. */
export const BOOKABLE_WINDOWS = ["morning", "afternoon", "evening"] as const;
export type BookableWindow = (typeof BOOKABLE_WINDOWS)[number];

export const DESCRIPTION_MAX = 2000;
const ADDRESS_MAX = 500;
const NAME_MAX = 200;
const ACCESS_NOTES_MAX = 1000;

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
}

export type ParseResult =
  | { readonly ok: true; readonly data: CreateRequestInput }
  | { readonly ok: false; readonly message: string };

/** Validate + normalise a POST /api/admin/requests body. */
export function parseCreateRequestBody(raw: unknown): ParseResult {
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
    ...(draft.jobType ? { jobType: draft.jobType } : {}),
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
