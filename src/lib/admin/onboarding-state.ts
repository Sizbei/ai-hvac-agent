import { z } from "zod";

/**
 * Setup-guide state types + parser. Imports only zod: safe for client code
 * (never import @/lib/db or server-only here).
 */

export const STEP_IDS = [
  "phone_hours",
  "brand",
  "add_technician",
  "pricebook",
  "book_first_request",
  "tech_sign_in",
  "chat_widget",
  "integrations",
] as const;

export type StepId = (typeof STEP_IDS)[number];

export interface OnboardingState {
  dismissedAt?: string;
  completedSeenAt?: string;
  firstCompleted: Partial<Record<StepId, string>>;
  flags: { embedCopied?: boolean; techSignedInAt?: string };
}

export interface Signals {
  companyName: string | null;
  phone: boolean;
  businessHours: boolean;
  logoUrl: boolean;
  technicianReady: boolean;
  fpPasswordless: number;
  pendingInvite: boolean;
  pricebook: boolean;
  anyRequest: boolean;
  bookedAssigned: boolean;
  techSignedIn: boolean;
  widgetKey: boolean;
  allowedOrigins: boolean;
  integrationConnected: boolean;
  completedRequest: boolean;
  orgCreatedAt: string | null;
  state: OnboardingState;
}

/** Stamp used when a legacy `dismissed: true` has no real timestamp. */
export const LEGACY_ISO = "1970-01-01T00:00:00.000Z";

const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)))
  .optional()
  .catch(undefined);

const firstCompletedSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .catch(undefined);

const flagsSchema = z
  .object({
    embedCopied: z.boolean().optional().catch(undefined),
    techSignedInAt: isoDate,
  })
  .optional()
  .catch(undefined);

const stateSchema = z.object({
  dismissedAt: isoDate,
  completedSeenAt: isoDate,
  firstCompleted: firstCompletedSchema,
  flags: flagsSchema,
  dismissed: z.boolean().optional().catch(undefined),
  embedViewed: z.boolean().optional().catch(undefined),
});

/** Tolerant parse of the stored jsonb. Never throws. */
export function parseOnboardingState(raw: unknown): OnboardingState {
  const parsed = stateSchema.safeParse(raw);
  const s = parsed.success ? parsed.data : {};

  const firstCompleted: Partial<Record<StepId, string>> = {};
  for (const id of STEP_IDS) {
    const v = s.firstCompleted?.[id];
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) {
      firstCompleted[id] = v;
    }
  }

  const flags: OnboardingState["flags"] = {};
  if (s.flags?.embedCopied !== undefined) flags.embedCopied = s.flags.embedCopied;
  if (s.flags?.techSignedInAt) flags.techSignedInAt = s.flags.techSignedInAt;
  // Legacy fold: embedViewed was the never-written predecessor of embedCopied.
  if (s.embedViewed === true && flags.embedCopied === undefined) {
    flags.embedCopied = true;
  }

  const state: OnboardingState = { firstCompleted, flags };
  const dismissedAt =
    s.dismissedAt ?? (s.dismissed === true ? LEGACY_ISO : undefined);
  if (dismissedAt) state.dismissedAt = dismissedAt;
  if (s.completedSeenAt) state.completedSeenAt = s.completedSeenAt;
  return state;
}
