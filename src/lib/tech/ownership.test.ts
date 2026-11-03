import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { and, inArray } from "drizzle-orm";
import { serviceRequests } from "@/lib/db/schema";

const { selectQueue } = vi.hoisted(() => ({ selectQueue: [] as unknown[][] }));

vi.mock("@/lib/db", () => {
  const chain = () => {
    const rows = Promise.resolve(selectQueue.shift() ?? []);
    const node: Record<string, unknown> = {
      from: () => node,
      where: () => node,
      innerJoin: () => node,
      orderBy: () => rows,
      limit: () => rows,
    };
    return node;
  };
  return { db: { select: () => chain() } };
});

import {
  OPEN_ASSIGNMENT_STATUSES,
  findActiveVisit,
  findReadableJob,
  hasProgress,
  isOpen,
  pickActiveAssignment,
  pickActiveVisit,
  techCanReadSql,
  type TechAssignmentRow,
} from "./ownership";

let n = 0;
function row(over: Partial<TechAssignmentRow> & { appointmentNumber: number }): TechAssignmentRow {
  n += 1;
  return {
    assignmentId: `as-${n}`, appointmentId: `appt-${over.appointmentNumber}`, isLead: false,
    status: "assigned", cancelledAt: null, enRouteAt: null, arrivedAt: null, startedAt: null,
    completedAt: null, technicianId: "t1", ...over,
  };
}

beforeEach(() => { selectQueue.length = 0; });

describe("isOpen / OPEN_ASSIGNMENT_STATUSES", () => {
  it("excludes pending, completed and cancelled", () => {
    expect(isOpen("pending")).toBe(false);
    expect(isOpen("completed")).toBe(false);
    expect(isOpen("cancelled")).toBe(false);
    for (const s of OPEN_ASSIGNMENT_STATUSES) expect(isOpen(s)).toBe(true);
  });
});

describe("hasProgress", () => {
  const none = { enRouteAt: null, arrivedAt: null, startedAt: null, completedAt: null };
  it("is false with no timestamps", () => expect(hasProgress(none)).toBe(false));
  it.each(["enRouteAt", "arrivedAt", "startedAt", "completedAt"] as const)("is true with %s", (k) => {
    expect(hasProgress({ ...none, [k]: new Date() })).toBe(true);
  });
});

describe("pickActiveVisit", () => {
  it("returns null when there are no rows", () => expect(pickActiveVisit([])).toBeNull());

  it("(i) one open row -> that visit, with its lead", () => {
    const rows = [row({ appointmentNumber: 1, isLead: true, technicianId: "lead" }), row({ appointmentNumber: 1, technicianId: "helper" })];
    expect(pickActiveVisit(rows)).toEqual({ appointmentId: "appt-1", leadTechnicianId: "lead" });
  });

  it("(ii) #1 completed, #2 assigned -> #2", () => {
    const rows = [row({ appointmentNumber: 1, status: "completed" }), row({ appointmentNumber: 2, isLead: true })];
    expect(pickActiveVisit(rows)?.appointmentId).toBe("appt-2");
  });

  it("(iii) all completed -> the latest non-cancelled visit", () => {
    const rows = [row({ appointmentNumber: 1, status: "completed" }), row({ appointmentNumber: 2, status: "completed" })];
    expect(pickActiveVisit(rows)?.appointmentId).toBe("appt-2");
  });

  it("(iv) cancelled visits are ignored", () => {
    const rows = [
      row({ appointmentNumber: 1, status: "completed" }),
      row({ appointmentNumber: 2, cancelledAt: new Date() }),
    ];
    expect(pickActiveVisit(rows)?.appointmentId).toBe("appt-1");
  });

  it("(v) a paused helper on #1 beats an in-progress #2 (earliest open)", () => {
    const rows = [
      row({ appointmentNumber: 1, status: "completed", isLead: true }),
      row({ appointmentNumber: 1, status: "on_hold", technicianId: "helper" }),
      row({ appointmentNumber: 2, status: "in_progress" }),
    ];
    expect(pickActiveVisit(rows)?.appointmentId).toBe("appt-1");
  });

  it("(vi) #2 all cancelled rows (ended), #1 completed -> #1", () => {
    const rows = [row({ appointmentNumber: 1, status: "completed" }), row({ appointmentNumber: 2, status: "cancelled" })];
    expect(pickActiveVisit(rows)?.appointmentId).toBe("appt-1");
  });

  it("returns a null lead when the visit has no active lead row", () => {
    expect(pickActiveVisit([row({ appointmentNumber: 1 })])?.leadTechnicianId).toBeNull();
  });
});

