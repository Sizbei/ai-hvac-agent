import { describe, it, expect, vi } from "vitest";
import { runCreateRequest, type CreateRequestDeps } from "./create-request-flow";
import { parseCreateRequestBody, type CreateRequestInput } from "./create-request";

const TODAY = "2026-11-02";
const TECH = "22222222-2222-4222-8222-222222222222";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";

function input(extra: Record<string, unknown> = {}): CreateRequestInput {
  const r = parseCreateRequestBody(
    {
      customerId: CUSTOMER,
      address: "12 Main St",
      issueType: "water_leak",
      urgency: "medium",
      description: "Leak",
      ...extra,
    },
    TODAY,
  );
  if (!r.ok) throw new Error(r.message);
  return r.data;
}

const withTech = { schedule: { isoDay: "2026-11-03", window: "morning", technicianId: TECH } };
const windowOnly = { schedule: { isoDay: "2026-11-03", window: "afternoon" } };

function deps(over: Partial<CreateRequestDeps> = {}) {
  const calls: string[] = [];
  const track =
    <T,>(name: string, value: T) =>
    vi.fn(async () => {
      calls.push(name);
      return value;
    });
  const d: CreateRequestDeps = {
    verifyTechnician: track("verifyTechnician", true),
    checkTechnicianWindow: track("checkTechnicianWindow", null),
    resolveCustomer: track("resolveCustomer", { id: CUSTOMER }),
    insertRequest: track("insertRequest", { requestId: "req-1", referenceNumber: "HVAC-1" }),
    recordCreated: track("recordCreated", undefined),
    place: track("place", {
      ok: true as const,
      arrivalWindowStart: "a",
      arrivalWindowEnd: "b",
      assignedTo: TECH,
      overridden: false,
    }),
    markAssigned: track("markAssigned", undefined),
    reserveCapacity: track("reserveCapacity", undefined),
    scheduleBackground: vi.fn(() => {
      calls.push("scheduleBackground");
    }),
    logError: vi.fn(),
    ...over,
  };
  return { d, calls };
}

describe("runCreateRequest — gate ordering", () => {
  it("a conflict returns before anything is written", async () => {
    const detail = { conflicts: [], outsideAvailability: true };
    const { d, calls } = deps({ checkTechnicianWindow: vi.fn(async () => detail) });
    const r = await runCreateRequest(d, input(withTech));
    expect(r).toEqual({ ok: false, reason: "conflict", detail });
    expect(d.resolveCustomer).not.toHaveBeenCalled();
    expect(d.insertRequest).not.toHaveBeenCalled();
    expect(calls).toEqual(["verifyTechnician"]);
  });

  it("an unknown technician is refused before the conflict check and the insert", async () => {
    const { d } = deps({ verifyTechnician: vi.fn(async () => false) });
    const r = await runCreateRequest(d, input(withTech));
    expect(r).toEqual({ ok: false, reason: "technician_not_found" });
    expect(d.checkTechnicianWindow).not.toHaveBeenCalled();
    expect(d.insertRequest).not.toHaveBeenCalled();
  });

  it("override proceeds past a job clash but still checks the window and the technician", async () => {
    const jobClash = {
      conflicts: [
        { id: "j1", referenceNumber: "HVAC-9", status: "assigned", assignedTo: TECH, arrivalWindowStart: "a", arrivalWindowEnd: "b" },
      ],
      outsideAvailability: true,
    };
    const { d } = deps({ checkTechnicianWindow: vi.fn(async () => jobClash) });
    const r = await runCreateRequest(d, input({ ...withTech, override: true }));
    expect(r.ok).toBe(true);
    expect(d.verifyTechnician).toHaveBeenCalledOnce();
    expect(d.checkTechnicianWindow).toHaveBeenCalledOnce();
    expect(d.place).toHaveBeenCalledWith("req-1", expect.objectContaining({ kind: "assign" }), expect.anything(), true);
  });

  it("override + a time-off clash is still a conflict and nothing is inserted", async () => {
    const detail = {
      conflicts: [
        { id: "s1", referenceNumber: "Time off", status: "assigned", assignedTo: TECH, arrivalWindowStart: "a", arrivalWindowEnd: "b", timeOff: true },
      ],
      outsideAvailability: false,
    };
    const { d } = deps({ checkTechnicianWindow: vi.fn(async () => detail) });
    const r = await runCreateRequest(d, input({ ...withTech, override: true }));
    expect(r).toEqual({ ok: false, reason: "conflict", detail });
    expect(d.resolveCustomer).not.toHaveBeenCalled();
    expect(d.insertRequest).not.toHaveBeenCalled();
    expect(d.place).not.toHaveBeenCalled();
  });

  it("customer refusals happen before the insert", async () => {
    const { d } = deps({ resolveCustomer: vi.fn(async () => "do_not_service" as const) });
    expect(await runCreateRequest(d, input())).toEqual({ ok: false, reason: "do_not_service" });
    expect(d.insertRequest).not.toHaveBeenCalled();
  });
});

