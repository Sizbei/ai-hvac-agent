/**
 * Static registry of selectable LLM models for the super-admin model switcher.
 *
 * Pure module — NO I/O, NO DB. Each entry binds a stable `id` (the only thing
 * persisted/audited) to its connection details. The API key lives ONLY as an
 * environment variable referenced BY NAME via `apiKeyEnv`; the key itself is
 * NEVER stored here and NEVER crosses to the client.
 *
 * Adding a model = one array entry + the corresponding env var. The resolver in
 * provider.ts reads the env var at call time (so a key can be rotated without a
 * deploy and a model with no key configured is treated as unavailable).
 *
 * CLIENT-SAFE PROJECTION: `listModelChoices()` returns `{ id, label }` ONLY.
 * `baseUrl` / `apiKeyEnv` / `modelId` and the key MUST NOT reach the client,
 * a response body, or audit/logs.
 */

export interface ModelRegistryEntry {
  /** Stable id persisted in organization_settings.aiModelId and audited. */
  readonly id: string;
  /** Human-readable name shown in the UI. */
  readonly label: string;
  /** OpenAI-compatible base URL for the provider. */
  readonly baseUrl: string;
  /** Name of the env var that holds the API key (NOT the key itself). */
  readonly apiKeyEnv: string;
  /** Provider-specific model identifier passed to the SDK. */
  readonly modelId: string;
}

/** Client-safe shape — the ONLY projection allowed to leave the server. */
export interface ModelChoice {
  readonly id: string;
  readonly label: string;
}

/**
 * The env-default entry id. When an org has no selection (or its selection is
 * unknown / mis-configured), the resolver falls back to this entry, preserving
 * the prior single-model behavior driven by AI_BASE_URL / AI_API_KEY / AI_MODEL.
 */
export const DEFAULT_MODEL_ID = "qwen-dashscope";

export const MODEL_REGISTRY: readonly ModelRegistryEntry[] = [
  {
    id: "qwen-dashscope",
    label: "Qwen (DashScope)",
    baseUrl: process.env.AI_BASE_URL ?? "http://localhost:11434/v1",
    apiKeyEnv: "AI_API_KEY",
    modelId: process.env.AI_MODEL ?? "qwen3:8b",
  },
  {
    id: "glm-4.6",
    label: "GLM-4.6 (z.ai)",
    baseUrl: process.env.GLM_BASE_URL ?? "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "GLM_API_KEY",
    modelId: process.env.GLM_MODEL ?? "glm-4.6",
  },
];

/**
 * The client-safe list of choices for the switcher UI. Returns `{ id, label }`
 * ONLY — never baseUrl / apiKeyEnv / modelId / the key.
 */
export function listModelChoices(): ModelChoice[] {
  return MODEL_REGISTRY.map((entry) => ({ id: entry.id, label: entry.label }));
}

/** Look up a full registry entry by id, or undefined if unknown. */
export function getRegistryEntry(id: string): ModelRegistryEntry | undefined {
  return MODEL_REGISTRY.find((entry) => entry.id === id);
}

/** The env-default entry. Guaranteed present (DEFAULT_MODEL_ID is in the array). */
export function getDefaultEntry(): ModelRegistryEntry {
  const entry = getRegistryEntry(DEFAULT_MODEL_ID);
  // DEFAULT_MODEL_ID is a literal that always matches an array entry above; this
  // throw exists only to satisfy the type and guard against a future typo.
  if (!entry) {
    throw new Error(`DEFAULT_MODEL_ID "${DEFAULT_MODEL_ID}" not in MODEL_REGISTRY`);
  }
  return entry;
}
