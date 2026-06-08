import { z } from "zod";
import { issueTypeValues } from "@/lib/ai/extraction-schema";
import {
  TOKEN_BUDGET_MIN,
  TOKEN_BUDGET_MAX,
  MAX_TURNS_MIN,
  MAX_TURNS_MAX,
} from "@/lib/ai/chat-limits";
import {
  afterHoursConfigSchema,
  DEFAULT_AFTER_HOURS_CONFIG,
  type AfterHoursConfig,
} from "./after-hours";

/**
 * Per-organization chatbot configuration — the shape the admin edits and the
 * widget/router consume. Split into four areas: branding, services offered,
 * business info, and custom FAQs (the last is its own table/endpoint).
 */

/** An https:// URL — rejects javascript:/data:/http: so a stored value is safe
 * to put in an href/src (the logo is rendered, the website may be linked). */
const httpsUrl = (max: number) =>
  z
    .string()
    .url()
    .max(max)
    .refine((u) => u.toLowerCase().startsWith("https://"), {
      message: "Must be an https:// URL",
    });

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

/** Allowlist entry: exact origin (https://acme.com), bare host (acme.com), or
 * wildcard subdomain (*.acme.com), with an optional valid port (1-65535).
 * Permissive on scheme; no paths/spaces/control chars (so it's safe to emit in
 * a CSP frame-ancestors header). */
const PORT = "(?::(?:6553[0-5]|655[0-2]\\d|65[0-4]\\d{2}|6[0-4]\\d{3}|[1-5]\\d{4}|[1-9]\\d{0,3}))?";
const ORIGIN_ENTRY = new RegExp(
  `^(?:https?:\\/\\/)?(?:\\*\\.)?[a-z0-9-]+(?:\\.[a-z0-9-]+)+${PORT}$`,
  "i",
);

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
    website: httpsUrl(300).optional(),
  })
  .strict();

export type BusinessInfo = z.infer<typeof businessInfoSchema>;

/** Full editable config (branding + services + business info). Custom FAQs are
 * managed via their own endpoints. Every field optional so PATCH is partial. */
export const orgConfigUpdateSchema = z
  .object({
    companyName: z.string().min(1).max(120).nullable().optional(),
    logoUrl: httpsUrl(500).nullable().optional(),
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
    allowedOrigins: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(ORIGIN_ENTRY, "Use a domain like acme.com or *.acme.com"),
      )
      .max(50)
      .optional(),
    // Conversation limits. `null` resets to the system default. Bounds mirror
    // the resolve* guards so an out-of-range value is rejected at the boundary.
    chatTokenBudget: z
      .number()
      .int()
      .min(TOKEN_BUDGET_MIN)
      .max(TOKEN_BUDGET_MAX)
      .nullable()
      .optional(),
    chatMaxTurns: z
      .number()
      .int()
      .min(MAX_TURNS_MIN)
      .max(MAX_TURNS_MAX)
      .nullable()
      .optional(),
    // After-hours pricing config. `null` resets to the system default.
    afterHoursConfig: afterHoursConfigSchema.nullable().optional(),
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
  readonly allowedOrigins: readonly string[];
  // null = use the system default (DEFAULT_TOKEN_BUDGET / DEFAULT_MAX_TURNS).
  readonly chatTokenBudget: number | null;
  readonly chatMaxTurns: number | null;
  // Always resolved (defaults applied) so the admin form always has values.
  readonly afterHoursConfig: AfterHoursConfig;
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
  allowedOrigins: [],
  chatTokenBudget: null,
  chatMaxTurns: null,
  afterHoursConfig: DEFAULT_AFTER_HOURS_CONFIG,
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
