import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the connection storage so config resolution never touches the DB.
const getOrgHousecallApiKey = vi.fn<
  (organizationId: string) => Promise<string | null>
>();
vi.mock("./connection-queries", () => ({
  getOrgHousecallApiKey: (organizationId: string) =>
    getOrgHousecallApiKey(organizationId),
}));

import { getHousecallConfig } from "./config";

const savedEnv = { ...process.env };

beforeEach(() => {
  getOrgHousecallApiKey.mockReset();
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("getHousecallConfig", () => {
  it("returns null when neither a connection nor an env key exists", async () => {
    delete process.env.HOUSECALL_API_KEY;
    getOrgHousecallApiKey.mockResolvedValue(null);
    expect(await getHousecallConfig("org-1")).toBeNull();
  });

  it("uses the per-org connection key when present", async () => {
    process.env.HOUSECALL_API_KEY = "env-key";
    getOrgHousecallApiKey.mockResolvedValue("org-key");
    const config = await getHousecallConfig("org-1");
    // The org's own key WINS over the env fallback.
    expect(config?.apiKey).toBe("org-key");
  });

  it("falls back to the env key when no connection exists", async () => {
    process.env.HOUSECALL_API_KEY = "env-key";
    getOrgHousecallApiKey.mockResolvedValue(null);
    const config = await getHousecallConfig("org-1");
    expect(config?.apiKey).toBe("env-key");
  });

  it("treats a blank env key as not configured", async () => {
    process.env.HOUSECALL_API_KEY = "   ";
    getOrgHousecallApiKey.mockResolvedValue(null);
    expect(await getHousecallConfig("org-1")).toBeNull();
  });

  it("defaults to the production base URL and allows an override", async () => {
    getOrgHousecallApiKey.mockResolvedValue("org-key");
    const prod = await getHousecallConfig("org-1");
    expect(prod?.baseUrl).toBe("https://api.housecallpro.com");
    const overridden = await getHousecallConfig(
      "org-1",
      "https://api.housecallpro.test",
    );
    expect(overridden?.baseUrl).toBe("https://api.housecallpro.test");
  });
});
