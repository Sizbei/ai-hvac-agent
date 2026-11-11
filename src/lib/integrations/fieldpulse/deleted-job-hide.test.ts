import { describe, it, expect } from "vitest";
import {
  planDeletedJobHide,
  describeDeletedJobRequest,
  type DeletedJobChild,
  type DeletedJobRequest,
} from "./deleted-job-hide";

const req = (id: string, over: Partial<DeletedJobRequest> = {}): DeletedJobRequest => ({
  id,
  referenceNumber: `HVAC-${id.toUpperCase()}0000`,
  status: "pending",
  title: "No heat",
  hidden: false,
  ...over,
});
const child = (id: string, requestId: string, over: Partial<DeletedJobChild> = {}): DeletedJobChild => ({
  kind: "invoice",
  id,
  requestId,
  synced: false,
  paidCents: 0,
  hidden: false,
  ...over,
});

describe("planDeletedJobHide", () => {
  it("hides a deleted job's request and its unpaid FieldPulse-less children", () => {
    const plan = planDeletedJobHide(
      [req("a")],
      [child("i1", "a"), child("e1", "a", { kind: "estimate" }), child("x", "other")],
    );
    expect(plan.requests.map((r) => r.id)).toEqual(["a"]);
    expect(plan.children.map((c) => c.id)).toEqual(["i1", "e1"]);
    expect(plan.kept).toEqual([]);
  });

  it("never hides anything with money paid, and keeps the request visible", () => {
    const plan = planDeletedJobHide([req("a")], [child("i1", "a", { paidCents: 1 }), child("e1", "a", { kind: "estimate" })]);
    expect(plan.requests).toEqual([]);
    expect(plan.children).toEqual([]);
    expect(plan.kept[0]?.reason).toBe("money paid on 1 item");
  });

  it("keeps a request with a synced invoice or estimate for review", () => {
    const plan = planDeletedJobHide([req("a")], [child("i1", "a", { synced: true })]);
    expect(plan.requests).toEqual([]);
    expect(plan.children).toEqual([]);
    expect(plan.kept[0]?.reason).toBe("1 synced invoice or estimate");
  });

  it("leaves already-hidden rows out, so an undo never un-hides another hide", () => {
    const plan = planDeletedJobHide([req("a", { hidden: true })], [child("i1", "a", { hidden: true }), child("i2", "a")]);
    expect(plan.requests).toEqual([]);
    expect(plan.children.map((c) => c.id)).toEqual(["i2"]);
  });

  it("hides a request with no children at all", () => {
    expect(planDeletedJobHide([req("a")], []).requests.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("describeDeletedJobRequest", () => {
  it("prints reference, status and a cut title on one line", () => {
    const line = describeDeletedJobRequest(req("a", { title: "Walk-in cooler\n not   cooling at the back of the kitchen line" }), 20);
    expect(line).toBe("HVAC-A0000  pending      Walk-in cooler not…");
  });
});
