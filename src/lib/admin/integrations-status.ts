/**
 * DERIVED integration status for the unified admin Integrations page.
 *
 * This is a READ-ONLY aggregator. Status is computed at request time from the
 * existing per-org connection queries (key-free), the payment/financing
 * provider seams (.name), env-presence checks (server-side process.env), and the
 * org's AI model selection. Nothing here is stored — there is NO table.
 *
 * SECRECY CONTRACT: the returned objects carry ONLY booleans, enums, labels, and
 * short non-secret detail strings. No API key, token, secret, or env VALUE ever
 * appears in the output — only whether one is PRESENT, and (for connections that
 * cache non-secret account metadata) a company name. This whole module is
 * server-only and its result is safe to send to the client.
 */
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizationSettings } from "@/lib/db/schema";
import { getFieldpulseConnectionStatus } from "@/lib/integrations/fieldpulse/connection-queries";
import { getHousecallConnectionStatus } from "@/lib/integrations/housecall-pro/connection-queries";
import { getGoogleConnectionStatus } from "@/lib/integrations/google-calendar/connection-queries";
import { getPaymentProvider } from "@/lib/payments/provider";
import { getFinancingProvider } from "@/lib/financing/provider";
import { getRegistryEntry } from "@/lib/ai/model-registry";

/** Where the integration sits in the page's grouped layout. */
export type IntegrationCategory =
  | "FSM"
  | "payments"
  | "financing"
  | "comms"
  | "ai";

/**
 * Derived status of one integration.
 *  - "connected"      — a per-org connection exists (FSM/calendar).
 *  - "live"           — a real provider/key is active.
 *  - "mock"           — running on the deterministic mock seam (no live adapter).
 *  - "not_configured" — nothing connected and no key/env present.
 */
export type IntegrationStatus =
  | "live"
  | "mock"
  | "connected"
  | "not_configured";

/** One row on the Integrations page. Contains NO secrets. */
export interface IntegrationStatusItem {
  readonly key: string;
  readonly label: string;
  readonly category: IntegrationCategory;
  readonly status: IntegrationStatus;
  /** Short, non-secret human explanation of the current state. */
  readonly detail: string;
  /** Whether a management flow exists (gated separately on the client). */
  readonly configurable: boolean;
  /** Where to manage this integration, when a flow exists. */
  readonly manageHref?: string;
}

