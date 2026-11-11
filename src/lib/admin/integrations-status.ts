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
import { envKeyFallbackAllowed } from "@/lib/integrations/env-fallback";
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
 *  - "sync_failed"     — connected, but the most recent background sync failed
 *                        (FieldPulse availability sync only; Rintegrations-1).
 *  - "not_configured" — nothing connected and no key/env present.
 */
export type IntegrationStatus =
  | "live"
  | "mock"
  | "connected"
  | "sync_failed"
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

/** Read the org's AI model id (null when none persisted) and scheduling source. */
async function getOrgSettingsBits(organizationId: string): Promise<{
  readonly aiModelId: string | null;
  readonly schedulingSource: "native" | "external" | null;
}> {
  const [row] = await db
    .select({
      aiModelId: organizationSettings.aiModelId,
      schedulingSource: organizationSettings.schedulingSource,
    })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  return { aiModelId: row?.aiModelId ?? null, schedulingSource: row?.schedulingSource ?? null };
}

const SETTINGS_INTEGRATIONS_HREF = "/admin/settings?tab=integrations";

/** Same wording as the Settings › Integrations panels for an env-key org. */
const SERVER_KEY_DETAIL = "Connected with the account key set up on the server";

/**
 * Compose the full set of integration statuses for an org. Every status is
 * derived; nothing is read from a status table (there is none). Safe for the
 * client — see the secrecy contract at the top of this file.
 */
export async function getIntegrationsStatus(
  organizationId: string,
): Promise<IntegrationStatusItem[]> {
  const [fieldpulse, housecall, google, { aiModelId, schedulingSource }] = await Promise.all([
    getFieldpulseConnectionStatus(organizationId),
    getHousecallConnectionStatus(organizationId),
    getGoogleConnectionStatus(organizationId),
    getOrgSettingsBits(organizationId),
  ]);

  // FSM — Fieldpulse. Connected (per-org key) or env-fallback key present.
  // A "Connected" badge must not stay green when the daily availability-sync
  // cron is failing — that's Rintegrations-1, fed by Rintegrations-2's data.
  const fieldpulseEnv = envPresent("FIELDPULSE_API_KEY") && envKeyFallbackAllowed(organizationId);
  // Only an org that takes its availability FROM FieldPulse depends on that
  // sync; for a natively scheduled org a failed availability sync affects
  // nothing the office sees, so it must not paint the connection red.
  const fieldpulseSyncFailed =
    fieldpulse.connected &&
    fieldpulse.availabilitySyncStatus === "failed" &&
    schedulingSource === "external";
  const fieldpulseItem: IntegrationStatusItem = {
    key: "fieldpulse",
    label: "FieldPulse",
    category: "FSM",
    status: fieldpulseSyncFailed
      ? "sync_failed"
      : fieldpulse.connected
        ? "connected"
        : fieldpulseEnv
          ? "live"
          : "not_configured",
    detail: fieldpulseSyncFailed
      ? "Connected, but the last availability sync failed. Check the API key in Settings."
      : fieldpulse.connected
        ? fieldpulse.accountInfo?.companyName
          ? `Connected — ${fieldpulse.accountInfo.companyName}`
          : "Connected"
        : fieldpulseEnv
          ? SERVER_KEY_DETAIL
          : "Not connected",
    configurable: true,
    manageHref: SETTINGS_INTEGRATIONS_HREF,
  };

  // FSM — Housecall Pro.
  const housecallEnv = envPresent("HOUSECALL_API_KEY") && envKeyFallbackAllowed(organizationId);
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
        ? SERVER_KEY_DETAIL
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
          ? "A Stripe key is set up, but payments still run in test mode — no real charges yet"
          : "Test mode — no real charges are made"
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
          ? "A Wisetack key is set up, but financing still runs in test mode — no real applications yet"
          : "Test mode — no real applications are sent"
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
      ? "Set up — sends email to customers and staff"
      : "Not set up",
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
      ? "Set up — sends texts and handles calls"
      : "Not set up",
    configurable: false,
  };

  // AI — the selected LLM model. Report the registry LABEL only (never baseUrl,
  // apiKeyEnv, modelId, or key). No selection => env default in effect.
  const aiEntry = aiModelId ? getRegistryEntry(aiModelId) : undefined;
  const aiItem: IntegrationStatusItem = {
    key: "ai_model",
    label: "AI model",
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
