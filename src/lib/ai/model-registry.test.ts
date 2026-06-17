import { describe, it, expect } from "vitest";
import {
  MODEL_REGISTRY,
  DEFAULT_MODEL_ID,
  listModelChoices,
  getRegistryEntry,
  getDefaultEntry,
} from "@/lib/ai/model-registry";

describe("model-registry", () => {
  it("includes the env-default and GLM entries", () => {
    const ids = MODEL_REGISTRY.map((e) => e.id);
    expect(ids).toContain("qwen-dashscope");
    expect(ids).toContain("glm-4.6");
  });

  it("DEFAULT_MODEL_ID resolves to a real entry", () => {
    expect(getRegistryEntry(DEFAULT_MODEL_ID)).toBeDefined();
    expect(getDefaultEntry().id).toBe(DEFAULT_MODEL_ID);
  });

  it("listModelChoices exposes ONLY {id,label} — no secrets cross the boundary", () => {
    const choices = listModelChoices();
    expect(choices.length).toBe(MODEL_REGISTRY.length);
    for (const choice of choices) {
      // Exactly the two client-safe keys, nothing more.
      expect(Object.keys(choice).sort()).toEqual(["id", "label"]);
      // Belt-and-suspenders: secret-bearing fields must be absent.
      expect(choice).not.toHaveProperty("baseUrl");
      expect(choice).not.toHaveProperty("apiKeyEnv");
      expect(choice).not.toHaveProperty("modelId");
    }
  });

  it("getRegistryEntry returns undefined for an unknown id", () => {
    expect(getRegistryEntry("does-not-exist")).toBeUndefined();
  });

  it("each entry references its key by env-var NAME, never an inline secret", () => {
    for (const entry of MODEL_REGISTRY) {
      expect(entry.apiKeyEnv).toMatch(/_API_KEY$/);
      // The apiKeyEnv field is a NAME, so it must not look like a real key value.
      expect(entry.apiKeyEnv.length).toBeLessThan(40);
    }
  });
});
