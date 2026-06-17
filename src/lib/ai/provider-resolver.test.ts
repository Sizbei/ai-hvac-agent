import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Resolver fall-back tests. We mock @/lib/db so resolveModelEntry's read
 * returns a controllable `aiModelId`, and mock @ai-sdk/openai so importing
 * provider.ts never touches a real SDK. The assertions are on which registry
 * entry is resolved — NEVER that a secret leaked.
 */

// Holds the value the mocked db.select(...).limit() resolves to.
let mockRow: { aiModelId: string | null } | undefined;
let dbShouldThrow = false;

vi.mock("@/lib/db", () => {
  const limit = vi.fn(async () => {
    if (dbShouldThrow) throw new Error("db down");
    return mockRow ? [mockRow] : [];
  });
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } };
});

vi.mock("@ai-sdk/openai", () => ({
  // createOpenAI(config) returns a factory(modelId) — we capture both so a test
  // could assert the wiring, but the resolver tests below don't need the handle.
  createOpenAI: (config: unknown) => {
    const factory = (modelId: string) => ({ __config: config, __modelId: modelId });
    return factory;
  },
}));

import { resolveModelEntry, getModel } from "@/lib/ai/provider";
import { DEFAULT_MODEL_ID, getRegistryEntry } from "@/lib/ai/model-registry";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  mockRow = undefined;
  dbShouldThrow = false;
  // Default-model key present so the default entry is "configured".
  process.env.AI_API_KEY = "default-key";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.clearAllMocks();
});

describe("resolveModelEntry fall-back behavior", () => {
  it("returns the env default when no orgId is given", async () => {
    const entry = await resolveModelEntry();
    expect(entry.id).toBe(DEFAULT_MODEL_ID);
  });

  it("falls back to env default when aiModelId is NULL", async () => {
    mockRow = { aiModelId: null };
    const entry = await resolveModelEntry("org-1");
    expect(entry.id).toBe(DEFAULT_MODEL_ID);
  });

  it("falls back to env default when the selected id is unknown", async () => {
    mockRow = { aiModelId: "totally-made-up-model" };
    const entry = await resolveModelEntry("org-1");
    expect(entry.id).toBe(DEFAULT_MODEL_ID);
  });

  it("falls back to env default when the selected entry's key env var is empty", async () => {
    mockRow = { aiModelId: "glm-4.6" };
    delete process.env.GLM_API_KEY; // GLM selected but no key configured
    const entry = await resolveModelEntry("org-1");
    expect(entry.id).toBe(DEFAULT_MODEL_ID);
  });

  it("honors the selection when the id is known AND its key is configured", async () => {
    mockRow = { aiModelId: "glm-4.6" };
    process.env.GLM_API_KEY = "glm-secret";
    const entry = await resolveModelEntry("org-1");
    expect(entry.id).toBe("glm-4.6");
  });

  it("falls back to env default when the DB read throws", async () => {
    dbShouldThrow = true;
    const entry = await resolveModelEntry("org-1");
    expect(entry.id).toBe(DEFAULT_MODEL_ID);
  });

  it("getModel builds a handle from the resolved entry's baseUrl/modelId", async () => {
    mockRow = { aiModelId: "glm-4.6" };
    process.env.GLM_API_KEY = "glm-secret";
    const handle = (await getModel("org-1")) as unknown as {
      __config: { baseURL: string };
      __modelId: string;
    };
    const glm = getRegistryEntry("glm-4.6")!;
    expect(handle.__config.baseURL).toBe(glm.baseUrl);
    expect(handle.__modelId).toBe(glm.modelId);
  });
});
