import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: vi.fn() }));
vi.mock("@/lib/crypto", () => ({ decrypt: (v: string) => `dec:${v}` }));

const orderBy = vi.fn();
vi.mock("@/lib/db", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "innerJoin", "where"]) chain[m] = () => chain;
  chain.orderBy = (...a: unknown[]) => orderBy(...a);
  return { db: chain };
});

import { GET } from "./route";
import { getTechSession } from "@/lib/auth/tech-session";

const req = (q = "") => new Request(`http://t/api/tech/jobs${q}`);
const base = {
  referenceNumber: "REF", issueType: "AC", urgency: "routine", description: null,
  arrivalWindowStart: null, arrivalWindowEnd: null, accessNotes: null,
  addressEncrypted: "addr", customerNameEncrypted: "name", isLead: true, appointmentNumber: 1,
};
const row = (id: string, over: Record<string, unknown>) => ({
  ...base, id, appointmentId: `a-${id}`, status: "scheduled", assignmentStatus: "scheduled",
  scheduledDate: new Date("2026-11-03T15:00:00Z"), completedAt: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T16:00:00Z")); // Tue 11:00 Eastern
  (getTechSession as unknown as Mock).mockResolvedValue({ userId: "u", organizationId: "o" });
  orderBy.mockResolvedValue([
    row("today", {}),
    row("overdue", { scheduledDate: new Date("2026-10-30T15:00:00Z") }),
    row("next", { scheduledDate: new Date("2026-11-10T15:00:00Z"), appointmentNumber: 2, isLead: false }),
    row("done", { status: "completed", assignmentStatus: "completed", completedAt: new Date("2026-11-02T15:00:00Z") }),
    row("old", { status: "completed", assignmentStatus: "completed", completedAt: new Date("2026-08-01T15:00:00Z") }),
    row("reqdone", { status: "completed" }),
  ]);
});
afterEach(() => vi.useRealTimers());

async function ids(q: string) {
  const res = await GET(req(q));
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.data.jobs as Array<Record<string, unknown>>;
}

describe("GET /api/tech/jobs", () => {
  it("401 without a tech session", async () => {
    (getTechSession as unknown as Mock).mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    expect(orderBy).not.toHaveBeenCalled();
  });

  it("400 on a bad range", async () => {
    const res = await GET(req("?range=tomorrow"));
    expect(res.status).toBe(400);
    expect(orderBy).not.toHaveBeenCalled();
  });

  it("defaults to today: today and overdue visits, with visit fields and decrypted text", async () => {
    const jobs = await ids("");
    expect(jobs.map((j) => j.id)).toEqual(["today", "overdue"]);
    expect(jobs[0]).toMatchObject({
      appointmentId: "a-today", appointmentNumber: 1, assignmentStatus: "scheduled",
      isLead: true, address: "dec:addr", customerName: "dec:name",
    });
  });

  it("upcoming lists future visits only", async () => {
    const jobs = await ids("?range=upcoming");
    expect(jobs.map((j) => j.id)).toEqual(["next"]);
    expect(jobs[0]).toMatchObject({ appointmentNumber: 2, isLead: false });
  });

  it("past lists recent terminal rows, newest first, and drops those older than 30 days", async () => {
    orderBy.mockResolvedValue([
      row("done-a", { assignmentStatus: "completed", completedAt: new Date("2026-10-20T15:00:00Z") }),
      row("done-b", { assignmentStatus: "completed", completedAt: new Date("2026-11-02T15:00:00Z") }),
      row("old", { assignmentStatus: "completed", completedAt: new Date("2026-08-01T15:00:00Z") }),
    ]);
    expect((await ids("?range=past")).map((j) => j.id)).toEqual(["done-b", "done-a"]);
  });
});
