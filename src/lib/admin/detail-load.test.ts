import { describe, it, expect } from "vitest";
import { detailLoadFailure } from "./detail-load";

describe("detailLoadFailure", () => {
  it("404 and a malformed id are not found", () => {
    expect(detailLoadFailure(404)).toBe("not_found");
    expect(detailLoadFailure(400)).toBe("not_found");
  });
  it("a server error or a network failure is a retryable failed load", () => {
    expect(detailLoadFailure(500)).toBe("failed");
    expect(detailLoadFailure(503)).toBe("failed");
    expect(detailLoadFailure(429)).toBe("failed");
    expect(detailLoadFailure(null)).toBe("failed");
  });
});

import { REQUEST_DETAIL_COPY } from "./detail-load";

describe("REQUEST_DETAIL_COPY", () => {
  it("keeps the not-found copy free of any retry language", () => {
    expect(REQUEST_DETAIL_COPY.not_found).toBe("This request no longer exists or isn’t in your organization.");
    expect(REQUEST_DETAIL_COPY.failed).toBe("Couldn’t load this request.");
    expect(detailLoadFailure(404)).toBe("not_found");
  });
});
