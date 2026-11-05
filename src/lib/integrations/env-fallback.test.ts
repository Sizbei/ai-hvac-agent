import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { envKeyFallbackAllowed } from "./env-fallback";
import { DEMO_ORG_ID } from "@/lib/tenancy/organization";

const OTHER = "1dae7b56-64a2-41c6-a512-112904cf8e98";
const saved = process.env.PLATFORM_ORG_ID;
afterEach(() => {
  if (saved === undefined) delete process.env.PLATFORM_ORG_ID;
  else process.env.PLATFORM_ORG_ID = saved;
});

describe("envKeyFallbackAllowed", () => {
  it("allows only the default org when PLATFORM_ORG_ID is unset", () => {
    delete process.env.PLATFORM_ORG_ID;
    expect(envKeyFallbackAllowed(DEMO_ORG_ID)).toBe(true);
    expect(envKeyFallbackAllowed(OTHER)).toBe(false);
  });
  it("follows PLATFORM_ORG_ID when set", () => {
    process.env.PLATFORM_ORG_ID = OTHER;
    expect(envKeyFallbackAllowed(OTHER)).toBe(true);
    expect(envKeyFallbackAllowed(DEMO_ORG_ID)).toBe(false);
  });
});
