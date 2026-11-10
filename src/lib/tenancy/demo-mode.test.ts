import { describe, it, expect, afterEach } from "vitest";
import { isDemoOrg } from "./demo-mode";

describe("isDemoOrg", () => {
  const saved = process.env.DEMO_MODE_ORG_IDS;
  afterEach(() => {
    if (saved === undefined) delete process.env.DEMO_MODE_ORG_IDS;
    else process.env.DEMO_MODE_ORG_IDS = saved;
  });

  it("is false for an empty or missing list", () => {
    expect(isDemoOrg("o1", "")).toBe(false);
    expect(isDemoOrg("o1", undefined)).toBe(false);
    expect(isDemoOrg("o1", " , ")).toBe(false);
  });

  it("matches a trimmed comma-separated entry exactly", () => {
    expect(isDemoOrg("o1", " o0, o1 ")).toBe(true);
    expect(isDemoOrg("o2", " o0, o1 ")).toBe(false);
    expect(isDemoOrg("o", "o1")).toBe(false);
  });

  it("reads DEMO_MODE_ORG_IDS by default", () => {
    delete process.env.DEMO_MODE_ORG_IDS;
    expect(isDemoOrg("o1")).toBe(false);
    process.env.DEMO_MODE_ORG_IDS = "o1";
    expect(isDemoOrg("o1")).toBe(true);
  });
});
