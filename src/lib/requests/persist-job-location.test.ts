import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  fetchAddressSuggestions,
  upsertCustomerLocation,
  whereSpy,
  setSpy,
  loggerError,
} = vi.hoisted(() => {
  const whereSpy = vi.fn(async () => {});
  const setSpy = vi.fn(() => ({ where: whereSpy }));
  return {
    fetchAddressSuggestions: vi.fn(),
    upsertCustomerLocation: vi.fn(),
    whereSpy,
    setSpy,
    loggerError: vi.fn(),
  };
});

vi.mock("@/lib/address/photon", () => ({ fetchAddressSuggestions }));
vi.mock("@/lib/admin/location-queries", () => ({ upsertCustomerLocation }));
vi.mock("@/lib/logger", () => ({
  logger: { error: loggerError, info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({
  db: { update: () => ({ set: setSpy }) },
}));

import { persistJobLocation } from "./persist-job-location";

const base = {
  organizationId: "org",
  customerId: "cust",
  serviceRequestId: "req",
  address: "3501 W Market St, Johnson City, TN 37604",
};

beforeEach(() => {
  vi.clearAllMocks();
  upsertCustomerLocation.mockResolvedValue("loc-1");
});

describe("persistJobLocation", () => {
  it("caches coords and links the location when the address geocodes", async () => {
    fetchAddressSuggestions.mockResolvedValue([
      { label: "x", street: null, city: null, state: null, postcode: null, lat: 36.33, lon: -82.38 },
    ]);

    await persistJobLocation(base);

    expect(upsertCustomerLocation).toHaveBeenCalledWith("org", "cust", {
      address: base.address,
      latitude: 36.33,
      longitude: -82.38,
    });
    // request linked to the resolved location (tenant-scoped update issued)
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: "loc-1" }),
    );
    expect(whereSpy).toHaveBeenCalledTimes(1);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("biases the geocode toward the business base", async () => {
    fetchAddressSuggestions.mockResolvedValue([]);
    await persistJobLocation(base);
    expect(fetchAddressSuggestions).toHaveBeenCalledWith(
      base.address,
      expect.objectContaining({ near: expect.objectContaining({ lat: expect.any(Number), lon: expect.any(Number) }) }),
    );
  });

  it("does nothing when no suggestion resolves", async () => {
    fetchAddressSuggestions.mockResolvedValue([]);
    await persistJobLocation(base);
    expect(upsertCustomerLocation).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("skips suggestions without coordinates", async () => {
    fetchAddressSuggestions.mockResolvedValue([
      { label: "x", street: null, city: null, state: null, postcode: null, lat: null, lon: null },
    ]);
    await persistJobLocation(base);
    expect(upsertCustomerLocation).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("does not geocode a blank address", async () => {
    await persistJobLocation({ ...base, address: "   " });
    expect(fetchAddressSuggestions).not.toHaveBeenCalled();
  });

  it("never throws — swallows and logs a geocoder failure", async () => {
    fetchAddressSuggestions.mockRejectedValue(new Error("boom"));
    await expect(persistJobLocation(base)).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("never throws — swallows a db write failure after geocode", async () => {
    fetchAddressSuggestions.mockResolvedValue([
      { label: "x", street: null, city: null, state: null, postcode: null, lat: 1, lon: 2 },
    ]);
    whereSpy.mockRejectedValueOnce(new Error("db down"));
    await expect(persistJobLocation(base)).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledTimes(1);
  });
});