describe("runCreateRequest — schedule paths", () => {
  it("no schedule: inserts, never places", async () => {
    const { d, calls } = deps();
    const r = await runCreateRequest(d, input());
    expect(r).toEqual({ ok: true, requestId: "req-1", referenceNumber: "HVAC-1", schedule: { kind: "none" } });
    expect(calls).toEqual(["resolveCustomer", "insertRequest", "recordCreated", "scheduleBackground"]);
  });

  it("window only: places and reserves capacity, does not mark assigned", async () => {
    const { d } = deps({
      place: vi.fn(async () => ({ ok: true as const, arrivalWindowStart: "a", arrivalWindowEnd: "b", assignedTo: null, overridden: false })),
    });
    const r = await runCreateRequest(d, input(windowOnly));
    expect(r.ok && r.schedule.kind).toBe("placed");
    expect(d.reserveCapacity).toHaveBeenCalledWith("req-1", "2026-11-03", "afternoon");
    expect(d.markAssigned).not.toHaveBeenCalled();
  });

  it("technician booking: places and marks assigned, no capacity reservation", async () => {
    const { d } = deps();
    const r = await runCreateRequest(d, input(withTech));
    expect(r.ok && r.schedule).toEqual({ kind: "placed", arrivalWindowStart: "a", arrivalWindowEnd: "b", assignedTo: TECH, overridden: false });
    expect(d.markAssigned).toHaveBeenCalledWith("req-1", TECH);
    expect(d.reserveCapacity).not.toHaveBeenCalled();
  });

  it("the placement losing a race reports failed, request kept", async () => {
    const { d } = deps({ place: vi.fn(async () => ({ ok: false as const, reason: "conflict" })) });
    const r = await runCreateRequest(d, input(withTech));
    expect(r).toEqual({ ok: true, requestId: "req-1", referenceNumber: "HVAC-1", schedule: { kind: "failed" } });
    expect(d.markAssigned).not.toHaveBeenCalled();
  });
});

describe("runCreateRequest — nothing after the insert can fail the create", () => {
  it.each([
    ["place", { place: vi.fn(async () => { throw new Error("boom"); }) }],
    ["markAssigned", { markAssigned: vi.fn(async () => { throw new Error("boom"); }) }],
    ["recordCreated", { recordCreated: vi.fn(async () => { throw new Error("boom"); }) }],
  ] as const)("a throw in %s returns ok with schedule failed and the reference", async (_name, over) => {
    const { d } = deps(over as Partial<CreateRequestDeps>);
    const r = await runCreateRequest(d, input(withTech));
    expect(r).toEqual({ ok: true, requestId: "req-1", referenceNumber: "HVAC-1", schedule: { kind: "failed" } });
    expect(d.logError).toHaveBeenCalled();
  });

  it("a throw with no schedule still returns ok / none", async () => {
    const { d } = deps({ recordCreated: vi.fn(async () => { throw new Error("boom"); }) });
    const r = await runCreateRequest(d, input());
    expect(r.ok && r.schedule).toEqual({ kind: "none" });
  });

  it("a throw while queueing background work is swallowed", async () => {
    const { d } = deps({ scheduleBackground: vi.fn(() => { throw new Error("boom"); }) });
    expect((await runCreateRequest(d, input())).ok).toBe(true);
  });

  it("an insert failure propagates (nothing committed, safe to retry)", async () => {
    const { d } = deps({ insertRequest: vi.fn(async () => { throw new Error("db down"); }) });
    await expect(runCreateRequest(d, input())).rejects.toThrow("db down");
  });
});
