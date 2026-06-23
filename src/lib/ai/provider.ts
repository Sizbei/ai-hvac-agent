import { createOpenAI } from "@ai-sdk/openai";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizationSettings } from "@/lib/db/schema";
import {
  getRegistryEntry,
  getDefaultEntry,
  type ModelRegistryEntry,
} from "./model-registry";

// Extraction is a mechanical JSON classification task — it can run on a cheaper/
// faster model than the conversational chat. Defaults to the selected chat model
// so there is no behavior change unless AI_EXTRACTION_MODEL is set, in which case
// that overrides ONLY the modelId on the resolved entry (Token-Savings #5).
const EXTRACTION_MODEL_OVERRIDE = process.env.AI_EXTRACTION_MODEL;

/** A registry entry is usable only when its API key env var is actually set. */
function hasKey(entry: ModelRegistryEntry): boolean {
  const key = process.env[entry.apiKeyEnv];
  return typeof key === "string" && key.trim().length > 0;
}

/**
 * Resolve which model entry to use for an org's turn.
 *
 * Falls back to the env-default entry — silently — when ANY of the following is
 * true (a mis-config must NEVER break a customer turn, mirroring the existing
 * routerConfig/afterHoursConfig safe-default pattern):
 *   - no orgId given,
 *   - the org has no selection (aiModelId is NULL),
 *   - the selected id is unknown to the registry,
 *   - the selected entry's API key env var is missing/empty,
 *   - the DB read fails.
 *
 * If the env-default entry's OWN key is also missing, we still return it: the
 * downstream SDK call will surface the error the same way it did before this
 * refactor (the default-key absence is a deploy mis-config, not a per-org one).
 */
export async function resolveModelEntry(
  orgId?: string,
): Promise<ModelRegistryEntry> {
  const fallback = getDefaultEntry();
  if (!orgId) return fallback;

  let selectedId: string | null = null;
  try {
    const [row] = await db
      .select({ aiModelId: organizationSettings.aiModelId })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, orgId))
      .limit(1);
    selectedId = row?.aiModelId ?? null;
  } catch {
    // DB unavailable / schema drift — degrade to the env default.
    return fallback;
  }

  if (!selectedId) return fallback;

  const entry = getRegistryEntry(selectedId);
  if (!entry) return fallback;
  if (!hasKey(entry)) return fallback;

  return entry;
}

/** Build a per-call SDK model handle for a resolved registry entry. */
function buildModel(entry: ModelRegistryEntry, modelId: string) {
  const provider = createOpenAI({
    baseURL: entry.baseUrl,
    apiKey: process.env[entry.apiKeyEnv] ?? "",
  });
  // Use the CHAT COMPLETIONS API explicitly. @ai-sdk/openai's `provider(id)`
  // defaults to the newer Responses API ({input,input_text}), which our
  // OpenAI-compatible endpoints (DashScope, GLM/z.ai) don't all support — qwen-plus
  // tolerated it but qwen-max returns 400. `.chat()` is the correct surface for a
  // Chat-Completions-compatible endpoint and works across all qwen/GLM models.
  return provider.chat(modelId);
}

/**
 * Model for the conversational chat reply. Pass the org id to honor that org's
 * model selection; with no arg it uses the env default (back-compat + the
 * super-admin test panel's raw calls).
 */
export async function getModel(orgId?: string) {
  const entry = await resolveModelEntry(orgId);
  return buildModel(entry, entry.modelId);
}

/**
 * Model for structured extraction. Set AI_EXTRACTION_MODEL to force a cheaper
 * model id on whichever provider the org selected; otherwise uses the selected
 * entry's own model id.
 */
export async function getExtractionModel(orgId?: string) {
  const entry = await resolveModelEntry(orgId);
  return buildModel(entry, EXTRACTION_MODEL_OVERRIDE ?? entry.modelId);
}
