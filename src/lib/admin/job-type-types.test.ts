import { describe, it, expect } from "vitest";
import { jobTypeInputSchema, jobTypePatchSchema, DEFAULT_JOB_TYPES } from "./job-type-types";

describe("jobTypeInputSchema", () => {
  it("accepts a valid job type and trims the name", () => {
    const r = jobTypeInputSchema.safeParse({ name: " Tune-up ", kind: "maintenance", defaultDurationMinutes: 60, defaultPriority: "low" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe("Tune-up");
  });
  it("rejects a duration outside 15..1440, a blank name and an unknown kind", () => {
    expect(jobTypeInputSchema.safeParse({ name: "x", kind: "install", defaultDurationMinutes: 10, defaultPriority: "medium" }).success).toBe(false);
    expect(jobTypeInputSchema.safeParse({ name: "  ", kind: "install", defaultDurationMinutes: 60, defaultPriority: "medium" }).success).toBe(false);
    expect(jobTypeInputSchema.safeParse({ name: "Repair", kind: "repair", defaultDurationMinutes: 60, defaultPriority: "medium" }).success).toBe(false);
  });
  it("patch schema accepts a lone active flag", () => {
    expect(jobTypePatchSchema.safeParse({ active: false }).success).toBe(true);
  });
});

describe("DEFAULT_JOB_TYPES", () => {
  it("covers every job_type enum value exactly once", () => {
    expect([...DEFAULT_JOB_TYPES.map((d) => d.kind)].sort()).toEqual(["diagnostic","estimate","inspection","install","maintenance","no_cool","no_heat","service_call","warranty"]);
  });
});
