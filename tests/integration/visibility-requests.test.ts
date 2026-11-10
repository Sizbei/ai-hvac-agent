import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedVisibilityOrg, type VisibilityOrg } from "./visibility-fixture";

vi.mock("server-only", () => ({}));

/**
 * Sweep A (Task 10): requests, dispatch, calendar, dashboard and the
 * needs-action count read only visible rows for an org user (VISIBLE_ONLY),
 * and every row for the platform owner (SHOW_ALL). DEV database, one
 * throwaway org (visibility-fixture.ts), deleted in afterAll.
 */

type Q = typeof import("@/lib/admin/queries");
type V = typeof import("@/lib/admin/visibility");

let q: Q;
let v: V;
let fx: VisibilityOrg;
let sched: typeof import("@/lib/admin/scheduling-queries");
let conv: typeof import("@/lib/admin/conversation-queries");
let exceptions: typeof import("@/lib/admin/dispatch-exceptions-queries");
let time: typeof import("@/lib/admin/calendar-time");
let windowStart: Date;

beforeAll(async () => {
  fx = await seedVisibilityOrg();
  q = await import("@/lib/admin/queries");
  v = await import("@/lib/admin/visibility");
  sched = await import("@/lib/admin/scheduling-queries");
  conv = await import("@/lib/admin/conversation-queries");
  exceptions = await import("@/lib/admin/dispatch-exceptions-queries");
  time = await import("@/lib/admin/calendar-time");
  const { db } = await import("@/lib/db");
  const { sql } = await import("drizzle-orm");

  // Both sets: urgent (needs attention), queued by auto-dispatch (exceptions
  // rail), escalated and unhandled (needs action), invoice overdue. UPDATEs
  // only: the un-hide triggers fire on INSERT, so the hidden set stays hidden.
  const both = (col: "request" | "session" | "invoice") => [fx.visible[col], fx.hidden[col]];
  await db.batch([
    db.execute(sql`UPDATE service_requests SET urgency = 'high', auto_dispatch_outcome = 'queued_no_fit'
      WHERE organization_id = ${fx.org} AND id IN (${sql.join(both("request").map((id) => sql`${id}`), sql`, `)})`),
    db.execute(sql`UPDATE customer_sessions SET status = 'escalated'::session_status, handled_at = NULL
      WHERE organization_id = ${fx.org} AND id IN (${sql.join(both("session").map((id) => sql`${id}`), sql`, `)})`),
    db.execute(sql`UPDATE invoices SET due_date = now() - interval '10 days'
      WHERE organization_id = ${fx.org} AND id IN (${sql.join(both("invoice").map((id) => sql`${id}`), sql`, `)})`),
  ]);
  const flags = await db.execute(sql`SELECT
      (SELECT hidden_from_org FROM service_requests WHERE id = ${fx.hidden.request}) AS r,
      (SELECT hidden_from_org FROM customer_sessions WHERE id = ${fx.hidden.session}) AS s,
      (SELECT hidden_from_org FROM invoices WHERE id = ${fx.hidden.invoice}) AS i,
      (SELECT arrival_window_start FROM service_requests WHERE id = ${fx.visible.request}) AS w`);
  const row = flags.rows[0] as { r: boolean; s: boolean; i: boolean; w: string | Date };
  if (!(row.r && row.s && row.i)) throw new Error("fixture: hidden set was un-hidden by the setup UPDATEs");
  windowStart = new Date(row.w);
}, 60_000);

afterAll(async () => {
  await fx?.cleanup();
});

const ids = <T extends { id: string }>(rows: readonly T[]) => rows.map((r) => r.id);