/** True when an env var holds a non-empty value. Never returns the VALUE. */
function envPresent(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

/** Read the org's selected AI model id (null when none persisted). */
async function getOrgAiModelId(organizationId: string): Promise<string | null> {
  const [row] = await db
    .select({ aiModelId: organizationSettings.aiModelId })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  return row?.aiModelId ?? null;
}

const SETTINGS_INTEGRATIONS_HREF = "/admin/settings?tab=integrations";

/**
 * Compose the full set of integration statuses for an org. Every status is
 * derived; nothing is read from a status table (there is none). Safe for the
 * client — see the secrecy contract at the top of this file.
 */
export async function getIntegrationsStatus(
  organizationId: string,
): Promise<IntegrationStatusItem[]> {
  const [fieldpulse, housecall, google, aiModelId] = await Promise.all([
    getFieldpulseConnectionStatus(organizationId),
    getHousecallConnectionStatus(organizationId),
    getGoogleConnectionStatus(organizationId),
    getOrgAiModelId(organizationId),
  ]);

  // FSM — Fieldpulse. Connected (per-org key) or env-fallback key present.
  const fieldpulseEnv = envPresent("FIELDPULSE_API_KEY");
  const fieldpulseItem: IntegrationStatusItem = {
    key: "fieldpulse",
    label: "FieldPulse",
    category: "FSM",
    status: fieldpulse.connected
      ? "connected"
      : fieldpulseEnv
        ? "live"
        : "not_configured",
    detail: fieldpulse.connected
      ? fieldpulse.accountInfo?.companyName
        ? `Connected — ${fieldpulse.accountInfo.companyName}`
        : "Connected"
      : fieldpulseEnv
        ? "Environment key present"
        : "Not connected",
    configurable: true,
    manageHref: SETTINGS_INTEGRATIONS_HREF,
  };

  // FSM — Housecall Pro.
  const housecallEnv = envPresent("HOUSECALL_API_KEY");
  const housecallItem: IntegrationStatusItem = {
    key: "housecall_pro",
    label: "Housecall Pro",
    category: "FSM",
    status: housecall.connected
      ? "connected"
      : housecallEnv
        ? "live"
        : "not_configured",
    detail: housecall.connected
      ? housecall.accountInfo?.companyName
        ? `Connected — ${housecall.accountInfo.companyName}`
        : "Connected"
      : housecallEnv
        ? "Environment key present"
        : "Not connected",
    configurable: true,
    manageHref: SETTINGS_INTEGRATIONS_HREF,
  };

  // Calendar — Google Calendar (OAuth).
  const googleItem: IntegrationStatusItem = {
    key: "google_calendar",
    label: "Google Calendar",
    category: "FSM",
    status: google.connected ? "connected" : "not_configured",
    detail: google.connected
      ? google.calendarId
        ? `Connected — calendar "${google.calendarId}"`
        : "Connected"
      : "Not connected",
    configurable: true,
    manageHref: SETTINGS_INTEGRATIONS_HREF,
  };

  // Payments — Stripe seam. A live key present but adapter still mock is the
  // nuance the operator must see (no real charges yet).
  const paymentName = getPaymentProvider().name;
  const stripeKeyPresent = envPresent("STRIPE_SECRET_KEY");
  const paymentsItem: IntegrationStatusItem = {
    key: "payments",
    label: "Payments (Stripe)",
    category: "payments",
    status: paymentName === "mock" ? "mock" : "live",
    detail:
      paymentName === "mock"
        ? stripeKeyPresent
          ? "Live key present, but adapter is mock — no real charges"
          : "Mock provider — no real charges"
        : "Live provider active",
    configurable: false,
  };

  // Financing — Wisetack seam (same live-key-but-mock nuance).
  const financingName = getFinancingProvider().name;
  const wisetackKeyPresent = envPresent("WISETACK_API_KEY");
  const financingItem: IntegrationStatusItem = {
    key: "financing",
    label: "Financing (Wisetack)",
    category: "financing",
    status: financingName === "mock" ? "mock" : "live",
    detail:
      financingName === "mock"
        ? wisetackKeyPresent
          ? "Live key present, but adapter is mock — no real applications"
          : "Mock provider — no real applications"
        : "Live provider active",
    configurable: false,
  };

  // Comms — Resend (email) and Twilio (SMS/voice), env-presence only.
  const emailItem: IntegrationStatusItem = {
    key: "email",
    label: "Email (Resend)",
    category: "comms",
    status: envPresent("RESEND_API_KEY") ? "live" : "not_configured",
    detail: envPresent("RESEND_API_KEY")
      ? "API key configured"
      : "No API key configured",
    configurable: false,
  };

  // Twilio needs both the account SID and auth token to be usable.
  const twilioConfigured =
    envPresent("TWILIO_ACCOUNT_SID") && envPresent("TWILIO_AUTH_TOKEN");
  const twilioItem: IntegrationStatusItem = {
    key: "twilio",
    label: "Phone & SMS (Twilio)",
    category: "comms",
    status: twilioConfigured ? "live" : "not_configured",
    detail: twilioConfigured
      ? "Credentials configured"
      : "Credentials not configured",
    configurable: false,
  };

  // AI — the selected LLM model. Report the registry LABEL only (never baseUrl,
  // apiKeyEnv, modelId, or key). No selection => env default in effect.
  const aiEntry = aiModelId ? getRegistryEntry(aiModelId) : undefined;
  const aiItem: IntegrationStatusItem = {
    key: "ai_model",
    label: "AI Model",
    category: "ai",
    status: "live",
    detail: aiEntry
      ? `Configured — ${aiEntry.label}`
      : "Using default model",
    configurable: true,
    manageHref: SETTINGS_INTEGRATIONS_HREF,
  };

  return [
    fieldpulseItem,
    housecallItem,
    googleItem,
    paymentsItem,
    financingItem,
    emailItem,
    twilioItem,
    aiItem,
  ];
}
