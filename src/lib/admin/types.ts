/**
 * Admin API request/response types.
 *
 * These types are used by admin route handlers and the admin query module.
 * All interfaces use readonly properties for immutability.
 */

// Request list item (includes decrypted customer name for list display)
export interface AdminRequest {
  readonly id: string;
  readonly status: string;
  readonly issueType: string;
  readonly urgency: string;
  readonly description: string;
  readonly referenceNumber: string;
  readonly customerName: string | null;
  readonly assignedToName: string | null;
  readonly isAfterHours: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// Request detail (includes decrypted PII + transcript)
export interface AdminRequestDetail extends AdminRequest {
  readonly customerPhone: string | null;
  readonly customerEmail: string | null;
  readonly address: string | null;
  readonly scheduledDate: string | null;
  readonly arrivalWindowStart: string | null;
  readonly arrivalWindowEnd: string | null;
  readonly holdReason: string | null;
  readonly followUpDate: string | null;
  readonly isAfterHours: boolean;
  readonly afterHoursSurcharge: number;
  readonly completedAt: string | null;
  readonly assignedTo: string | null;
  readonly transcript: readonly TranscriptMessage[];
  readonly notes: readonly RequestNote[];
  // ── ServiceTitan-style intake details (all nullable; PII-free) ──
  readonly intake: RequestIntakeDetails;
}

// Comprehensive intake fields gathered by the chat/voice agent. Surfaced in the
// admin request detail so dispatch sees everything the customer told us.
export interface RequestIntakeDetails {
  readonly jobType: string | null;
  readonly systemType: string | null;
  readonly equipmentBrand: string | null;
  readonly equipmentAgeBand: string | null;
  readonly propertyType: string | null;
  readonly ownerOccupant: string | null;
  readonly underWarranty: string | null;
  readonly accessNotes: string | null;
  readonly systemDownStatus: string | null;
  readonly problemDuration: string | null;
  readonly vulnerableOccupants: boolean | null;
  readonly preferredWindow: string | null;
  readonly contactPreference: string | null;
  readonly smsConsent: boolean | null;
  readonly leadSource: string | null;
}

export interface TranscriptMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly createdAt: string;
}

// Internal staff note on a request (never shown to the customer).
export interface RequestNote {
  readonly id: string;
  readonly content: string;
  readonly authorName: string | null;
  readonly createdAt: string;
}

export interface TechnicianRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly isActive: boolean;
  readonly createdAt: string;
}

/** A staff member (admin or technician) for the user-management surface.
 * Unlike TechnicianRecord this carries the role so admins can manage both
 * kinds of user from one screen. */
export interface StaffRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: "admin" | "technician";
  readonly isActive: boolean;
  readonly createdAt: string;
}

export interface CreateStaffInput {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly role: "admin" | "technician";
}

/** Patch for an existing staff member. Any subset may be present; an empty
 * patch is a no-op. Password reset is a separate, explicit operation. */
export interface UpdateStaffInput {
  readonly name?: string;
  readonly role?: "admin" | "technician";
  readonly isActive?: boolean;
}

export interface DashboardStats {
  readonly pending: number;
  readonly assignedToday: number;
  readonly inProgress: number;
  readonly completedToday: number;
  /** Booked with an arrival window, not yet started (request_status "scheduled"). */
  readonly scheduled: number;
  /** Paused awaiting parts/callback/access (request_status "on_hold"). */
  readonly onHold: number;
  /** Open (non-terminal) requests flagged urgency = "emergency". */
  readonly emergencyOpen: number;
  /** Requests created today that were flagged after-hours. */
  readonly afterHoursToday: number;
  /** Sum, in dollars, of after-hours surcharges applied to requests created today. */
  readonly surchargeToday: number;
}

/** A single request as it appears in a dashboard list (today's schedule,
 * attention queues). Lightweight: no transcript/notes, decrypted name only. */
export interface DashboardRequest {
  readonly id: string;
  readonly referenceNumber: string;
  readonly customerName: string | null;
  readonly issueType: string;
  readonly urgency: string;
  readonly status: string;
  readonly isAfterHours: boolean;
  readonly assignedToName: string | null;
  readonly arrivalWindowStart: string | null;
  readonly arrivalWindowEnd: string | null;
  readonly followUpDate: string | null;
  readonly holdReason: string | null;
  readonly createdAt: string;
}

/** Max rows any single dashboard list returns. A list at this length is shown
 * with a "50+" affordance in the UI so operators know it may be truncated.
 * Lives here (not in queries.ts) so client components can import it without
 * pulling server-only DB code into the bundle. */
export const DASHBOARD_LIST_LIMIT = 50;

/** Everything the /admin overview dashboard renders, in one tenant-scoped payload. */
export interface DashboardOverview {
  readonly stats: DashboardStats;
  /** Requests with an arrival window that starts today, soonest first. */
  readonly todaySchedule: readonly DashboardRequest[];
  /** Open emergency/high-urgency requests not yet assigned, most urgent first. */
  readonly needsAttention: readonly DashboardRequest[];
  /** On-hold requests awaiting a follow-up, earliest follow-up first. */
  readonly awaitingFollowUp: readonly DashboardRequest[];
}

/** One technician's column on the dispatch board: the tech plus the jobs
 * assigned to them for the selected day, ordered by arrival window. */
export interface DispatchColumn {
  readonly technicianId: string;
  readonly technicianName: string;
  readonly jobs: readonly DashboardRequest[];
}

/** The dispatch board for a single day: a column per active technician plus an
 * unassigned pile, all tenant-scoped. Reuses DashboardRequest for job cards. */
