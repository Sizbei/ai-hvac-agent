import { eq, and, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  organizationSettings,
  customFaqs,
} from "@/lib/db/schema";
import {
  DEFAULT_ORG_CONFIG,
  type OrgConfig,
  type OrgConfigUpdate,
  type LauncherPosition,
  type BusinessInfo,
  type CustomFaq,
  type CustomFaqInput,
} from "./org-config-types";
import {
  EMPTY_ORG_CONFIG,
  type RouterOrgConfig,
} from "@/lib/ai/router-config";
import { resolveAfterHoursConfig } from "./after-hours";

/**
 * Read the resolved chatbot config for an org. Returns DEFAULT_ORG_CONFIG when
 * no settings row exists yet (a brand-new org), so callers never see null.
 */
export async function getOrgConfig(
  organizationId: string,
): Promise<OrgConfig> {
  const [row] = await db
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);

  if (!row) return DEFAULT_ORG_CONFIG;

  return {
    companyName: row.companyName,
    logoUrl: row.logoUrl,
    primaryColor: row.primaryColor,
    welcomeMessage: row.welcomeMessage,
    launcherPosition:
      (row.launcherPosition as LauncherPosition | null) ??
      DEFAULT_ORG_CONFIG.launcherPosition,
    disabledIssueTypes: row.disabledIssueTypes ?? [],
    disabledServiceTags: row.disabledServiceTags ?? [],
    businessInfo: (row.businessInfo as BusinessInfo) ?? {},
    allowedOrigins: row.allowedOrigins ?? [],
    chatTokenBudget: row.chatTokenBudget ?? null,
    chatMaxTurns: row.chatMaxTurns ?? null,
    afterHoursConfig: resolveAfterHoursConfig(row.afterHoursConfig ?? null),
  };
}

/**
 * Apply a PARTIAL config update, creating the settings row if absent. Only the
 * fields present in `update` are written; everything else is preserved. Returns
 * the full resolved config after the write.
 */
export async function updateOrgConfig(
  organizationId: string,
  update: OrgConfigUpdate,
): Promise<OrgConfig> {
  // Build a column patch from only the provided keys so undefined never
  // clobbers an existing value.
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (update.companyName !== undefined) patch.companyName = update.companyName;
  if (update.logoUrl !== undefined) patch.logoUrl = update.logoUrl;
  if (update.primaryColor !== undefined)
    patch.primaryColor = update.primaryColor;
  if (update.welcomeMessage !== undefined)
    patch.welcomeMessage = update.welcomeMessage;
  if (update.launcherPosition !== undefined)
    patch.launcherPosition = update.launcherPosition;
  if (update.disabledIssueTypes !== undefined)
    patch.disabledIssueTypes = update.disabledIssueTypes;
  if (update.disabledServiceTags !== undefined)
    patch.disabledServiceTags = update.disabledServiceTags;
  if (update.businessInfo !== undefined)
    patch.businessInfo = update.businessInfo;
  if (update.allowedOrigins !== undefined)
    patch.allowedOrigins = update.allowedOrigins;
  if (update.chatTokenBudget !== undefined)
    patch.chatTokenBudget = update.chatTokenBudget;
  if (update.chatMaxTurns !== undefined)
    patch.chatMaxTurns = update.chatMaxTurns;
  if (update.afterHoursConfig !== undefined)
    patch.afterHoursConfig = update.afterHoursConfig;

  // Upsert keyed on the org (the PK). onConflictDoUpdate applies the same patch
  // to an existing row. The insert values fill required NOT-NULL JSON columns
  // with their defaults when the row is new.
  await db
    .insert(organizationSettings)
    .values({
      organizationId,
      companyName: update.companyName ?? null,
      logoUrl: update.logoUrl ?? null,
      primaryColor: update.primaryColor ?? null,
      welcomeMessage: update.welcomeMessage ?? null,
      launcherPosition: update.launcherPosition ?? null,
      disabledIssueTypes: update.disabledIssueTypes ?? [],
      disabledServiceTags: update.disabledServiceTags ?? [],
      businessInfo: update.businessInfo ?? {},
      allowedOrigins: update.allowedOrigins ?? [],
      chatTokenBudget: update.chatTokenBudget ?? null,
      chatMaxTurns: update.chatMaxTurns ?? null,
      afterHoursConfig: update.afterHoursConfig ?? null,
    })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: patch,
    });

  invalidateRouterConfig(organizationId);
  return getOrgConfig(organizationId);
}

