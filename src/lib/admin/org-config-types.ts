import { z } from "zod";
import { issueTypeValues } from "@/lib/ai/extraction-schema";

/**
 * Per-organization chatbot configuration — the shape the admin edits and the
 * widget/router consume. Split into four areas: branding, services offered,
 * business info, and custom FAQs (the last is its own table/endpoint).
 */

export const LAUNCHER_POSITIONS = ["bottom-right", "bottom-left"] as const;
export type LauncherPosition = (typeof LAUNCHER_POSITIONS)[number];

/** Knowledge-base intent "service tags" an org can declare it does NOT offer.
 * Matching intents are suppressed/redirected by the router. Kept as a curated
 * list (not the raw KB categories) so the admin sees meaningful service names. */
export const SERVICE_TAGS = [
  "boiler",
  "water_heater",
  "commercial",
  "ductless_minisplit",
  "iaq_products",
  "new_installation",
  "duct_cleaning",
] as const;
export type ServiceTag = (typeof SERVICE_TAGS)[number];

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Business-info fields that personalize the canned FAQ answers. All optional;
 * absent fields fall back to the generic non-committal phrasing. */
export const businessInfoSchema = z
  .object({
    serviceArea: z.string().max(500).optional(),
    businessHours: z.string().max(300).optional(),
    phone: z.string().max(40).optional(),
    licensedInsured: z.string().max(300).optional(),
    financingAvailable: z.boolean().optional(),
    paymentMethods: z.string().max(300).optional(),
    website: z.string().url().max(300).optional(),
  })
  .strict();

export type BusinessInfo = z.infer<typeof businessInfoSchema>;

/** Full editable config (branding + services + business info). Custom FAQs are
 * managed via their own endpoints. Every field optional so PATCH is partial. */
export const orgConfigUpdateSchema = z
  .object({
    companyName: z.string().min(1).max(120).nullable().optional(),
    logoUrl: z.string().url().max(500).nullable().optional(),
    primaryColor: z
      .string()
      .regex(HEX_COLOR, "Must be a hex color like #2563eb")
      .nullable()
      .optional(),
    welcomeMessage: z.string().max(500).nullable().optional(),
    launcherPosition: z.enum(LAUNCHER_POSITIONS).nullable().optional(),
    disabledIssueTypes: z.array(z.enum(issueTypeValues)).optional(),
    disabledServiceTags: z.array(z.enum(SERVICE_TAGS)).optional(),
    businessInfo: businessInfoSchema.optional(),
  })
  .strict();

export type OrgConfigUpdate = z.infer<typeof orgConfigUpdateSchema>;

/** Resolved config returned to the admin/widget — defaults applied. */
export interface OrgConfig {
  readonly companyName: string | null;
  readonly logoUrl: string | null;
  readonly primaryColor: string | null;
  readonly welcomeMessage: string | null;
  readonly launcherPosition: LauncherPosition;
  readonly disabledIssueTypes: readonly string[];
  readonly disabledServiceTags: readonly string[];
  readonly businessInfo: BusinessInfo;
}

export const DEFAULT_ORG_CONFIG: OrgConfig = {
  companyName: null,
  logoUrl: null,
  primaryColor: null,
  welcomeMessage: null,
  launcherPosition: "bottom-right",
  disabledIssueTypes: [],
  disabledServiceTags: [],
  businessInfo: {},
};

// ── Custom FAQ ──
export const customFaqInputSchema = z
  .object({
    question: z.string().min(1).max(300),
    answer: z.string().min(1).max(2000),
    // min 3 so a 1–2 char trigger (e.g. "a") can't match nearly every message
    // and hijack routing. Mirrors MIN_TRIGGER_LENGTH in the router matcher.
    triggers: z.array(z.string().min(3).max(120)).max(20).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type CustomFaqInput = z.infer<typeof customFaqInputSchema>;

export interface CustomFaq {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly triggers: readonly string[];
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}