export interface DispatchBoard {
  /** The day the board covers, as an ISO date (YYYY-MM-DD), UTC-anchored. */
  readonly date: string;
  readonly columns: readonly DispatchColumn[];
  /** Scheduled jobs for the day with no technician yet — the "to place" pile. */
  readonly unassigned: readonly DashboardRequest[];
}

// ─── Scheduling (Stage 1: calendar foundation) ──────────────────────────────

/**
 * A recurring weekly working-hour window for a technician. `dayOfWeek` is
 * 0=Sunday … 6=Saturday; `startMinute`/`endMinute` are minutes from midnight in
 * the BUSINESS timezone (America/New_York), describing a [start, end) wall-clock
 * span. The calendar layer resolves these against a concrete date (handling DST)
 * when it needs UTC instants. Mirrors a row of `technician_availability`.
 */
export interface AvailabilitySlot {
  readonly id: string;
  readonly technicianId: string;
  readonly dayOfWeek: number;
  readonly startMinute: number;
  readonly endMinute: number;
}

/** The shape callers pass to setTechnicianAvailability — a slot without ids. */
export interface AvailabilitySlotInput {
  readonly dayOfWeek: number;
  readonly startMinute: number;
  readonly endMinute: number;
}

/**
 * A booked job as the scheduling source reports it: a request with a concrete
 * arrival window and (optionally) an assigned technician. Lighter than
 * DashboardRequest — the calendar/conflict logic only needs placement facts,
 * not customer PII. ISO timestamps (UTC).
 */
export interface ScheduledJob {
  readonly id: string;
  readonly referenceNumber: string;
  readonly status: string;
  readonly assignedTo: string | null;
  readonly arrivalWindowStart: string;
  readonly arrivalWindowEnd: string;
}

// ─── Scheduling calendar (Stage 2: read-only calendar + unscheduled view) ────

/**
 * A technician's lane on the scheduling calendar for a date range: the tech
 * plus the jobs assigned to them whose arrival window falls in the range,
 * window-ordered. Reuses DashboardRequest for rich job cards (name, urgency,
 * status) — the calendar shows more than the bare ScheduledJob placement facts.
 */
export interface CalendarTechnicianLane {
  readonly technicianId: string;
  readonly technicianName: string;
  readonly jobs: readonly DashboardRequest[];
}

/**
 * Everything the scheduling calendar renders for a chosen day or week, in one
 * tenant-scoped payload. `days` are the business-timezone ISO dates the view
 * covers (one for day view, seven for week view). `lanes` is a column per active
 * technician; `unassigned` are placed jobs (with a window) but no technician —
 * still on the grid, in their own lane. The "to place" queue (jobs missing a
 * tech OR a window entirely) is the separate `unscheduled` list.
 */
export interface SchedulingCalendar {
  /** Business-tz ISO dates (YYYY-MM-DD) this view covers, ascending. */
  readonly days: readonly string[];
  readonly lanes: readonly CalendarTechnicianLane[];
  /** Placed-but-unassigned jobs (have a window, no technician). */
  readonly unassigned: readonly DashboardRequest[];
  /** Open jobs not yet fully placed (no tech, or no arrival window). */
  readonly unscheduled: readonly DashboardRequest[];
  /**
   * Every technician's recurring weekly working hours (S1
   * technician_availability). The interactive calendar (S4) uses these to SHADE
   * out-of-hours window bands and to warn when a drop lands outside a tech's
   * shift — the same data the server enforces against, so the client preview and
   * the server gate can't disagree. Empty when no availability is configured.
   */
  readonly availability: readonly AvailabilitySlot[];
}

// ─── Scheduling (Stage 5: customer-facing open windows) ─────────────────────

/**
 * One bookable band on one business day, aggregated across technicians and
 * stripped of all PII. `window` is a discrete arrival band (morning/afternoon/
 * evening — `anytime` is never offered as a slot); `capacity` is how many active
 * technicians have that band inside their working hours for the day; `available`
 * is `capacity` minus the techs already booked into an overlapping job. A band is
 * BOOKABLE when `available > 0`. NO technician names/ids — only counts — so the
 * public availability endpoint can return this verbatim without leaking staff PII.
 */
export interface OpenWindow {
  /** Business-tz ISO date (YYYY-MM-DD) the band falls on. */
  readonly day: string;
  /** The arrival band: "morning" | "afternoon" | "evening". */
  readonly window: string;
  /** Active technicians whose working hours cover this band on this day. */
  readonly capacity: number;
  /** Capacity minus techs already booked into an overlapping job. */
  readonly available: number;
}

/**
 * The PII-free payload the customer-facing availability endpoint returns: the
 * business-tz days requested plus the open windows across them. Consumed by the
 * chat/widget intake to offer REAL open slots instead of "we'll confirm a time".
 */
export interface OpenAvailability {
  /** Business-tz ISO dates (YYYY-MM-DD) covered, ascending. */
  readonly days: readonly string[];
  /** Bookable bands across those days, day-then-window ordered. */
  readonly windows: readonly OpenWindow[];
}

export interface RequestFilters {
  readonly status?: string;
  /** Case-insensitive reference-number search (prefix match). Customer names
   * are AES-encrypted and therefore NOT SQL-searchable, so reference number is
   * the searchable key callers quote on the phone. */
  readonly search?: string;
  readonly page?: number;
  readonly limit?: number;
}

export interface CreateTechnicianInput {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

export interface UpdateTechnicianInput {
  readonly name?: string;
  readonly email?: string;
  readonly isActive?: boolean;
}
