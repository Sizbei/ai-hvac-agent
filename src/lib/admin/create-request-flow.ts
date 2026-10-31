/**
 * Office booking orchestration — the ORDER of the create steps, with every
 * side effect injected so the decisions are unit-tested without a database
 * (create-request-flow.test.ts). create-request-queries.ts supplies the real
 * dependencies.
 *
 * Two guarantees:
 *  1. Everything that can refuse the create (technician, schedule conflict,
 *     customer) runs BEFORE the insert, so a refusal writes nothing and a
 *     "Schedule anyway?" retry can't produce a duplicate.
 *  2. Nothing after the insert can fail the create. Once the request is
 *     committed the caller always gets `ok: true` with its reference number; a
 *     scheduling problem is reported as `schedule: { kind: "failed" }` (the
 *     request stays, unscheduled), never as an error the office would retry.
 */
import { arrivalWindowUtcForBusinessDate } from "@/lib/admin/calendar-time";
import type { ScheduleConflictDetail } from "@/lib/admin/scheduling-queries";
import {
  planSchedule,
  type CreateRequestInput,
  type SchedulePlan,
} from "./create-request";

export type CreateScheduleOutcome =
  | { readonly kind: "none" }
  | {
      readonly kind: "placed";
      readonly arrivalWindowStart: string;
      readonly arrivalWindowEnd: string;
      readonly assignedTo: string | null;
      readonly overridden: boolean;
    }
  /** The request exists but its window could not be booked. */
  | { readonly kind: "failed" };

export type CreateAdminRequestResult =
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly referenceNumber: string;
      readonly schedule: CreateScheduleOutcome;
    }
  | { readonly ok: false; readonly reason: "customer_not_found" }
  | { readonly ok: false; readonly reason: "do_not_service" }
  | { readonly ok: false; readonly reason: "technician_not_found" }
  | {
      readonly ok: false;
      readonly reason: "conflict";
      readonly detail: ScheduleConflictDetail;
    };

export interface ArrivalRange {
  readonly start: Date;
  readonly end: Date;
}

export type PlacedPlan = Exclude<SchedulePlan, { kind: "none" }>;

export interface CreateRequestDeps<C extends { readonly id: string } = { readonly id: string }> {
  /** Active technician in this org? */
  verifyTechnician(technicianId: string): Promise<boolean>;
  /** Null when the window is clear for the technician, else the clash. */
  checkTechnicianWindow(
    technicianId: string,
    plan: Extract<SchedulePlan, { kind: "assign" }>,
    window: ArrivalRange,
  ): Promise<ScheduleConflictDetail | null>;
  resolveCustomer(): Promise<C | "not_found" | "do_not_service">;
  /** The atomic write (session + request + audit). Throwing = nothing saved. */
  insertRequest(
    customer: C,
    window: ArrivalRange | null,
  ): Promise<{ readonly requestId: string; readonly referenceNumber: string }>;
  recordCreated(requestId: string): Promise<void>;
  place(
    requestId: string,
    plan: PlacedPlan,
    window: ArrivalRange,
    override: boolean,
  ): Promise<
    | {
        readonly ok: true;
        readonly arrivalWindowStart: string;
        readonly arrivalWindowEnd: string;
        readonly assignedTo: string | null;
        readonly overridden: boolean;
      }
    | { readonly ok: false; readonly reason: string }
  >;
  markAssigned(requestId: string, technicianId: string): Promise<void>;
  reserveCapacity(requestId: string, isoDay: string, window: string): Promise<void>;
  scheduleBackground(requestId: string, customer: C, placed: boolean): void;
  logError(error: unknown, context: Record<string, unknown>): void;
}

async function applySchedule<C extends { readonly id: string }>(
  deps: CreateRequestDeps<C>,
  requestId: string,
  plan: PlacedPlan,
  window: ArrivalRange,
  override: boolean,
): Promise<CreateScheduleOutcome> {
  const placed = await deps.place(requestId, plan, window, override);
  if (!placed.ok) return { kind: "failed" };
  if (plan.kind === "assign") {
    await deps.markAssigned(requestId, plan.technicianId);
  } else {
    await deps.reserveCapacity(requestId, plan.isoDay, plan.window);
  }
  return {
    kind: "placed",
    arrivalWindowStart: placed.arrivalWindowStart,
    arrivalWindowEnd: placed.arrivalWindowEnd,
    assignedTo: placed.assignedTo,
    overridden: placed.overridden,
  };
}

export async function runCreateRequest<C extends { readonly id: string }>(
  deps: CreateRequestDeps<C>,
  input: CreateRequestInput,
): Promise<CreateAdminRequestResult> {
  const plan = planSchedule(input.schedule);
  const window =
    plan.kind === "none" ? null : arrivalWindowUtcForBusinessDate(plan.isoDay, plan.window);

  // ── Refusals: nothing is written before these pass. ──
  if (plan.kind === "assign" && window) {
    if (!(await deps.verifyTechnician(plan.technicianId))) {
      return { ok: false, reason: "technician_not_found" };
    }
    if (!input.override) {
      const clash = await deps.checkTechnicianWindow(plan.technicianId, plan, window);
      if (clash) return { ok: false, reason: "conflict", detail: clash };
    }
  }

  const customer = await deps.resolveCustomer();
  if (customer === "not_found") return { ok: false, reason: "customer_not_found" };
  if (customer === "do_not_service") return { ok: false, reason: "do_not_service" };

  const { requestId, referenceNumber } = await deps.insertRequest(customer, window);

  // ── Committed. From here on nothing may turn into an error. ──
  let schedule: CreateScheduleOutcome = { kind: "none" };
  try {
    await deps.recordCreated(requestId);
    if (plan.kind !== "none" && window) {
      schedule = await applySchedule(deps, requestId, plan, window, input.override);
    }
  } catch (error: unknown) {
    deps.logError(error, { requestId, step: "post-insert" });
    schedule = plan.kind === "none" ? { kind: "none" } : { kind: "failed" };
  }

  try {
    deps.scheduleBackground(requestId, customer, schedule.kind === "placed");
  } catch (error: unknown) {
    deps.logError(error, { requestId, step: "background" });
  }

  return { ok: true, requestId, referenceNumber, schedule };
}
