/**
 * M2 board and move contracts shared by the server writers, the routes and the
 * calendar client (spec §4–§7). Client-safe: no runtime imports.
 */
import type { ArrivalWindow } from "./arrival-window";
import type { RescheduleWindowRow } from "./calendar-time";

export type CrewState = "open" | "working" | "done";

/** One live row on the displayed visit. `name` is null for an inactive technician (withheld). */
export interface CrewMember {
  readonly technicianId: string;
  readonly name: string | null;
  readonly isLead: boolean;
  readonly state: CrewState;
}

export type LaneRole = "lead" | "helper";
export type Movable = "yes" | "no";

/** A technician_shifts row as the day view draws it (spec §3.4, §7.3). */
export interface BoardBlock {
  readonly id: string;
  readonly technicianId: string;
  readonly kind: "on_call" | "time_off" | "non_job";
  readonly title: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly removesCapacity: boolean;
}

export type MoveConfirm = "started" | "conflict";
export type WindowRule = "match" | "pick" | "keep";
export type MoveBand = RescheduleWindowRow;

/** Body of POST /api/admin/requests/[id]/move (spec §5.3). */
export interface MoveBody {
  readonly visitId: string | null;
  readonly expectedVersion: number | null;
  /** Business-tz day (YYYY-MM-DD) of the drop. */
  readonly day: string;
  /** The band under the pointer (or the dialog's band). */
  readonly band: MoveBand;
  readonly windowRule: WindowRule;
  readonly pick?: ArrivalWindow;
  /** The new lead; absent or equal to the current lead = keep. Never unassigns. */
  readonly technicianId?: string;
  readonly confirm: readonly MoveConfirm[];
}

export interface StartedDetail {
  readonly technicianId: string;
  readonly status: string;
  readonly hasTimestamp: boolean;
  readonly openTimeEntry: boolean;
}

export interface ConflictDetail {
  readonly id: string;
  readonly referenceNumber: string;
  readonly technicianId: string;
  readonly arrivalWindowStart: string;
  readonly arrivalWindowEnd: string;
}

/** `details` of a 409 HAS_PROGRESS / SCHEDULE_CONFLICT from the move route. Ids only, no names. */
export interface MoveNeedsDetails {
  readonly needs: readonly MoveConfirm[];
  readonly started?: readonly StartedDetail[];
  readonly conflicts?: readonly ConflictDetail[];
  readonly outsideAvailability?: boolean;
  /** A live row other than the current lead's is started (so a lead change won't reset the request to scheduled). */
  readonly othersStarted?: boolean;
}

/** One entry of TIME_OFF's `details.timeOff` (never overridable, so no `needs`). */
export interface TimeOffDetail {
  readonly technicianId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly kind: "on_call" | "time_off" | "non_job";
}

/** 200 `data` of the move route. */
export interface MoveSuccessData {
  readonly visitId: string;
  readonly visitVersion: number;
  readonly requestStatus: string;
  readonly arrivalWindowStart: string;
  readonly arrivalWindowEnd: string;
  readonly leadId: string | null;
  readonly confirmed: readonly MoveConfirm[];
}

/** Why mass reschedule left a visit where it was (spec §5.6). */
export type MassReason =
  | "started" | "ended" | "later_visit" | "time_off" | "window_ended"
  | "already_on_visit" | "fieldpulse" | "helper" | "stale";

/** Reasons the client may send in `preSkipped` (every preview reason, plus a conflict it didn't confirm). */
export const MASS_PRESKIP_REASONS = [
  "started", "ended", "later_visit", "time_off", "window_ended",
  "already_on_visit", "fieldpulse", "helper", "conflict",
] as const;
export type MassPreSkipReason = (typeof MASS_PRESKIP_REASONS)[number];

export type MassOutcome = "moves" | Exclude<MassReason, "stale">;

export interface MassCandidate {
  readonly visitId: string;
  readonly requestId: string;
  readonly referenceNumber: string;
  readonly customerName: string | null;
  readonly arrivalWindowStart: string;
  readonly arrivalWindowEnd: string;
  readonly visitNumber: number;
  readonly expectedVersion: number;
  readonly outcome: MassOutcome;
  /** Soft: overlaps another request or falls outside the lead's hours. */
  readonly conflict: boolean;
  /** For `helper`: the lead's first name ("Helping Alex"). */
  readonly leadFirstName: string | null;
}

export interface MassResult {
  readonly moved: readonly { readonly visitId: string; readonly requestId: string; readonly visitVersion: number }[];
  readonly skipped: readonly { readonly visitId: string; readonly reason: MassReason | "conflict" }[];
  readonly pushesNotSent: readonly string[];
}