describe("visibility — requests, dispatch, calendar, dashboard (sweep A)", () => {
  it("getRequests excludes the hidden request; total counts only visible", async () => {
    const only = await q.getRequests(fx.org, {}, v.VISIBLE_ONLY);
    expect(ids(only.requests)).toEqual([fx.visible.request]);
    expect(only.total).toBe(1);

    const all = await q.getRequests(fx.org, {}, v.SHOW_ALL);
    expect(ids(all.requests).sort()).toEqual([fx.visible.request, fx.hidden.request].sort());
    expect(all.total).toBe(2);
  });

  it("getRequestById returns null for a hidden id with VISIBLE_ONLY and the row with SHOW_ALL", async () => {
    expect(await q.getRequestById(fx.org, fx.hidden.request, v.VISIBLE_ONLY)).toBeNull();
    expect((await q.getRequestById(fx.org, fx.visible.request, v.VISIBLE_ONLY))?.id).toBe(fx.visible.request);
    expect((await q.getRequestById(fx.org, fx.hidden.request, v.SHOW_ALL))?.id).toBe(fx.hidden.request);
  });

  it("getSchedulingCalendar, getDispatchBoard and getMonthCalendar place only the visible visit", async () => {
    const day = time.businessIsoDate(windowStart);
    const bounds = time.businessDayBounds(day)!;
    const run = async (vis: typeof v.SHOW_ALL) => {
      const cal = await q.getSchedulingCalendar(
        fx.org, bounds.start.toISOString(), bounds.end.toISOString(), [day], false, vis,
      );
      const board = await q.getDispatchBoard(fx.org, day, vis);
      const month = await q.getMonthCalendar(
        fx.org, bounds.start.toISOString(), bounds.end.toISOString(), [day], day.slice(0, 7), false, vis,
      );
      return {
        calendar: [...ids(cal.unassigned), ...cal.lanes.flatMap((l) => ids(l.jobs))].sort(),
        unscheduled: ids(cal.unscheduled).sort(),
        board: [...ids(board.unassigned), ...board.columns.flatMap((c) => ids(c.jobs))].sort(),
        month: month.days.flatMap((d) => ids(d.jobs)).sort(),
      };
    };
    const both = [fx.visible.request, fx.hidden.request].sort();

    const only = await run(v.VISIBLE_ONLY);
    expect(only).toEqual({
      calendar: [fx.visible.request],
      unscheduled: [fx.visible.request],
      board: [fx.visible.request],
      month: [fx.visible.request],
    });
    expect(await run(v.SHOW_ALL)).toEqual({ calendar: both, unscheduled: both, board: both, month: both });
  });

  it("getAgenda and getCustomerBookings skip hidden requests", async () => {
    expect(ids((await q.getAgenda(fx.org, null, v.VISIBLE_ONLY)).bookings)).toEqual([fx.visible.request]);
    expect(ids((await q.getAgenda(fx.org, null, v.SHOW_ALL)).bookings).sort()).toEqual(
      [fx.visible.request, fx.hidden.request].sort(),
    );

    expect(await q.getCustomerBookings(fx.org, fx.hidden.customer, v.VISIBLE_ONLY)).toEqual([]);
    expect(ids(await q.getCustomerBookings(fx.org, fx.visible.customer, v.VISIBLE_ONLY))).toEqual([fx.visible.request]);
    expect(ids(await q.getCustomerBookings(fx.org, fx.hidden.customer, v.SHOW_ALL))).toEqual([fx.hidden.request]);
  });

  it("countUnscheduledRequests and listUnscheduledRequests ignore hidden", async () => {
    expect(await q.countUnscheduledRequests(fx.org, v.VISIBLE_ONLY)).toBe(1);
    expect(await q.countUnscheduledRequests(fx.org, v.SHOW_ALL)).toBe(2);
    expect(ids(await sched.listUnscheduledRequests(fx.org, v.VISIBLE_ONLY))).toEqual([fx.visible.request]);
    expect(ids(await sched.listUnscheduledRequests(fx.org, v.SHOW_ALL)).sort()).toEqual(
      [fx.visible.request, fx.hidden.request].sort(),
    );
  });

  it("getDashboardOverview stats, overdue tiles and the needs-action count exclude hidden rows", async () => {
    const only = await q.getDashboardOverview(fx.org, v.VISIBLE_ONLY);
    expect(only.stats.pending).toBe(1);
    expect(ids(only.needsAttention)).toEqual([fx.visible.request]);
    expect(only.overdueInvoices).toEqual({ count: 1, cents: 7500 });
    expect(only.conversationsNeedingAction).toBe(1);
    expect((await q.getDashboardStats(fx.org, v.VISIBLE_ONLY)).pending).toBe(1);

    const all = await q.getDashboardOverview(fx.org, v.SHOW_ALL);
    expect(all.stats.pending).toBe(2);
    expect(ids(all.needsAttention).sort()).toEqual([fx.visible.request, fx.hidden.request].sort());
    expect(all.overdueInvoices).toEqual({ count: 2, cents: 15000 });
    expect(all.conversationsNeedingAction).toBe(2);
    expect((await q.getDashboardStats(fx.org, v.SHOW_ALL)).pending).toBe(2);
  });

  it("buildNeedsActionCountQuery ignores a hidden session that needs action", async () => {
    const [only] = await conv.buildNeedsActionCountQuery(fx.org, v.VISIBLE_ONLY);
    const [all] = await conv.buildNeedsActionCountQuery(fx.org, v.SHOW_ALL);
    expect(Number(only?.value)).toBe(1);
    expect(Number(all?.value)).toBe(2);
  });

  it("getDispatchExceptions ignores hidden", async () => {
    expect(ids(await exceptions.getDispatchExceptions(fx.org, v.VISIBLE_ONLY))).toEqual([fx.visible.request]);
    expect(ids(await exceptions.getDispatchExceptions(fx.org, v.SHOW_ALL)).sort()).toEqual(
      [fx.visible.request, fx.hidden.request].sort(),
    );
  });
});
