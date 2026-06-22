/**
 * Tests for equipment warranty tracking + the proactive expiry-reminder sweep.
 * Mocks the DB + the comms queue + the outbound ledger so we assert WHAT gets
 * enqueued (and that it's tenant-scoped + idempotent) without any real DB/send.
 * Mirrors money-triggers.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  listExpiringWarranties,
  enqueueWarrantyReminders,
} from "./warranty-queries";
import { queueCommunicationJob } from "@/lib/communication/job-queue";
import { claimOutboundOnce } from "@/lib/communication/outbound-ledger";
import { db } from "@/lib/db";

// ── Mocks ──────────────────────────────────────────────────────────────────
vi.mock("@/lib/communication/job-queue", () => ({
  queueCommunicationJob: vi.fn().mockResolvedValue("job-1"),
}));
vi.mock("@/lib/communication/outbound-ledger", () => ({
  claimOutboundOnce: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/admin/org-config-queries", () => ({
  getOrgConfig: vi.fn().mockResolvedValue({
    companyName: "Acme HVAC",
    businessInfo: { phone: "+18005551212" },
    afterHoursConfig: { timezone: "America/New_York" },
  }),
}));
// decrypt is identity here so a stored "value" reads back as itself.
vi.mock("@/lib/crypto", () => ({ decrypt: (s: string) => s }));

// db has both a fluent select() (equipment + customer reads) and db.query
// (template lookup). Build flexible chainables.
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    query: {
      communicationTemplates: { findFirst: vi.fn() },
    },
  },
}));

// withTenant is the org-scoping helper — capture its calls so we can assert the
// equipment query was tenant-scoped. Return a sentinel; the mocked db ignores it.
const withTenantSpy = vi.fn((..._args: unknown[]) => "WHERE");
vi.mock("@/lib/db/tenant", () => ({
  withTenant: (table: unknown, orgId: string, ...rest: unknown[]) =>
    withTenantSpy(table, orgId, ...rest),
}));

const ORG = "org-1";

/** Equipment-list read resolves via `.where()` (no .limit); customer-contact
 *  read resolves via `.where().limit()`. Sequence the select() return shapes. */
function mockSelectSequence(
  results: Array<{ kind: "single" | "list"; rows: Record<string, unknown>[] }>,
) {
  let i = 0;
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            const r = results[i++] ?? { kind: "single", rows: [] };
            if (r.kind === "single") {
              return { limit: vi.fn().mockResolvedValue(r.rows) };
            }
            return Promise.resolve(r.rows);
          }),
        }),
      }) as never,
  );
}

const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000); // 10 days out

beforeEach(() => {
  vi.clearAllMocks();
  withTenantSpy.mockClear();
});

describe("listExpiringWarranties", () => {
  it("is tenant-scoped (org id passed to withTenant)", async () => {
    mockSelectSequence([{ kind: "list", rows: [] }]);
    await listExpiringWarranties(ORG, 30);
    expect(withTenantSpy).toHaveBeenCalledTimes(1);
    // First arg is the table, second is the org id.
    expect(withTenantSpy.mock.calls[0][1]).toBe(ORG);
  });

  it("maps returned rows and drops any with a null expiry", async () => {
    mockSelectSequence([
      {
        kind: "list",
        rows: [
          {
            equipmentId: "eq-1",
            customerId: "cust-1",
            equipmentType: "ac",
            warrantyExpiration: soon,
          },
          // Defensive: a row with null expiry is excluded from the result.
          {
            equipmentId: "eq-2",
            customerId: "cust-2",
            equipmentType: "furnace",
            warrantyExpiration: null,
          },
        ],
      },
    ]);
    const out = await listExpiringWarranties(ORG, 30);
    expect(out).toHaveLength(1);
    expect(out[0].equipmentId).toBe("eq-1");
  });
});

describe("enqueueWarrantyReminders", () => {
  it("enqueues a warranty_expiring SMS (no price) per expiring unit", async () => {
    mockSelectSequence([
      // equipment list
      {
        kind: "list",
        rows: [
          {
            equipmentId: "eq-1",
            customerId: "cust-1",
            equipmentType: "ac",
            warrantyExpiration: soon,
          },
        ],
      },
      // customer contact (single)
      {
        kind: "single",
        rows: [{ phoneEncrypted: "+15551234567", nameEncrypted: "Pat" }],
      },
    ]);
    vi.mocked(db.query.communicationTemplates.findFirst).mockResolvedValue({
      id: "tpl-warr",
    } as never);

    const res = await enqueueWarrantyReminders(ORG);

    expect(res.enqueued).toBe(1);
    expect(queueCommunicationJob).toHaveBeenCalledTimes(1);
    const job = vi.mocked(queueCommunicationJob).mock.calls[0][0];
    expect(job.triggerType).toBe("warranty_expiring");
    expect(job.channel).toBe("sms");
    expect(job.recipientPhone).toBe("+15551234567");
    expect(job.customerId).toBe("cust-1");
    // Never any dollar figure in a warranty nudge.
    expect(JSON.stringify(job.templateVariables)).not.toMatch(/\$\d/);
  });

  it("claims the ledger with a per-equipment monthly periodKey", async () => {
    mockSelectSequence([
      {
        kind: "list",
        rows: [
          {
            equipmentId: "eq-1",
            customerId: "cust-1",
            equipmentType: "ac",
            warrantyExpiration: soon,
          },
        ],
      },
      {
        kind: "single",
        rows: [{ phoneEncrypted: "+15551234567", nameEncrypted: "Pat" }],
      },
    ]);
    vi.mocked(db.query.communicationTemplates.findFirst).mockResolvedValue({
      id: "tpl-warr",
    } as never);

    await enqueueWarrantyReminders(ORG);

    expect(claimOutboundOnce).toHaveBeenCalledTimes(1);
    const claim = vi.mocked(claimOutboundOnce).mock.calls[0][0];
    expect(claim.organizationId).toBe(ORG);
    expect(claim.customerId).toBe("cust-1");
    expect(claim.triggerType).toBe("warranty_expiring");
    expect(claim.periodKey).toMatch(/^warranty:eq-1:\d{4}-\d{2}$/);
  });

  it("is idempotent: a duplicate claim skips the send", async () => {
    mockSelectSequence([
      {
        kind: "list",
        rows: [
          {
            equipmentId: "eq-1",
            customerId: "cust-1",
            equipmentType: "ac",
            warrantyExpiration: soon,
          },
        ],
      },
    ]);
    // Ledger says this unit was already claimed this period.
    vi.mocked(claimOutboundOnce).mockResolvedValue(false);

    const res = await enqueueWarrantyReminders(ORG);

    expect(res.enqueued).toBe(0);
    expect(res.skipped).toBe(1);
    expect(queueCommunicationJob).not.toHaveBeenCalled();
  });

  it("does nothing when no units are expiring", async () => {
    mockSelectSequence([{ kind: "list", rows: [] }]);
    const res = await enqueueWarrantyReminders(ORG);
    expect(res).toEqual({ considered: 0, enqueued: 0, skipped: 0 });
    expect(claimOutboundOnce).not.toHaveBeenCalled();
    expect(queueCommunicationJob).not.toHaveBeenCalled();
  });
});
