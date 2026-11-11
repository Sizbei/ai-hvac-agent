import { describe, it, expect } from "vitest";
import { buildFpEstimateStatusLookup, fpEstimateStatusUpdate, resolveFpEstimateStatus } from "./estimate-status";

// Shape and values of GET /estimates/status-workflows for company 182499
// (live, 2026-11-11), trimmed to the fields the mapper reads.
const WORKFLOWS = [
  {
    id: 378855,
    name: "Ordered/Awaiting Parts",
    statuses: [
      { id: 1878567, name: "Estimate", type: "estimate" },
      { id: 1878568, name: "Draft", type: "estimate_draft" },
      { id: 1878569, name: "Sent", type: "estimate_sent" },
      { id: 1878570, name: "Accepted", type: "estimate_accepted" },
      { id: 1878571, name: "Rejected", type: "estimate_rejected" },
      { id: 1878574, name: "Completed", type: "estimate_completed" },
      { id: 1878575, name: "Lost", type: "estimate_lost" },
    ],
  },
  {
    id: 344746,
    name: "Default Workflow",
    statuses: [
      { id: 1878568, name: "Draft", type: "estimate_draft" },
      { id: 1966417, name: "Ordered/Awaiting Parts", type: "estimate_any" },
      { id: 1878572, name: "Scheduled", type: "estimate_any" },
      { id: 2225541, name: "Declined / Expired", type: "estimate_lost" },
    ],
  },
];

const lookup = buildFpEstimateStatusLookup(WORKFLOWS);
const resolve = (statusId: unknown, acceptedAt: unknown = null) =>
  resolveFpEstimateStatus({ statusId, acceptedAt }, lookup);

describe("buildFpEstimateStatusLookup", () => {
  it("flattens every workflow's statuses by id", () => {
    expect(lookup.size).toBe(10);
    expect(lookup.get("2225541")).toEqual({ name: "Declined / Expired", type: "estimate_lost" });
  });

  it("tolerates malformed payloads", () => {
    expect(buildFpEstimateStatusLookup(null).size).toBe(0);
    expect(buildFpEstimateStatusLookup({}).size).toBe(0);
    expect(
      buildFpEstimateStatusLookup([null, { statuses: "x" }, { statuses: [{ id: 1 }, { name: "No id" }, { id: 2, name: "Ok" }] }]),
    ).toEqual(new Map([["2", { name: "Ok", type: null }]]));
  });
});

describe("resolveFpEstimateStatus", () => {
  it("maps rejected and lost buckets to dismissed, keeping the company name", () => {
    expect(resolve(1878571)).toEqual({ status: "dismissed", name: "Rejected" });
    expect(resolve(1878575)).toEqual({ status: "dismissed", name: "Lost" });
    expect(resolve("2225541")).toEqual({ status: "dismissed", name: "Declined / Expired" });
  });

  it("never maps the ambiguous 'Declined / Expired' bucket to expired", () => {
    expect(resolve(2225541).status).not.toBe("expired");
  });

  it("maps the accepted bucket to sold", () => {
    expect(resolve(1878570)).toEqual({ status: "sold", name: "Accepted" });
  });

  it("maps any status with a recorded acceptance to sold", () => {
    expect(resolve(1878574, "2026-07-20 14:00:00")).toEqual({ status: "sold", name: "Completed" });
    expect(resolve(1878572, "2026-08-01 09:00:00")).toEqual({ status: "sold", name: "Scheduled" });
  });

  it("keeps everything else open with its FieldPulse name — never guesses sold", () => {
    expect(resolve(1878568)).toEqual({ status: "open", name: "Draft" });
    expect(resolve(1878569)).toEqual({ status: "open", name: "Sent" });
    expect(resolve(1878567)).toEqual({ status: "open", name: "Estimate" });
    expect(resolve(1878574)).toEqual({ status: "open", name: "Completed" });
    expect(resolve(1966417)).toEqual({ status: "open", name: "Ordered/Awaiting Parts" });
  });

  it("a later rejection outranks an earlier acceptance", () => {
    expect(resolve(2225541, "2026-07-01 10:00:00").status).toBe("dismissed");
  });

  it("an unknown status id has no name and stays open unless accepted", () => {
    expect(resolve(1878573)).toEqual({ status: "open", name: null });
    expect(resolve(1878573, "2026-07-01 10:00:00")).toEqual({ status: "sold", name: null });
    expect(resolve(null)).toEqual({ status: "open", name: null });
  });

  it("treats a blank acceptance as no acceptance", () => {
    expect(resolve(1878569, "")).toEqual({ status: "open", name: "Sent" });
    expect(resolve(1878569, "  ")).toEqual({ status: "open", name: "Sent" });
  });
});

describe("fpEstimateStatusUpdate", () => {
  const update = (statusId: unknown, acceptedAt: unknown = null, l: typeof lookup | null = lookup) =>
    fpEstimateStatusUpdate({ statusId, acceptedAt }, l);

  it("writes status and name for a known status id", () => {
    expect(update(2225541)).toEqual({ status: "dismissed", name: "Declined / Expired" });
    expect(update(1878569)).toEqual({ status: "open", name: "Sent" });
  });

  it("keeps the stored status when the lookup failed or came back empty", () => {
    expect(update(2225541, null, null)).toBeNull();
    expect(update(2225541, "2026-07-01 10:00:00", new Map())).toBeNull();
  });

  it("keeps the stored status and name for an unknown id with no acceptance", () => {
    expect(update(1878573)).toBeNull();
    expect(update(null)).toBeNull();
  });

  it("moves an accepted unknown id to sold without touching the name", () => {
    expect(update(1878573, "2026-07-01 10:00:00")).toEqual({ status: "sold" });
  });
});
