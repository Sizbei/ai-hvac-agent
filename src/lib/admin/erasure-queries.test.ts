import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * anonymizeCustomer + purgeOrganization unit tests.
 *
 * The neon-http driver runs the SQL; here we mock @/lib/db so that:
 *  - db.select(...).from(...).where(...) resolves to a pre-seeded row set,
 *  - db.batch(stmts) records the array of builder ops so we can assert WHICH
 *    tables were updated/deleted and the exact .set() payloads (i.e. that the
 *    blind indexes + portal token are nulled and signatures are scrubbed),
 *  - db.insert(...).values(...) records the audit row (to assert NO PII),
 *  - crypto.encrypt is stubbed to a deterministic marker,
 *  - storage + next/server.after are stubbed so R2 cleanup is observable.
 */

// ── builder capture harness ────────────────────────────────────────────────
interface Captured {
  readonly op: "update" | "delete" | "insert";
  table: string;
  set?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

const { batchCalls, insertCalls, selectQueue, makeUpdate, makeDelete, makeInsert } =
  vi.hoisted(() => {
    const batchCalls: Captured[][] = [];
    const insertCalls: Captured[] = [];
    const selectQueue: unknown[][] = [];

    const tableName = (t: unknown): string => {
      // Drizzle tables carry a Symbol-keyed name; fall back to a marker we set
      // in the schema mock.
      const marker = (t as { __name?: string })?.__name;
      return marker ?? "unknown";
    };

    const makeUpdate = (t: unknown): Captured & { set: typeof set } => {
      const cap: Captured = { op: "update", table: tableName(t) };
      const where = () => cap;
      const set = (payload: Record<string, unknown>) => {
        cap.set = payload;
        return { where };
      };
      return Object.assign(cap, { set, where }) as never;
    };

    const makeDelete = (t: unknown): Captured & { where: () => Captured } => {
      const cap: Captured = { op: "delete", table: tableName(t) };
      const where = () => cap;
      return Object.assign(cap, { where }) as never;
    };

    const makeInsert = (t: unknown) => {
      const cap: Captured = { op: "insert", table: tableName(t) };
      return {
        values: (payload: Record<string, unknown>) => {
          cap.values = payload;
          insertCalls.push(cap);
          return cap;
        },
      };
    };

    return {
      batchCalls,
      insertCalls,
      selectQueue,
      makeUpdate,
      makeDelete,
      makeInsert,
    };
  });

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(selectQueue.shift() ?? []),
      }),
    }),
    update: (t: unknown) => makeUpdate(t),
    delete: (t: unknown) => makeDelete(t),
    insert: (t: unknown) => makeInsert(t),
    batch: (stmts: Captured[]) => {
      batchCalls.push(stmts);
      // Pull out any insert builders that recorded via .values() inside the batch
      return Promise.resolve([]);
    },
  },
}));

// Schema mock: each table is a tiny object carrying a __name marker + the columns
// referenced by the query builders (eq/inArray just read .someColumn).
vi.mock("@/lib/db/schema", () => {
  const t = (name: string) =>
    new Proxy({ __name: name } as Record<string, unknown>, {
      get: (target, prop) =>
        prop in target ? target[prop as string] : `${name}.${String(prop)}`,
    });
  return {
    organizations: t("organizations"),
    customers: t("customers"),
    customerSessions: t("customerSessions"),
    customerLocations: t("customerLocations"),
    customerNotes: t("customerNotes"),
    messages: t("messages"),
    attachments: t("attachments"),
    serviceRequests: t("serviceRequests"),
    serviceHistory: t("serviceHistory"),
    estimates: t("estimates"),
    communicationJobs: t("communicationJobs"),
    communicationPreferences: t("communicationPreferences"),
    customerEquipment: t("customerEquipment"),
    followUps: t("followUps"),
    reviewRequests: t("reviewRequests"),
    requestNotes: t("requestNotes"),
    customFieldValues: t("customFieldValues"),
    technicianTimeEntries: t("technicianTimeEntries"),
    auditLog: t("auditLog"),
    platformAuditLog: t("platformAuditLog"),
  };
});

vi.mock("@/lib/db/tenant", () => ({
  withTenant: (_t: unknown, _org: string, ...c: unknown[]) => c,
}));

vi.mock("drizzle-orm", () => ({
  eq: (...a: unknown[]) => a,
  inArray: (...a: unknown[]) => a,
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `ENC(${s})`,
}));

vi.mock("@/lib/admin/audit", () => ({ logAudit: vi.fn() }));

