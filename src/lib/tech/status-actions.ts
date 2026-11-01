/**
 * Pure resolution of a technician's status tap. No db access: the writer
 * (status-writes.ts) turns a `Resolved` into SQL. Rule order is load-bearing.
 */
import { canTransition, type RequestStatus } from "@/lib/admin/request-status";
import { requestStatusEnum } from "@/lib/db/schema";
import type { TechAssignmentRow } from "@/lib/tech/ownership";

export const TECH_ACTIONS = ["en_route", "arrived", "in_progress", "pause", "on_hold", "completed", "close_out"] as const;
export type TechAction = (typeof TECH_ACTIONS)[number];

export type Blocker =
  | { kind: "technician_open"; technicianName: string; technicianId: string; appointmentNumber: number }
  | { kind: "visit_planned"; appointmentNumber: number; date: string | null }
  | { kind: "earlier_visit_open"; technicianName: string; appointmentNumber: number }
  | { kind: "request_not_started"; status: RequestStatus }
  | { kind: "not_lead" }
  | { kind: "managed_externally" };

export interface ResolveInput {
  action: TechAction;
  row: TechAssignmentRow;
  requestStatus: RequestStatus;
  activeVisitId: string | null;
  activeLeadId: string | null;
  native: boolean;
}

type Stamp = "enRouteAt" | "arrivedAt" | "startedAt" | "completedAt";

export type Resolved =
  | { kind: "noop" }
  | { kind: "refuse"; reason: "not_lead" | "invalid_transition" | "managed_externally" | "not_tech_target" | "request_not_started" | "not_started_row" }
  | { kind: "write"; assignmentTo: RequestStatus; stamp: Stamp | null; requestTo: RequestStatus | null; timeEntry: "open" | "close" | "none" }
  | { kind: "hold" }
  | { kind: "request_only"; requestTo: RequestStatus }
  | { kind: "close_out" };

/** Request statuses the lead may complete / close out from (derived, not hard-coded). */
export function closeOutAllowedStatuses(): readonly RequestStatus[] {
  return requestStatusEnum.enumValues.filter((s) => canTransition(s, "completed"));
}

const CLOSE_OUT_STATUSES = closeOutAllowedStatuses();

const refuse = (reason: Extract<Resolved, { kind: "refuse" }>["reason"]): Resolved => ({ kind: "refuse", reason });

const isActiveLead = (i: ResolveInput): boolean => i.row.isLead && i.row.appointmentId === i.activeVisitId;

const STAMP_BY_TARGET: Partial<Record<RequestStatus, Stamp>> = {
  en_route: "enRouteAt",
  arrived: "arrivedAt",
  in_progress: "startedAt",
  completed: "completedAt",
};

function stampFor(target: RequestStatus): Stamp | null {
  return STAMP_BY_TARGET[target] ?? null;
}

/** Row already at the target and (when the target has one) its stamp is set. */
function isNoop(row: TechAssignmentRow, target: RequestStatus): boolean {
  if (row.status !== target) return false;
  const stamp = stampFor(target);
  return stamp === null || row[stamp] !== null;
}

const REQUEST_FOLLOWS = ["en_route", "arrived", "in_progress"] as const;
const followsRequest = (t: RequestStatus): boolean => (REQUEST_FOLLOWS as readonly string[]).includes(t);

function timeEntryFor(target: RequestStatus): "open" | "close" | "none" {
  if (target === "arrived" || target === "in_progress") return "open";
  if (target === "on_hold" || target === "completed") return "close";
  return "none";
}

export function resolveTechAction(i: ResolveInput): Resolved {
  if (!i.native) return refuse("managed_externally");
  // pickActiveAssignment can return a cancelled row; never write from one.
  if (i.row.status === "cancelled" || i.row.cancelledAt !== null) return refuse("invalid_transition");

  const activeLead = isActiveLead(i);

  if (i.action === "close_out") return activeLead ? { kind: "close_out" } : refuse("not_lead");
  if (i.action === "on_hold") {
    if (!activeLead) return refuse("not_lead");
    return canTransition(i.requestStatus, "on_hold") ? { kind: "hold" } : refuse("invalid_transition");
  }

  const target: RequestStatus = i.action === "pause" ? "on_hold" : i.action;

  if (target === "completed" && i.row.startedAt === null) return refuse("not_started_row");

  const requestBehind = activeLead && followsRequest(target) && i.requestStatus !== target && canTransition(i.requestStatus, target);

  if (isNoop(i.row, target)) {
    return requestBehind ? { kind: "request_only", requestTo: target } : { kind: "noop" };
  }
  // The stamped no-op above wins over this guard (replaying a finished close is a no-op).
  if (target === "completed" && activeLead && !CLOSE_OUT_STATUSES.includes(i.requestStatus)) return refuse("request_not_started");
  // A row at the target with a missing stamp (trigger-mirrored) is allowed through.
  if (i.row.status !== target && !canTransition(i.row.status, target)) return refuse("invalid_transition");

  return {
    kind: "write",
    assignmentTo: target,
    stamp: stampFor(target),
    requestTo: requestBehind ? target : null,
    timeEntry: timeEntryFor(target),
  };
}

export function allowedActions(i: Omit<ResolveInput, "action">): readonly TechAction[] {
  return TECH_ACTIONS.filter((action) => {
    const r = resolveTechAction({ ...i, action });
    return r.kind !== "refuse" && r.kind !== "noop";
  });
}