// Short-TTL in-memory cache for the router overlay. The chat route reads this
// on EVERY turn; settings change rarely, so a brief cache avoids 2 DB reads per
// message. Best-effort: a serverless cold start clears it, and a settings edit
// is reflected within CONFIG_TTL_MS. Invalidated eagerly on writes below.
const CONFIG_TTL_MS = 60_000;
const routerConfigCache = new Map<
  string,
  { value: RouterOrgConfig; expires: number }
>();

/** Drop the cached overlay for an org after a settings/FAQ write so the next
 * chat turn sees the change immediately rather than waiting out the TTL. */
function invalidateRouterConfig(organizationId: string): void {
  routerConfigCache.delete(organizationId);
}

/**
 * Build the overlay the deterministic router consumes for an org: disabled
 * services + business info + ACTIVE custom FAQs. One settings read + one FAQ
 * read (cached for CONFIG_TTL_MS). Falls back to EMPTY_ORG_CONFIG semantics
 * (everything enabled, no personalization) when nothing is configured.
 */
export async function getRouterConfig(
  organizationId: string,
): Promise<RouterOrgConfig> {
  const cached = routerConfigCache.get(organizationId);
  if (cached && cached.expires > Date.now()) {
    return cached.value;
  }

  const [config, faqs] = await Promise.all([
    getOrgConfig(organizationId),
    listCustomFaqs(organizationId),
  ]);

  const value: RouterOrgConfig = {
    ...EMPTY_ORG_CONFIG,
    disabledIssueTypes: config.disabledIssueTypes,
    disabledServiceTags: config.disabledServiceTags,
    businessInfo: config.businessInfo,
    customFaqs: faqs
      .filter((f) => f.isActive)
      .map((f) => ({ id: f.id, answer: f.answer, triggers: f.triggers })),
  };

  routerConfigCache.set(organizationId, {
    value,
    expires: Date.now() + CONFIG_TTL_MS,
  });
  return value;
}

// ── Custom FAQs ──

function toCustomFaq(row: typeof customFaqs.$inferSelect): CustomFaq {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    triggers: row.triggers ?? [],
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listCustomFaqs(
  organizationId: string,
): Promise<readonly CustomFaq[]> {
  const rows = await db
    .select()
    .from(customFaqs)
    .where(eq(customFaqs.organizationId, organizationId))
    .orderBy(desc(customFaqs.createdAt));
  return rows.map(toCustomFaq);
}

export async function createCustomFaq(
  organizationId: string,
  input: CustomFaqInput,
): Promise<CustomFaq> {
  const [row] = await db
    .insert(customFaqs)
    .values({
      organizationId,
      question: input.question,
      answer: input.answer,
      triggers: input.triggers ?? [],
      isActive: input.isActive ?? true,
    })
    .returning();
  if (!row) throw new Error("Failed to create custom FAQ");
  invalidateRouterConfig(organizationId);
  return toCustomFaq(row);
}

export async function updateCustomFaq(
  organizationId: string,
  faqId: string,
  input: Partial<CustomFaqInput>,
): Promise<CustomFaq | null> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.question !== undefined) patch.question = input.question;
  if (input.answer !== undefined) patch.answer = input.answer;
  if (input.triggers !== undefined) patch.triggers = input.triggers;
  if (input.isActive !== undefined) patch.isActive = input.isActive;

  const [row] = await db
    .update(customFaqs)
    .set(patch)
    .where(
      and(
        eq(customFaqs.id, faqId),
        eq(customFaqs.organizationId, organizationId),
      ),
    )
    .returning();
  if (row) invalidateRouterConfig(organizationId);
  return row ? toCustomFaq(row) : null;
}

export async function deleteCustomFaq(
  organizationId: string,
  faqId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(customFaqs)
    .where(
      and(
        eq(customFaqs.id, faqId),
        eq(customFaqs.organizationId, organizationId),
      ),
    )
    .returning({ id: customFaqs.id });
  if (deleted.length > 0) invalidateRouterConfig(organizationId);
  return deleted.length > 0;
}
