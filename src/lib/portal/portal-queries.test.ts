import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  resolvePortalToken,
  getPortalData,
  payPortalInvoice,
  generatePortalToken,
} from "./portal-queries";
import { db } from "@/lib/db";
import { takePayment } from "@/lib/admin/invoice-queries";

// server-only is a no-op in tests (module is server-only by import).
vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

// Decrypt is mocked to a fixed value so the test never needs ENCRYPTION_KEY and
// we can assert the name is decrypted server-side (not shipped as ciphertext).
vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn(() => "Jane Customer"),
}));

// takePayment is the existing payment seam — mocked so payPortalInvoice is tested
// for its OWNERSHIP GUARD + delegation, not the payment mechanics.
vi.mock("@/lib/admin/invoice-queries", () => ({
  takePayment: vi.fn(),
}));

const ORG = "org-1";
const CUSTOMER = "cust-1";

/** Sequence db.select results across calls; each where() is awaitable AND
 * supports .limit() and .orderBy() (both resolve to the same rows). */
function mockSelectSeq(results: unknown[][]) {
  let i = 0;
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: () => ({
          where: () => {
            const r = results[i++] ?? [];
            const p = Promise.resolve(r);
            return Object.assign(p, {
              limit: () => Promise.resolve(r),
              orderBy: () => Promise.resolve(r),
            });
          },
        }),
      }) as never,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("resolvePortalToken", () => {
  it("returns null for an unknown token (no customer matches the hash)", async () => {
    mockSelectSeq([[]]);
    const result = await resolvePortalToken("totally-unknown-token");
    expect(result).toBeNull();
  });

  it("returns null for an empty token without hitting the db", async () => {
    const result = await resolvePortalToken("");
    expect(result).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("resolves a known token to its (org, customer)", async () => {
    mockSelectSeq([[{ organizationId: ORG, customerId: CUSTOMER }]]);
    const result = await resolvePortalToken("a-valid-token");
    expect(result).toEqual({ organizationId: ORG, customerId: CUSTOMER });
  });
});

describe("generatePortalToken", () => {
  it("stores the token HASHED, never the plaintext", async () => {
    // customer-exists read, then the update returns the row.
    mockSelectSeq([[{ id: CUSTOMER }]]);
    const captured: Record<string, unknown>[] = [];
    vi.mocked(db.update).mockReturnValue({
      set: (v: Record<string, unknown>) => {
        captured.push(v);
        return {
          where: () => ({
            returning: () => Promise.resolve([{ id: CUSTOMER }]),
          }),
        };
      },
    } as never);

    const token = await generatePortalToken(ORG, CUSTOMER);
    expect(token).toBeTruthy();

    const set = captured[0];
    expect(set).toBeDefined();
    // A hash column is written...
    expect(typeof set.portalTokenHash).toBe("string");
    // ...and it is NOT the plaintext token (it's a SHA-256 hex digest).
    expect(set.portalTokenHash).not.toBe(token);
    expect(set.portalTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(set.portalTokenCreatedAt).toBeInstanceOf(Date);
  });

  it("returns null when the customer is not in this org", async () => {
    mockSelectSeq([[]]); // customer-exists read -> empty
    const token = await generatePortalToken(ORG, "not-mine");
    expect(token).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("getPortalData", () => {
  it("decrypts the name server-side and strips ALL cost fields from the payload", async () => {
    mockSelectSeq([
      // 1) customer name (encrypted)
      [{ nameEncrypted: "ciphertext-blob" }],
      // 2) invoices
      [
        {
          id: "inv-1",
          state: "open",
          totalCents: 10000,
          amountPaidCents: 4000,
          createdAt: new Date("2026-01-01"),
        },
      ],
      // 3) estimates
      [
        {
          id: "est-1",
          status: "open",
          totalCents: 20000,
          expiresAt: new Date("2026-02-01"),
          approvalTokenHash: "some-hash",
        },
      ],
      // 4) jobs (service requests)
      [
        {
          id: "job-1",
          status: "scheduled",
          issueType: "no_cooling",
          scheduledDate: new Date("2026-01-10"),
          arrivalWindowStart: new Date("2026-01-10T13:00:00Z"),
          arrivalWindowEnd: new Date("2026-01-10T15:00:00Z"),
        },
      ],
      // 5) service history
      [
        {
          id: "hist-1",
          workPerformed: "Replaced capacitor",
          createdAt: new Date("2025-12-01"),
        },
      ],
    ]);

    const data = await getPortalData(ORG, CUSTOMER);

    // Name decrypted server-side (not ciphertext).
    expect(data.customerName).toBe("Jane Customer");

    // Balance computed; invoice shape carries NO cost field.
    expect(data.invoices[0].balanceCents).toBe(6000);

    // The clinching assertion: serialize the WHOLE payload and prove none of the
    // internal cost fields ever appear anywhere in it.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("costCents");
    expect(serialized).not.toContain("unitCostCents");
    expect(serialized).not.toContain("margin");
    // serviceHistory.cost is internal and must not leak either.
    expect(data.history[0]).not.toHaveProperty("cost");

    // Estimate exposes a safe boolean, never the token/hash.
    expect(data.estimates[0].awaitingApproval).toBe(true);
    expect(serialized).not.toContain("approvalTokenHash");
    expect(serialized).not.toContain("some-hash");
  });
});

describe("payPortalInvoice (cross-tenant / cross-customer guard)", () => {
  it("rejects an invoice that does NOT belong to the token's customer — never charges", async () => {
    // The ownership read (org + invoice id + customer id) returns empty: the
    // invoice exists for ANOTHER customer/org, so the scoped query finds nothing.
    mockSelectSeq([[]]);
    const result = await payPortalInvoice(ORG, CUSTOMER, "inv-someone-else", 5000);
    expect(result).toEqual({ ok: false, reason: "invoice_not_found" });
    // Crucially, the payment seam is NEVER reached.
    expect(takePayment).not.toHaveBeenCalled();
  });

  it("charges via takePayment ONLY after the ownership check passes", async () => {
    // Invoice has totalCents=10000, amountPaidCents=0 → balance=10000.
    // Payment amount must exactly equal the balance (full-payment enforcement).
    mockSelectSeq([[{ id: "inv-1", totalCents: 10000, amountPaidCents: 0 }]]);
    vi.mocked(takePayment).mockResolvedValue({
      ok: true,
      paymentId: "pay-1",
      invoiceState: "paid",
    });
    const result = await payPortalInvoice(ORG, CUSTOMER, "inv-1", 10000);
    expect(result).toEqual({ ok: true, invoiceState: "paid" });
    expect(takePayment).toHaveBeenCalledWith(ORG, "inv-1", {
      amountCents: 10000,
    });
  });

  it("rejects a partial payment (amount_mismatch)", async () => {
    // Balance is 10000 but caller sends only 1 cent — portal disallows partials.
    mockSelectSeq([[{ id: "inv-1", totalCents: 10000, amountPaidCents: 0 }]]);
    const result = await payPortalInvoice(ORG, CUSTOMER, "inv-1", 1);
    expect(result).toEqual({ ok: false, reason: "amount_mismatch" });
    expect(takePayment).not.toHaveBeenCalled();
  });

  it("maps a takePayment failure reason through unchanged", async () => {
    // totalCents=10000, amountPaidCents=0 → balance=10000; send exact amount.
    mockSelectSeq([[{ id: "inv-1", totalCents: 10000, amountPaidCents: 0 }]]);
    vi.mocked(takePayment).mockResolvedValue({
      ok: false,
      reason: "invoice_not_chargeable",
    });
    const result = await payPortalInvoice(ORG, CUSTOMER, "inv-1", 10000);
    expect(result).toEqual({ ok: false, reason: "invoice_not_chargeable" });
  });
});
