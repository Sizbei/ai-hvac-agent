/**
 * account-tools tests.
 *
 * The DB is mocked with an in-memory dataset and PREDICATE-EVALUATING operators:
 * `eq`/`gte`/`inArray`/`withTenant` return real `(row) => boolean` predicates,
 * and the fake query builder actually FILTERS the seeded rows with them. So a
 * "scoped to this customer/org" assertion is enforced by construction — if a tool
 * forgets the org or customer predicate, the other tenant's/customer's seeded row
 * leaks through and the test fails. This is stronger than asserting call args.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
type Pred = (row: Row) => boolean;

const { tables, store, inserts } = vi.hoisted(() => {
  // Column markers: each column is an object carrying its table + key so the
  // operator mocks can read the row field by key.
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
  // The seeded dataset, keyed by table name. Tests reset/populate it per case.
  const store: Record<string, Row[]> = {};
  const inserts: { table: string; values: Row }[] = [];
  return { tables, store, inserts };
});

vi.mock("@/lib/db/schema", () => tables);

vi.mock("@/lib/db/tenant", () => ({
  // Compose the org filter with the caller's conditions into a single predicate.
  withTenant: (_table: unknown, orgId: string, ...conds: Pred[]): Pred => {
    const orgPred: Pred = (row) => row.organizationId === orgId;
    return (row) => orgPred(row) && conds.every((c) => c(row));
  },
}));

vi.mock("drizzle-orm", () => ({
  // eq(col, value) compares a row field to a literal; eq(col, col) (join ON
  // clauses) compares two row fields — detect a column marker as the 2nd arg.
  eq: (colMarker: { __key: string }, value: unknown): Pred => {
    const isCol =
      typeof value === "object" && value !== null && "__key" in value;
    return (row) =>
      isCol
        ? row[colMarker.__key] === row[(value as { __key: string }).__key]
        : row[colMarker.__key] === value;
  },
  gte: (colMarker: { __key: string }, value: unknown): Pred => {
    return (row) => {
      const v = row[colMarker.__key];
      return v instanceof Date && value instanceof Date
        ? v.getTime() >= value.getTime()
        : (v as number) >= (value as number);
    };
  },
  inArray: (colMarker: { __key: string }, values: unknown[]): Pred => {
    return (row) => values.includes(row[colMarker.__key]);
  },
  and: (...conds: Pred[]): Pred => (row) => conds.every((c) => c(row)),
  desc: (colMarker: { __key: string }) => ({ __order: colMarker.__key, dir: "desc" }),
  sql: (() => {
    const fn = () => ({ __sql: true });
    return fn;
  })(),
}));

// A chainable query builder over the in-memory store. It records the table,
// joins, where predicates, and returns filtered rows. Only the surface the tools
// use is implemented.
function makeSelectBuilder() {
  const state: {
    table: string;
    joins: { table: string; on: Pred }[];
    where: Pred | null;
    aggregate: ((rows: Row[]) => Row[]) | null;
    selection: Record<string, unknown> | null;
  } = { table: "", joins: [], where: null, aggregate: null, selection: null };

  // Loosely typed: it's a chainable test double, not production code.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {};

  const tableName = (table: unknown): string =>
    (Object.values(table as Record<string, unknown>).find(
      (v): v is { __table: string } =>
        typeof v === "object" && v !== null && "__table" in v,
    ) as { __table: string }).__table;

  const resolve = (): Row[] => {
    let rows = (store[state.table] ?? []).slice();
    // Apply joins: keep only rows whose join condition matches some joined row,
    // and merge the joined row's fields (innerJoin semantics, single match).
    for (const join of state.joins) {
      const joinRows = store[join.table] ?? [];
      rows = rows.flatMap((row) => {
        const matches = joinRows.filter((jr) => join.on({ ...row, ...jr }));
        return matches.map((jr) => ({ ...jr, ...row }));
      });
    }
    if (state.where) rows = rows.filter(state.where);
    if (state.aggregate) return state.aggregate(rows);
    // Apply the SELECT projection: map each alias -> the row field named by its
    // column marker's __key (so `planName: membershipPlans.name` reads `name`).
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
    // Detect an aggregate selection (balanceCents/openInvoiceCount) and compute it.
    if (selection && "balanceCents" in selection) {
      state.aggregate = (rows) => {
        const balanceCents = rows.reduce(
          (sum, r) =>
            sum +
            Math.max(
              (r.totalCents as number) - (r.amountPaidCents as number),
              0,
            ),
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
  // Aggregates resolve without limit (awaited directly).
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

const ORG_A = "org-a";
const ORG_B = "org-b";
const CUST_1 = "cust-1";
const CUST_2 = "cust-2";

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  inserts.length = 0;
});

describe("getMembershipSummary", () => {
  it("returns the active membership + plan name for the scoped customer", async () => {
    store.customer_memberships = [
      {
        id: "m1",
        organizationId: ORG_A,
        customerId: CUST_1,
        planId: "p1",
        status: "active",
        currentPeriodEnd: new Date("2026-07-01"),
      },
    ];
    store.membership_plans = [
      { id: "p1", name: "Comfort Club", billingPeriod: "monthly" },
    ];
    const r = await getMembershipSummary(ORG_A, CUST_1);
    expect(r.isMember).toBe(true);
    expect(r.planName).toBe("Comfort Club");
    expect(r.billingPeriod).toBe("monthly");
  });

  it("does NOT return another customer's membership", async () => {
    store.customer_memberships = [
      { id: "m2", organizationId: ORG_A, customerId: CUST_2, planId: "p1", status: "active", currentPeriodEnd: null },
    ];
    store.membership_plans = [{ id: "p1", name: "Comfort Club", billingPeriod: "monthly" }];
    const r = await getMembershipSummary(ORG_A, CUST_1);
    expect(r.isMember).toBe(false);
  });

  it("does NOT return a membership from another org (same customerId)", async () => {
    store.customer_memberships = [
      { id: "m3", organizationId: ORG_B, customerId: CUST_1, planId: "p1", status: "active", currentPeriodEnd: null },
    ];
    store.membership_plans = [{ id: "p1", name: "Comfort Club", billingPeriod: "monthly" }];
    const r = await getMembershipSummary(ORG_A, CUST_1);
    expect(r.isMember).toBe(false);
  });

  it("ignores a cancelled membership (status != active)", async () => {
    store.customer_memberships = [
      { id: "m4", organizationId: ORG_A, customerId: CUST_1, planId: "p1", status: "cancelled", currentPeriodEnd: null },
    ];
    store.membership_plans = [{ id: "p1", name: "Comfort Club", billingPeriod: "monthly" }];
    const r = await getMembershipSummary(ORG_A, CUST_1);
    expect(r.isMember).toBe(false);
  });
});

describe("getNextVisit", () => {
  const future = new Date(Date.now() + 7 * 86400_000);
  const past = new Date(Date.now() - 7 * 86400_000);

  it("returns the soonest upcoming scheduled visit for the scoped customer", async () => {
    store.customer_memberships = [
      { id: "m1", organizationId: ORG_A, customerId: CUST_1 },
    ];
    store.membership_visits = [
      { id: "v1", organizationId: ORG_A, customerMembershipId: "m1", dueDate: future, status: "scheduled" },
    ];
    const r = await getNextVisit(ORG_A, CUST_1);
    expect(r?.status).toBe("scheduled");
    expect(r?.dueDate.getTime()).toBe(future.getTime());
  });

  it("excludes past-due visits", async () => {
    store.customer_memberships = [{ id: "m1", organizationId: ORG_A, customerId: CUST_1 }];
    store.membership_visits = [
      { id: "v1", organizationId: ORG_A, customerMembershipId: "m1", dueDate: past, status: "scheduled" },
    ];
    expect(await getNextVisit(ORG_A, CUST_1)).toBeNull();
  });

  it("does NOT return another customer's visit", async () => {
    store.customer_memberships = [{ id: "m2", organizationId: ORG_A, customerId: CUST_2 }];
    store.membership_visits = [
      { id: "v2", organizationId: ORG_A, customerMembershipId: "m2", dueDate: future, status: "scheduled" },
    ];
    expect(await getNextVisit(ORG_A, CUST_1)).toBeNull();
  });
});

describe("getOpenBalance", () => {
  it("sums (total - paid) over OPEN invoices only, excluding paid/void", async () => {
    store.invoices = [
      { id: "i1", organizationId: ORG_A, customerId: CUST_1, state: "open", totalCents: 10000, amountPaidCents: 2500 },
      { id: "i2", organizationId: ORG_A, customerId: CUST_1, state: "open", totalCents: 5000, amountPaidCents: 0 },
      { id: "i3", organizationId: ORG_A, customerId: CUST_1, state: "paid", totalCents: 9999, amountPaidCents: 9999 },
      { id: "i4", organizationId: ORG_A, customerId: CUST_1, state: "void", totalCents: 4000, amountPaidCents: 0 },
    ];
    store.customers = [{ id: CUST_1, organizationId: ORG_A, portalTokenHash: null }];
    const r = await getOpenBalance(ORG_A, CUST_1);
    expect(r.balanceCents).toBe(12500); // 7500 + 5000
    expect(r.openInvoiceCount).toBe(2);
    expect(r.hasPortalLink).toBe(false);
  });

  it("does NOT sum another customer's open invoices", async () => {
    store.invoices = [
      { id: "i5", organizationId: ORG_A, customerId: CUST_2, state: "open", totalCents: 8000, amountPaidCents: 0 },
    ];
    store.customers = [{ id: CUST_1, organizationId: ORG_A, portalTokenHash: null }];
    const r = await getOpenBalance(ORG_A, CUST_1);
    expect(r.balanceCents).toBe(0);
    expect(r.openInvoiceCount).toBe(0);
  });

  it("reports an active portal link when the customer has a token hash", async () => {
    store.invoices = [];
    store.customers = [{ id: CUST_1, organizationId: ORG_A, portalTokenHash: "abc123" }];
    const r = await getOpenBalance(ORG_A, CUST_1);
    expect(r.hasPortalLink).toBe(true);
  });
});

describe("getUpcomingAppointment", () => {
  const future = new Date(Date.now() + 2 * 86400_000);

  it("returns the customer's upcoming non-terminal request", async () => {
    store.service_requests = [
      {
        id: "r1",
        organizationId: ORG_A,
        customerId: CUST_1,
        status: "scheduled",
        referenceNumber: "REF-AAAAA",
        scheduledDate: future,
        arrivalWindowStart: null,
        arrivalWindowEnd: null,
        createdAt: new Date(),
      },
    ];
    const r = await getUpcomingAppointment(ORG_A, CUST_1);
    expect(r?.referenceNumber).toBe("REF-AAAAA");
    expect(r?.status).toBe("scheduled");
  });

  it("excludes completed/cancelled requests", async () => {
    store.service_requests = [
      { id: "r2", organizationId: ORG_A, customerId: CUST_1, status: "completed", referenceNumber: "REF-DONE", scheduledDate: future, arrivalWindowStart: null, arrivalWindowEnd: null, createdAt: new Date() },
    ];
    expect(await getUpcomingAppointment(ORG_A, CUST_1)).toBeNull();
  });

  it("does NOT return another customer's appointment", async () => {
    store.service_requests = [
      { id: "r3", organizationId: ORG_A, customerId: CUST_2, status: "scheduled", referenceNumber: "REF-OTHER", scheduledDate: future, arrivalWindowStart: null, arrivalWindowEnd: null, createdAt: new Date() },
    ];
    expect(await getUpcomingAppointment(ORG_A, CUST_1)).toBeNull();
  });
});

describe("requestReschedule", () => {
  const future = new Date(Date.now() + 2 * 86400_000);

  it("records a request note hand-off and does NOT mutate the schedule", async () => {
    store.service_requests = [
      { id: "r1", organizationId: ORG_A, customerId: CUST_1, status: "scheduled", referenceNumber: "REF-AAAAA", scheduledDate: future, arrivalWindowStart: null, arrivalWindowEnd: null, createdAt: new Date() },
    ];
    const r = await requestReschedule(ORG_A, CUST_1, "prefer next week");
    expect(r.recorded).toBe(true);
    expect(r.referenceNumber).toBe("REF-AAAAA");
    // A note was inserted...
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("request_notes");
    expect(inserts[0].values.requestId).toBe("r1");
    expect(inserts[0].values.organizationId).toBe(ORG_A);
    expect(inserts[0].values.authorId).toBeNull();
    expect(String(inserts[0].values.content)).toContain("prefer next week");
    // ...and NO write touched the service request (no schedule mutation).
    expect(inserts.some((i) => i.table === "service_requests")).toBe(false);
    // The seeded request's scheduledDate is unchanged.
    expect((store.service_requests[0] as Row).scheduledDate).toBe(future);
    expect((store.service_requests[0] as Row).status).toBe("scheduled");
  });

  it("returns recorded=false (no note) when there is no upcoming appointment", async () => {
    store.service_requests = [];
    const r = await requestReschedule(ORG_A, CUST_1, "anytime");
    expect(r.recorded).toBe(false);
    expect(inserts).toHaveLength(0);
  });

  it("does NOT attach a hand-off to another customer's request", async () => {
    store.service_requests = [
      { id: "r9", organizationId: ORG_A, customerId: CUST_2, status: "scheduled", referenceNumber: "REF-OTHER", scheduledDate: future, arrivalWindowStart: null, arrivalWindowEnd: null, createdAt: new Date() },
    ];
    const r = await requestReschedule(ORG_A, CUST_1, "move it");
    expect(r.recorded).toBe(false);
    expect(inserts).toHaveLength(0);
  });
});