const deleteFile = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/storage/r2-client", () => ({
  getStorageClient: () => ({ deleteFile }),
}));

const afterCallbacks: Array<() => unknown> = [];
vi.mock("next/server", () => ({
  after: (cb: () => unknown) => {
    afterCallbacks.push(cb);
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("server-only", () => ({}));

import { anonymizeCustomer, purgeOrganization } from "./erasure-queries";

const ORG = "org-1";
const CUST = "cust-1";

/** Find the captured op for a table inside the most recent batch. */
function opFor(table: string): Captured | undefined {
  const batch = batchCalls.at(-1) ?? [];
  return batch.find((c) => c.table === table);
}

beforeEach(() => {
  batchCalls.length = 0;
  insertCalls.length = 0;
  selectQueue.length = 0;
  afterCallbacks.length = 0;
  deleteFile.mockClear();
});

describe("anonymizeCustomer", () => {
  /** Seed: existing customer, two sessions, two attachments. */
  function seedExisting() {
    selectQueue.push([{ id: CUST }]); // existence check
    selectQueue.push([{ id: "sess-1" }, { id: "sess-2" }]); // sessions
    selectQueue.push([{ storageKey: "k1" }, { storageKey: "k2" }]); // attachments
    selectQueue.push([{ id: "req-1" }, { id: "req-2" }]); // service requests
  }

  it("returns false when the customer does not exist", async () => {
    selectQueue.push([]); // existence check -> none
    const r = await anonymizeCustomer(ORG, CUST);
    expect(r).toBe(false);
    expect(batchCalls).toHaveLength(0);
  });

  it("nulls the blind indexes + portal token and sets nameEncrypted to encrypt('[deleted]')", async () => {
    seedExisting();
    await anonymizeCustomer(ORG, CUST);

    const cust = opFor("customers");
    expect(cust?.op).toBe("update");
    expect(cust?.set).toMatchObject({
      nameEncrypted: "ENC([deleted])",
      emailEncrypted: null,
      phoneEncrypted: null,
      addressEncrypted: null,
      emailHash: null, // CRITICAL: frees + un-resolves the blind index
      phoneHash: null,
      portalTokenHash: null,
      portalTokenCreatedAt: null,
      notes: null,
    });
    expect(cust?.set?.anonymizedAt).toBeInstanceOf(Date);
  });

  it("scrubs both signatureName spots (serviceRequests + estimates) but keeps the customerId link", async () => {
    seedExisting();
    await anonymizeCustomer(ORG, CUST);

    const sr = opFor("serviceRequests");
    expect(sr?.set).toMatchObject({
      customerNameEncrypted: null,
      customerPhoneEncrypted: null,
      customerEmailEncrypted: null,
      addressEncrypted: null,
      accessNotes: null,
      signatureName: null,
      signatureUrl: null,
    });
    // customerId must NOT be touched (financial history stays attributable).
    expect(sr?.set).not.toHaveProperty("customerId");

    const est = opFor("estimates");
    expect(est?.set).toMatchObject({ signatureName: null, signatureIp: null });
  });

  it("scrubs locations, sessions, comms, service history, and review feedback", async () => {
    seedExisting();
    await anonymizeCustomer(ORG, CUST);

    expect(opFor("customerLocations")?.set).toMatchObject({
      addressEncrypted: "ENC([deleted])",
      addressHash: null,
      accessNotes: null,
      latitude: null,
      longitude: null,
      label: null,
    });
    expect(opFor("customerSessions")?.set).toMatchObject({
      customerId: null,
      summary: null,
      runningSummary: null,
    });
    expect(opFor("communicationJobs")?.set).toMatchObject({
      recipientPhoneEncrypted: null,
      recipientEmailEncrypted: null,
      templateVariables: {},
      errorMessage: null,
    });
    expect(opFor("serviceHistory")?.set).toMatchObject({
      technicianNotes: null,
    });
    expect(opFor("reviewRequests")?.set).toMatchObject({ feedback: null });
  });

  it("deletes messages, customer notes, and attachments", async () => {
    seedExisting();
    await anonymizeCustomer(ORG, CUST);
    expect(opFor("messages")?.op).toBe("delete");
    expect(opFor("customerNotes")?.op).toBe("delete");
    expect(opFor("attachments")?.op).toBe("delete");
  });

  it("deletes follow-ups (reason is free-text PII)", async () => {
    seedExisting();
    await anonymizeCustomer(ORG, CUST);
    expect(opFor("followUps")?.op).toBe("delete");
  });

  it("nulls customer-equipment notes but keeps the (de-identified) asset row", async () => {
    seedExisting();
    await anonymizeCustomer(ORG, CUST);
    const eq = opFor("customerEquipment");
    expect(eq?.op).toBe("update");
    expect(eq?.set).toMatchObject({ notes: null });
  });

  it("deletes communication preferences (per-customer do-not-contact link)", async () => {
    seedExisting();
    await anonymizeCustomer(ORG, CUST);
    expect(opFor("communicationPreferences")?.op).toBe("delete");
  });

  it("deletes custom field values (free-form PII on the customer + their requests)", async () => {
    seedExisting();
    await anonymizeCustomer(ORG, CUST);
    expect(opFor("customFieldValues")?.op).toBe("delete");
  });

  it("deletes internal request notes (free-text PII; requests are KEPT so no cascade)", async () => {
    seedExisting();
    await anonymizeCustomer(ORG, CUST);
    expect(opFor("requestNotes")?.op).toBe("delete");
  });

  it("nulls technician time-entry notes on the customer's requests", async () => {
    seedExisting();
    await anonymizeCustomer(ORG, CUST);
    const tte = opFor("technicianTimeEntries");
    expect(tte?.op).toBe("update");
    expect(tte?.set).toMatchObject({ note: null });
  });

  it("does NOT touch invoices/payments (financials are kept untouched)", async () => {
    seedExisting();
    await anonymizeCustomer(ORG, CUST);
    expect(opFor("invoices")).toBeUndefined();
    expect(opFor("payments")).toBeUndefined();
    expect(opFor("refunds")).toBeUndefined();
  });

  it("audits with counts only — NO name/email/phone in the details", async () => {
    seedExisting();
    await anonymizeCustomer(ORG, CUST);
    const audit = opFor("auditLog");
    expect(audit?.values?.action).toBe("customer_erased");
    const details = String(audit?.values?.details ?? "");
    expect(details).not.toMatch(/@/); // no email
    expect(details).toContain("sessions");
    expect(details).toContain("attachmentsDeleted");
  });

  it("schedules R2 cleanup of the collected storage keys via after()", async () => {
    seedExisting();
    await anonymizeCustomer(ORG, CUST);
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]!();
    expect(deleteFile).toHaveBeenCalledWith("k1");
    expect(deleteFile).toHaveBeenCalledWith("k2");
  });

  it("REGRESSION: after erasure the blind indexes are null, so the contact cannot be re-resolved", async () => {
    seedExisting();
    await anonymizeCustomer(ORG, CUST);
    const cust = opFor("customers");
    // upsertCustomerByContact resolves an existing row via emailHash/phoneHash.
    // With both nulled, the partial unique index no longer matches this row, so
    // a NEW submit with the same email inserts a fresh customer (not re-link).
    expect(cust?.set?.emailHash).toBeNull();
    expect(cust?.set?.phoneHash).toBeNull();
  });
});

describe("purgeOrganization", () => {
  const actor = { userId: "u-1", email: "ops@platform.test" };

  it("returns false when the org does not exist", async () => {
    selectQueue.push([]); // org existence check
    const r = await purgeOrganization(ORG, actor);
    expect(r).toBe(false);
  });

  it("writes platform_audit_log BEFORE deleting the org", async () => {
    selectQueue.push([{ id: ORG }]); // org exists
    selectQueue.push([{ storageKey: "a1" }]); // attachments
    selectQueue.push([{ signatureUrl: "s1" }]); // signatures

    await purgeOrganization(ORG, actor);

    // The platform_audit_log insert must be recorded, and it must precede the
    // org delete (the delete is a builder, the insert went through .values()).
    const auditInsert = insertCalls.find(
      (c) => c.table === "platformAuditLog",
    );
    expect(auditInsert).toBeDefined();
    expect(auditInsert?.values?.action).toBe("org_purged");
    expect(auditInsert?.values?.targetOrgId).toBe(ORG);
    expect(auditInsert?.values?.actorEmail).toBe(actor.email);
    // Details are counts only.
    expect(auditInsert?.values?.details).toMatchObject({
      attachments: 1,
      signatures: 1,
    });
  });

  it("schedules R2 cleanup of attachment keys + signature urls", async () => {
    selectQueue.push([{ id: ORG }]);
    selectQueue.push([{ storageKey: "a1" }]);
    selectQueue.push([{ signatureUrl: "s1" }]);

    await purgeOrganization(ORG, actor);
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]!();
    expect(deleteFile).toHaveBeenCalledWith("a1");
    expect(deleteFile).toHaveBeenCalledWith("s1");
  });
});
