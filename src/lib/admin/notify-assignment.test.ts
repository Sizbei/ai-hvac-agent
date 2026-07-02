import { describe, it, expect, vi, beforeEach } from "vitest";

const { triggerAppointmentScheduled, getOrgConfig, selectResults, loggerError } =
  vi.hoisted(() => ({
    triggerAppointmentScheduled: vi.fn(),
    getOrgConfig: vi.fn(),
    // Queue of rows returned by successive db.select() chains, in call order.
    selectResults: [] as unknown[][],
    loggerError: vi.fn(),
  }));

vi.mock("@/lib/communication/triggers", () => ({ triggerAppointmentScheduled }));
vi.mock("@/lib/admin/org-config-queries", () => ({ getOrgConfig }));
vi.mock("@/lib/logger", () => ({
  logger: { error: loggerError, info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/crypto", () => ({
  // Test ciphertext convention: "enc:<plain>" decrypts to <plain>; anything
  // else throws (exercises the safeDecrypt null path).
  decrypt: (v: string) => {
    if (v.startsWith("enc:")) return v.slice(4);
    throw new Error("bad ciphertext");
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => selectResults.shift() ?? [],
        }),
      }),
    }),
  },
}));

import { notifyCustomerOfAssignment } from "./notify-assignment";

// 8 AM–12 PM ET on 2026-07-08 (EDT), stored as the Eastern-anchored instants.
const WINDOW = {
  start: new Date("2026-07-08T12:00:00.000Z"),
  end: new Date("2026-07-08T16:00:00.000Z"),
};

const params = {
  organizationId: "org",
  requestId: "req",
  technicianId: "tech",
  window: WINDOW,
};

const requestRow = {
  customerId: "cust",
  nameEncrypted: "enc:Pat Doe",
  phoneEncrypted: "enc:+14235550100",
  emailEncrypted: null,
  addressEncrypted: "enc:1 Main St",
  issueType: "no_cool",
};

beforeEach(() => {
  vi.clearAllMocks();
  selectResults.length = 0;
  getOrgConfig.mockResolvedValue({
    companyName: "Spears Services",
    businessInfo: { phone: "+14235550999" },
  });
});

describe("notifyCustomerOfAssignment", () => {
  it("queues the scheduled-with-tech message with decrypted fields and business-tz hours", async () => {
    selectResults.push([requestRow], [{ name: "Alex Rivera" }]);

    await notifyCustomerOfAssignment(params);

    expect(triggerAppointmentScheduled).toHaveBeenCalledTimes(1);
    const call = triggerAppointmentScheduled.mock.calls[0]![0];
    expect(call).toMatchObject({
      organizationId: "org",
      serviceRequestId: "req",
      customerId: "cust",
      customerName: "Pat Doe",
      customerPhone: "+14235550100",
      technicianName: "Alex Rivera",
      serviceType: "no cool",
      companyName: "Spears Services",
    });
    // Eastern hours, never raw UTC (12 PM–4 PM would be the UTC bug).
    expect(call.appointmentTime).toContain("8:00");
    expect(call.appointmentTime).toContain("12:00");
    expect(call.appointmentTime).not.toContain("4:00");
  });

  it("skips quietly when the customer has no phone AND no email", async () => {
    selectResults.push(
      [{ ...requestRow, phoneEncrypted: null, emailEncrypted: "not-cipher" }],
      [{ name: "Alex Rivera" }],
    );

    await notifyCustomerOfAssignment(params);

    expect(triggerAppointmentScheduled).not.toHaveBeenCalled();
  });

  it("skips quietly when the request or tech is missing", async () => {
    selectResults.push([], [{ name: "Alex Rivera" }]);
    await notifyCustomerOfAssignment(params);
    expect(triggerAppointmentScheduled).not.toHaveBeenCalled();
  });

  it("never throws when the trigger itself fails", async () => {
    selectResults.push([requestRow], [{ name: "Alex Rivera" }]);
    triggerAppointmentScheduled.mockRejectedValue(new Error("twilio down"));

    await expect(notifyCustomerOfAssignment(params)).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalled();
  });

  it("falls back to default branding when org config fails", async () => {
    selectResults.push([requestRow], [{ name: "Alex Rivera" }]);
    getOrgConfig.mockRejectedValue(new Error("no config"));

    await notifyCustomerOfAssignment(params);

    expect(triggerAppointmentScheduled).toHaveBeenCalledWith(
      expect.objectContaining({ companyName: "Spears Services", phoneNumber: "" }),
    );
  });
});
