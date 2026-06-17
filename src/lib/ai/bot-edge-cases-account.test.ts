/**
 * Bot edge-case suite — IDENTITY-GATED account-data reads (DB-mocked).
 *
 * Companion to bot-edge-cases.test.ts. These cases prove the account TOOLS that
 * back the identified-customer account intents (membership / next visit /
 * balance / appointment / reschedule) NEVER leak across customer or tenant
 * boundaries, and that the deterministic reply layer never asserts a price
 * estimate or a false "booked/scheduled/confirmed".
 *
 * The DB is mocked the same way as account-tools.test.ts: PREDICATE-EVALUATING
 * operators (eq/gte/inArray/withTenant return real (row)=>boolean), and the fake
 * query builder FILTERS the seeded rows with them. So a "scoped to this
 * customer/org" leak assertion is enforced by construction — if a tool forgot a
 * predicate, the other customer's/tenant's seeded row would leak and the test
 * would fail. No live DB, fully offline.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
type Pred = (row: Row) => boolean;

const { tables, store, inserts } = vi.hoisted(() => {
  const col = (table: string, key: string) => ({ __table: table, __key: key });
  const tables = {
    customerMemberships: {
      id: col("customer_memberships", "id"),
      organizationId: col("customer_memberships", "organizationId"),
      customerId: col("customer_memberships", "customerId"),
      planId: col("customer_memberships", "planId"),
      status: col("customer_memberships", "status"),
      currentPeriodEnd: col("customer_memberships", "currentPeriodEnd"),
    },
    membershipPlans: {
      id: col("membership_plans", "id"),
      name: col("membership_plans", "name"),
      billingPeriod: col("membership_plans", "billingPeriod"),
    },
    membershipVisits: {
      id: col("membership_visits", "id"),
      organizationId: col("membership_visits", "organizationId"),
      customerMembershipId: col("membership_visits", "customerMembershipId"),
      dueDate: col("membership_visits", "dueDate"),
      status: col("membership_visits", "status"),
    },
    invoices: {
      id: col("invoices", "id"),
      organizationId: col("invoices", "organizationId"),
      customerId: col("invoices", "customerId"),
      state: col("invoices", "state"),
      totalCents: col("invoices", "totalCents"),
      amountPaidCents: col("invoices", "amountPaidCents"),
    },
    serviceRequests: {
      id: col("service_requests", "id"),
      organizationId: col("service_requests", "organizationId"),
      customerId: col("service_requests", "customerId"),
      status: col("service_requests", "status"),
      referenceNumber: col("service_requests", "referenceNumber"),
      scheduledDate: col("service_requests", "scheduledDate"),
      arrivalWindowStart: col("service_requests", "arrivalWindowStart"),
      arrivalWindowEnd: col("service_requests", "arrivalWindowEnd"),
      createdAt: col("service_requests", "createdAt"),
    },
    requestNotes: {
      requestId: col("request_notes", "requestId"),
      organizationId: col("request_notes", "organizationId"),
      authorId: col("request_notes", "authorId"),
      content: col("request_notes", "content"),
    },
    customers: {
      id: col("customers", "id"),
      organizationId: col("customers", "organizationId"),
      portalTokenHash: col("customers", "portalTokenHash"),
    },
  };
  const store: Record<string, Row[]> = {};
  const inserts: { table: string; values: Row }[] = [];
  return { tables, store, inserts };
});

vi.mock("@/lib/db/schema", () => tables);

vi.mock("@/lib/db/tenant", () => ({
  withTenant: (_table: unknown, orgId: string, ...conds: Pred[]): Pred => {
    const orgPred: Pred = (row) => row.organizationId === orgId;
    return (row) => orgPred(row) && conds.every((c) => c(row));
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (colMarker: { __key: string }, value: unknown): Pred => {
    const isCol = typeof value === "object" && value !== null && "__key" in value;
    return (row) =>
      isCol
        ? row[colMarker.__key] === row[(value as { __key: string }).__key]
        : row[colMarker.__key] === value;
  },
  gte: (colMarker: { __key: string }, value: unknown): Pred => (row) => {
    const v = row[colMarker.__key];
    return v instanceof Date && value instanceof Date
      ? v.getTime() >= value.getTime()
      : (v as number) >= (value as number);
  },
  inArray: (colMarker: { __key: string }, values: unknown[]): Pred => (row) =>
    values.includes(row[colMarker.__key]),
  and: (...conds: Pred[]): Pred => (row) => conds.every((c) => c(row)),
  desc: (colMarker: { __key: string }) => ({ __order: colMarker.__key, dir: "desc" }),
  sql: (() => {
    const fn = () => ({ __sql: true });
    return fn;
  })(),
}));

function makeSelectBuilder() {
  const state: {
    table: string;
    joins: { table: string; on: Pred }[];
    where: Pred | null;
    aggregate: ((rows: Row[]) => Row[]) | null;
    selection: Record<string, unknown> | null;
  } = { table: "", joins: [], where: null, aggregate: null, selection: null };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {};

  const tableName = (table: unknown): string =>
    (Object.values(table as Record<string, unknown>).find(
      (v): v is { __table: string } =>
        typeof v === "object" && v !== null && "__table" in v,
    ) as { __table: string }).__table;

  const resolve = (): Row[] => {
    let rows = (store[state.table] ?? []).slice();
    for (const join of state.joins) {
      const joinRows = store[join.table] ?? [];
      rows = rows.flatMap((row) => {
        const matches = joinRows.filter((jr) => join.on({ ...row, ...jr }));
        return matches.map((jr) => ({ ...jr, ...row }));
      });
    }
    if (state.where) rows = rows.filter(state.where);
    if (state.aggregate) return state.aggregate(rows);
    if (state.selection) {
      const sel = state.selection;
      rows = rows.map((row) => {
        const out: Row = {};
        for (const [alias, marker] of Object.entries(sel)) {
          const key =
            typeof marker === "object" && marker !== null && "__key" in marker
              ? (marker as { __key: string }).__key
              : alias;
          out[alias] = row[key];
        }
        return out;
      });
    }
    return rows;
  };

  builder.select = (selection?: Record<string, unknown>): unknown => {
    state.selection = selection ?? null;
    if (selection && "balanceCents" in selection) {
      state.aggregate = (rows) => {
        const balanceCents = rows.reduce(
          (sum, r) =>
            sum + Math.max((r.totalCents as number) - (r.amountPaidCents as number), 0),
          0,
        );
        return [{ balanceCents, openInvoiceCount: rows.length }];
      };
    }
    return builder;
  };
  builder.from = (table: unknown) => {
    state.table = tableName(table);
    return builder;
  };
  builder.innerJoin = (table: unknown, on: Pred) => {
    state.joins.push({ table: tableName(table), on });
    return builder;
  };
  builder.where = (pred: Pred) => {
    state.where = pred;
    return builder;
  };
  builder.orderBy = () => builder;
  builder.limit = (n: number) => Promise.resolve(resolve().slice(0, n));
  builder.then = (onFulfilled: (rows: Row[]) => unknown) =>
    Promise.resolve(resolve()).then(onFulfilled);
  return builder;
}

vi.mock("@/lib/db", () => {
  const nameOf = (table: unknown): string =>
    (Object.values(table as Record<string, unknown>).find(
      (v): v is { __table: string } =>
        typeof v === "object" && v !== null && "__table" in v,
    ) as { __table: string }).__table;
  return {
    db: {
      select: (selection?: Record<string, unknown>) =>
        makeSelectBuilder().select(selection),
      insert: (table: unknown) => ({
        values: (values: Row) => {
          inserts.push({ table: nameOf(table), values });
          return Promise.resolve();
        },
      }),
      batch: async (queries: Promise<unknown>[]) => Promise.all(queries),
    },
  };
});

import {
  getMembershipSummary,
  getNextVisit,
  getOpenBalance,
  getUpcomingAppointment,
  requestReschedule,
} from "./account-tools";
import {
  membershipReply,
  nextVisitReply,
  balanceReply,
  appointmentReply,
  rescheduleReply,
} from "./account-reply";

const ORG_A = "org-a";
const ORG_B = "org-b";
const CUST_1 = "cust-1";
const CUST_2 = "cust-2";

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  inserts.length = 0;
});

// ───────────────────────────────────────────────────────────────────────────
// 4a — cross-CUSTOMER leak prevention (same org, different customer)
// ───────────────────────────────────────────────────────────────────────────
describe("4a. account reads never leak across customers (same org)", () => {
  const future = new Date(Date.now() + 7 * 86400_000);

  it("membership: another customer's active plan is not returned", async () => {
    store.customer_memberships = [
      { id: "m", organizationId: ORG_A, customerId: CUST_2, planId: "p1", status: "active", currentPeriodEnd: null },
    ];
    store.membership_plans = [{ id: "p1", name: "Comfort Club", billingPeriod: "monthly" }];
    expect((await getMembershipSummary(ORG_A, CUST_1)).isMember).toBe(false);
  });

  it("next visit: another customer's visit is not returned", async () => {
    store.customer_memberships = [{ id: "m", organizationId: ORG_A, customerId: CUST_2 }];
    store.membership_visits = [
      { id: "v", organizationId: ORG_A, customerMembershipId: "m", dueDate: future, status: "scheduled" },
    ];
    expect(await getNextVisit(ORG_A, CUST_1)).toBeNull();
  });

  it("balance: another customer's open invoice is not summed", async () => {
    store.invoices = [
      { id: "i", organizationId: ORG_A, customerId: CUST_2, state: "open", totalCents: 9999, amountPaidCents: 0 },
    ];
    store.customers = [{ id: CUST_1, organizationId: ORG_A, portalTokenHash: null }];
    const r = await getOpenBalance(ORG_A, CUST_1);
    expect(r.balanceCents).toBe(0);
    expect(r.openInvoiceCount).toBe(0);
  });

  it("appointment: another customer's request is not returned", async () => {
    store.service_requests = [
      { id: "r", organizationId: ORG_A, customerId: CUST_2, status: "scheduled", referenceNumber: "REF-OTHER", scheduledDate: future, arrivalWindowStart: null, arrivalWindowEnd: null, createdAt: new Date() },
    ];
    expect(await getUpcomingAppointment(ORG_A, CUST_1)).toBeNull();
  });

  it("reschedule: never attaches a hand-off to another customer's request", async () => {
    store.service_requests = [
      { id: "r", organizationId: ORG_A, customerId: CUST_2, status: "scheduled", referenceNumber: "REF-OTHER", scheduledDate: future, arrivalWindowStart: null, arrivalWindowEnd: null, createdAt: new Date() },
    ];
    const r = await requestReschedule(ORG_A, CUST_1, "move it");
    expect(r.recorded).toBe(false);
    expect(inserts).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4b — cross-TENANT leak prevention (same customerId, different org)
// ───────────────────────────────────────────────────────────────────────────
describe("4b. account reads never leak across tenants (same customerId, other org)", () => {
  const future = new Date(Date.now() + 7 * 86400_000);

  it("membership: another tenant's row for the same customerId is not returned", async () => {
    store.customer_memberships = [
      { id: "m", organizationId: ORG_B, customerId: CUST_1, planId: "p1", status: "active", currentPeriodEnd: null },
    ];
    store.membership_plans = [{ id: "p1", name: "Comfort Club", billingPeriod: "monthly" }];
    expect((await getMembershipSummary(ORG_A, CUST_1)).isMember).toBe(false);
  });

  it("next visit: another tenant's visit is not returned", async () => {
    store.customer_memberships = [{ id: "m", organizationId: ORG_B, customerId: CUST_1 }];
    store.membership_visits = [
      { id: "v", organizationId: ORG_B, customerMembershipId: "m", dueDate: future, status: "scheduled" },
    ];
    expect(await getNextVisit(ORG_A, CUST_1)).toBeNull();
  });

  it("balance: another tenant's invoice is not summed", async () => {
    store.invoices = [
      { id: "i", organizationId: ORG_B, customerId: CUST_1, state: "open", totalCents: 5000, amountPaidCents: 0 },
    ];
    store.customers = [{ id: CUST_1, organizationId: ORG_A, portalTokenHash: null }];
    expect((await getOpenBalance(ORG_A, CUST_1)).balanceCents).toBe(0);
  });

  it("appointment: another tenant's request is not returned", async () => {
    store.service_requests = [
      { id: "r", organizationId: ORG_B, customerId: CUST_1, status: "scheduled", referenceNumber: "REF-X", scheduledDate: future, arrivalWindowStart: null, arrivalWindowEnd: null, createdAt: new Date() },
    ];
    expect(await getUpcomingAppointment(ORG_A, CUST_1)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4c — status filtering (terminal/cancelled records never surface)
// ───────────────────────────────────────────────────────────────────────────
describe("4c. account reads exclude terminal / inactive records", () => {
  const future = new Date(Date.now() + 7 * 86400_000);
  const past = new Date(Date.now() - 7 * 86400_000);

  it("membership: a cancelled membership is not 'a member'", async () => {
    store.customer_memberships = [
      { id: "m", organizationId: ORG_A, customerId: CUST_1, planId: "p1", status: "cancelled", currentPeriodEnd: null },
    ];
    store.membership_plans = [{ id: "p1", name: "Comfort Club", billingPeriod: "monthly" }];
    expect((await getMembershipSummary(ORG_A, CUST_1)).isMember).toBe(false);
  });

  it("next visit: a past-due visit is excluded", async () => {
    store.customer_memberships = [{ id: "m", organizationId: ORG_A, customerId: CUST_1 }];
    store.membership_visits = [
      { id: "v", organizationId: ORG_A, customerMembershipId: "m", dueDate: past, status: "scheduled" },
    ];
    expect(await getNextVisit(ORG_A, CUST_1)).toBeNull();
  });

  it("balance: paid/void invoices do not contribute", async () => {
    store.invoices = [
      { id: "i1", organizationId: ORG_A, customerId: CUST_1, state: "paid", totalCents: 9999, amountPaidCents: 9999 },
      { id: "i2", organizationId: ORG_A, customerId: CUST_1, state: "void", totalCents: 4000, amountPaidCents: 0 },
    ];
    store.customers = [{ id: CUST_1, organizationId: ORG_A, portalTokenHash: null }];
    expect((await getOpenBalance(ORG_A, CUST_1)).balanceCents).toBe(0);
  });

  it("appointment: a completed request is excluded", async () => {
    store.service_requests = [
      { id: "r", organizationId: ORG_A, customerId: CUST_1, status: "completed", referenceNumber: "REF-DONE", scheduledDate: future, arrivalWindowStart: null, arrivalWindowEnd: null, createdAt: new Date() },
    ];
    expect(await getUpcomingAppointment(ORG_A, CUST_1)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4d — reply layer: never a price estimate, never a false "booked"
// ───────────────────────────────────────────────────────────────────────────
describe("4d. account reply layer — pricing-safe & no false booking", () => {
  it("balanceReply states an EXISTING balance, never an estimate/quote word", () => {
    const r = balanceReply({ balanceCents: 12500, openInvoiceCount: 2, hasPortalLink: false });
    expect(r).toContain("balance");
    const low = r.toLowerCase();
    expect(low).not.toContain("estimate");
    expect(low).not.toContain("quote");
  });

  it("balanceReply shows $0.00-free copy when nothing is owed", () => {
    const r = balanceReply({ balanceCents: 0, openInvoiceCount: 0, hasPortalLink: false });
    expect(r.toLowerCase()).toContain("don't have any open balance");
  });

  it("rescheduleReply is a HAND-OFF, never says booked/scheduled/confirmed", () => {
    const recorded = rescheduleReply({ recorded: true, referenceNumber: "REF-AAAAA" });
    const unrecorded = rescheduleReply({ recorded: false, referenceNumber: null });
    for (const r of [recorded, unrecorded]) {
      const low = r.toLowerCase();
      expect(low).not.toContain("booked");
      expect(low).not.toContain("scheduled for");
      expect(low).not.toContain("confirmed");
    }
    expect(recorded.toLowerCase()).toContain("follow up");
  });

  it("appointmentReply reports status without promising a NEW time", () => {
    const r = appointmentReply({
      referenceNumber: "REF-AAAAA",
      status: "scheduled",
      scheduledDate: new Date("2026-07-01T13:00:00Z"),
      arrivalWindowStart: null,
      arrivalWindowEnd: null,
    });
    expect(r).toContain("REF-AAAAA");
    // It reports the EXISTING appointment; it must not self-book a new one.
    expect(r.toLowerCase()).not.toContain("i've booked");
  });

  it("membership/nextVisit non-member & no-visit replies are graceful, no PII", () => {
    expect(membershipReply({ isMember: false, planName: null, billingPeriod: null, currentPeriodEnd: null }))
      .toContain("not currently");
    expect(nextVisitReply(null)).toContain("don't see an upcoming maintenance visit");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4e — reschedule records a STAFF NOTE only (no schedule mutation)
// ───────────────────────────────────────────────────────────────────────────
describe("4e. reschedule is a staff hand-off, never a schedule mutation", () => {
  const future = new Date(Date.now() + 2 * 86400_000);

  it("records a request_note and does NOT write the service request", async () => {
    store.service_requests = [
      { id: "r1", organizationId: ORG_A, customerId: CUST_1, status: "scheduled", referenceNumber: "REF-AAAAA", scheduledDate: future, arrivalWindowStart: null, arrivalWindowEnd: null, createdAt: new Date() },
    ];
    const r = await requestReschedule(ORG_A, CUST_1, "prefer next week");
    expect(r.recorded).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("request_notes");
    expect(inserts.some((i) => i.table === "service_requests")).toBe(false);
    // The seeded request is unchanged (no mutation).
    expect((store.service_requests[0] as Row).scheduledDate).toBe(future);
    expect((store.service_requests[0] as Row).status).toBe("scheduled");
  });

  it("clamps an oversized customer note to 500 chars before storing", async () => {
    store.service_requests = [
      { id: "r1", organizationId: ORG_A, customerId: CUST_1, status: "scheduled", referenceNumber: "REF-AAAAA", scheduledDate: future, arrivalWindowStart: null, arrivalWindowEnd: null, createdAt: new Date() },
    ];
    await requestReschedule(ORG_A, CUST_1, "x".repeat(5000));
    const content = String(inserts[0].values.content);
    // Prefix + at most 500 chars of customer detail; nowhere near 5000.
    expect(content.length).toBeLessThan(700);
  });

  it("returns recorded=false (no insert) when there is no upcoming request", async () => {
    store.service_requests = [];
    const r = await requestReschedule(ORG_A, CUST_1, "anytime");
    expect(r.recorded).toBe(false);
    expect(inserts).toHaveLength(0);
  });
});