describe("pickActiveAssignment", () => {
  it("returns null with no rows", () => expect(pickActiveAssignment([], null)).toBeNull());

  it("picks the row on the active visit", () => {
    const a = row({ appointmentNumber: 1 });
    const b = row({ appointmentNumber: 2 });
    expect(pickActiveAssignment([a, b], "appt-2")).toBe(b);
  });

  it("not on the active visit -> earliest open row", () => {
    const a = row({ appointmentNumber: 1, status: "completed" });
    const b = row({ appointmentNumber: 3 });
    const c = row({ appointmentNumber: 2 });
    expect(pickActiveAssignment([a, b, c], "appt-9")).toBe(c);
  });

  it("none open -> latest non-cancelled row", () => {
    const a = row({ appointmentNumber: 1, status: "completed" });
    const b = row({ appointmentNumber: 2, status: "completed" });
    const c = row({ appointmentNumber: 3, status: "cancelled" });
    expect(pickActiveAssignment([a, b, c], null)).toBe(b);
  });
});

describe("techCanReadSql", () => {
  it("casts the cancelled literal to request_status", () => {
    const { sql: text } = new PgDialect().sqlToQuery(techCanReadSql("org-1", "tech-1"));
    expect(text).toContain("a.status <> 'cancelled'::request_status");
  });

  it("is enclosed in its own parentheses so and() cannot split the OR", () => {
    const frag = and(techCanReadSql("org-1", "tech-1"), inArray(serviceRequests.status, ["scheduled", "assigned"]))!;
    const { sql: text } = new PgDialect().sqlToQuery(frag);
    expect(text.startsWith("((EXISTS (")).toBe(true);
    const orAt = text.indexOf(' OR "service_requests"."assigned_to"');
    expect(orAt).toBeGreaterThan(0);
    // The OR must close before the AND that joins the status filter.
    const andAt = text.indexOf(' and "service_requests"."status"');
    expect(text.slice(orAt, andAt).trimEnd().endsWith(")")).toBe(true);
    // and() contributes one opening paren; the fragment itself must be balanced before the AND.
    const before = text.slice(0, andAt);
    expect(before.split("(").length - 1).toBe(before.split(")").length - 1 + 1);
  });
});

describe("queries", () => {
  it("findReadableJob maps native from the external job ids", async () => {
    selectQueue.push([{ id: "j", customerId: "c", fieldpulseJobId: null, hcpJobId: null, status: "assigned" }]);
    expect(await findReadableJob("o", "t", "j")).toEqual({ id: "j", customerId: "c", native: true, status: "assigned" });
    selectQueue.push([{ id: "j", customerId: null, fieldpulseJobId: "fp1", hcpJobId: null, status: "assigned" }]);
    expect((await findReadableJob("o", "t", "j"))?.native).toBe(false);
  });

  it("findReadableJob is null when not readable", async () => {
    selectQueue.push([]);
    expect(await findReadableJob("o", "t", "j")).toBeNull();
  });

  it("findActiveVisit picks from the fetched rows", async () => {
    selectQueue.push([row({ appointmentNumber: 1, isLead: true, technicianId: "lead" })]);
    expect(await findActiveVisit("o", "j")).toEqual({ appointmentId: "appt-1", leadTechnicianId: "lead" });
  });
});
