import { describe, it, expect, vi, beforeEach } from "vitest";

// The submission module is a wide write path (CRM upsert, capacity hold, atomic
// batch, background pushes). We stub every collaborator so the test exercises
// exactly one thing: that the ok result now carries the CONCRETELY-held window
// (and stays null on a soft booking). The window shape is a pure mapping of the
// hold result, so controlling the hold controls the assertion.

const {
  batchMock,
  upsertCustomerByContact,
  pickBookableSlot,
  arrivalWindowForSlot,
  reserveCeilingForBand,
  reserveCapacitySlot,
  releaseReservationById,
  isAfterHours,
} = vi.hoisted(() => ({
  batchMock: vi.fn(),
  upsertCustomerByContact: vi.fn(),
  pickBookableSlot: vi.fn(),
  arrivalWindowForSlot: vi.fn(),
  reserveCeilingForBand: vi.fn(() => 1),
  reserveCapacitySlot: vi.fn(),
  releaseReservationById: vi.fn(async () => {}),
  isAfterHours: vi.fn(() => false),
}));

// A chainable stub covering every query-builder call the module makes; the
// terminal reads (`.limit`, `.batch`) are what actually resolve.
const selectLimit = vi.fn(async () => [
  { doNotService: false, afterHoursConfig: null },
]);
const chain: Record<string, unknown> = {};
Object.assign(chain, {
  from: () => chain,
  where: () => chain,
  limit: selectLimit,
  set: () => chain,
  values: () => chain,
  returning: () => chain,
  onConflictDoUpdate: () => chain,
});

vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    batch: batchMock,
  },
}));
vi.mock("@/lib/db/schema", () => ({
  customerSessions: {},
  serviceRequests: {},
  auditLog: {},
  customers: {},
  organizationSettings: {},
  communicationPreferences: {},
}));
vi.mock("@/lib/admin/crm-queries", () => ({ upsertCustomerByContact }));
vi.mock("@/lib/admin/status-events", () => ({ recordStatusEvent: vi.fn() }));
vi.mock("@/lib/ai/session-outcome", () => ({
  summarizeAndClassifySession: vi.fn(),
}));
vi.mock("@/lib/admin/after-hours", () => ({
  resolveAfterHoursConfig: () => ({}),
  isAfterHours,
}));
vi.mock("@/lib/crypto", () => ({ encrypt: (v: string) => v }));
vi.mock("@/lib/ai/extraction-schema", () => ({
  jobTypeForIssue: () => "repair",
}));
vi.mock("@/lib/admin/availability-queries", () => ({
  getOpenAvailability: vi.fn(async () => []),
  businessDaysFrom: () => ["2026-07-02", "2026-07-03"],
  businessTodayIso: () => "2026-07-02",
}));
vi.mock("@/lib/admin/capacity-hold", () => ({
  pickBookableSlot,
  arrivalWindowForSlot,
  reserveCeilingForBand,
}));
vi.mock("@/lib/admin/capacity-reservation-queries", () => ({
  reserveCapacitySlot,
  releaseReservationById,
}));
vi.mock("@/lib/integrations/housecall-pro/job-sync", () => ({
  pushJobToHcp: vi.fn(),
}));
vi.mock("@/lib/integrations/fieldpulse/job-sync", () => ({
  pushJobToFieldpulse: vi.fn(),
}));
vi.mock("@/lib/admin/crm-equipment-queries", () => ({
  recordCustomerEquipment: vi.fn(),
}));
vi.mock("@/lib/admin/equipment-from-intake", () => ({
  buildEquipmentFromIntake: () => null,
}));
vi.mock("@/lib/context/thread", () => ({ appendEvent: vi.fn() }));
vi.mock("@/lib/requests/persist-job-location", () => ({
  persistJobLocation: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { submitSessionServiceRequest } from "./submit-session-request";
import type { ServiceRequestData } from "@/lib/ai/extraction-schema";

const baseData: ServiceRequestData = {
  issueType: "cooling_not_working",
  urgency: "medium",
  address: "3501 W Market St, Johnson City, TN 37604",
  customerName: "Jane Doe",
  customerPhone: "4238549505",
  customerEmail: null,
  description: "AC not cooling",
} as ServiceRequestData;

const params = {
  organizationId: "org-1",
  sessionId: "sess-1",
  ipAddress: "127.0.0.1",
};

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockResolvedValue([{ doNotService: false, afterHoursConfig: null }]);
  reserveCeilingForBand.mockReturnValue(1);
  isAfterHours.mockReturnValue(false);
  upsertCustomerByContact.mockResolvedValue("cust-1");
  // Request insert row exists → ok path.
  batchMock.mockResolvedValue([[{ id: "req-1" }], undefined, undefined]);
});

describe("submitSessionServiceRequest heldWindow", () => {
  it("carries the concretely-held window when a slot is reserved", async () => {
    pickBookableSlot.mockReturnValue({ day: "2026-07-03", window: "morning" });
    reserveCapacitySlot.mockResolvedValue({ id: "resv-1" });
    arrivalWindowForSlot.mockReturnValue({
      startUtc: new Date("2026-07-03T08:00:00.000Z"),
      endUtc: new Date("2026-07-03T12:00:00.000Z"),
    });

    const result = await submitSessionServiceRequest({
      ...params,
      data: { ...baseData, preferredWindow: "morning" } as ServiceRequestData,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.referenceNumber).toMatch(/^HVAC-/);
    expect(result.heldWindow).toEqual({
      day: "2026-07-03",
      window: "morning",
      startUtc: "2026-07-03T08:00:00.000Z",
      endUtc: "2026-07-03T12:00:00.000Z",
    });
  });

  it("stays null on a soft booking (no preferred window held)", async () => {
    // No preferredWindow → holdConcreteSlot short-circuits to null.
    const result = await submitSessionServiceRequest({
      ...params,
      data: baseData,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.heldWindow).toBeNull();
    expect(reserveCapacitySlot).not.toHaveBeenCalled();
  });

  it("stays null when the preferred band is full (no reservation claimed)", async () => {
    // Band full across the range → pickBookableSlot returns null → soft booking.
    pickBookableSlot.mockReturnValue(null);

    const result = await submitSessionServiceRequest({
      ...params,
      data: { ...baseData, preferredWindow: "morning" } as ServiceRequestData,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.heldWindow).toBeNull();
  });
});
