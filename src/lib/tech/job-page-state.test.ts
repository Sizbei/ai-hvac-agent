import { describe, it, expect } from "vitest";
import { JOB_NOT_FOUND, PHOTO_UPLOAD_FAILED, jobLoadOutcome } from "./job-page-state";

describe("jobLoadOutcome", () => {
  it("2xx with success is ok", () => expect(jobLoadOutcome(200, true)).toBe("ok"));
  it("404 and 400 are not found", () => {
    expect(jobLoadOutcome(404, false)).toBe("not_found");
    expect(jobLoadOutcome(400, false)).toBe("not_found");
  });
  it("anything else is a load error", () => {
    expect(jobLoadOutcome(500, false)).toBe("error");
    expect(jobLoadOutcome(null, false)).toBe("error");
    expect(jobLoadOutcome(200, false)).toBe("error");
    expect(jobLoadOutcome(401, false)).toBe("error");
  });
});

describe("copy", () => {
  it("not found and photo failure lines", () => {
    expect(JOB_NOT_FOUND).toBe("This job isn't yours, or it no longer exists.");
    expect(PHOTO_UPLOAD_FAILED).toBe("Couldn't upload that photo. Try again.");
  });
});
