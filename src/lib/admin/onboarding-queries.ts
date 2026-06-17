import "server-only";

import { and, eq, count } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  organizationSettings,
  pricebookItems,
  staffInvites,
  users,
} from "@/lib/db/schema";

/**
 * Onboarding checklist state (self-serve signup).
 *
 * Six steps, each `done` derived from LIVE data where possible; only the two
 * non-derivable flags (`dismissed`, `embedViewed`) live in
 * organizationSettings.onboardingState. The dashboard card reads this and hides
 * itself when `dismissed` or every step is complete.
 */

export type OnboardingStepId =
  | "account_created"
  | "business_details"
  | "pricebook"
  | "service_hours"
  | "embed_widget"
  | "invite_team";

export interface OnboardingStep {
  readonly id: OnboardingStepId;
  readonly label: string;
  readonly done: boolean;
}

export interface OnboardingState {
  readonly steps: readonly OnboardingStep[];
  readonly completedCount: number;
  readonly totalCount: number;
  readonly allComplete: boolean;
  readonly dismissed: boolean;
}

/** Non-empty string predicate (trims; tolerates non-string jsonb values). */
function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Derive the onboarding checklist state for an org from live data + the stored
 * flags. Degrade-safe: a missing settings row is treated as "nothing set yet".
 */
export async function getOnboardingState(
  orgId: string,
): Promise<OnboardingState> {
  // Settings row: companyName, the businessInfo bag (phone/businessHours), and
  // the stored onboarding flags.
  const [settings] = await db
    .select({
      companyName: organizationSettings.companyName,
      businessInfo: organizationSettings.businessInfo,
      onboardingState: organizationSettings.onboardingState,
    })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, orgId))
    .limit(1);

  const businessInfo =
    (settings?.businessInfo as Record<string, unknown> | undefined) ?? {};
  const flags = settings?.onboardingState ?? {};

  // Step 2 — business details: a concrete non-auto field is set (businessInfo
  // phone OR companyName non-empty). Org name is always set at create, so it is
  // deliberately NOT the predicate.
  const businessDetailsDone =
    nonEmptyString(businessInfo.phone) || nonEmptyString(settings?.companyName);

  // Step 4 — service hours: the businessHours key in the businessInfo bag is
  // present + non-empty (free-form jsonb, so an explicit predicate).
  const serviceHoursDone = nonEmptyString(businessInfo.businessHours);

  // Step 3 — pricebook: ≥1 ACTIVE pricebook item for the org.
  const [pricebookRow] = await db
    .select({ value: count() })
    .from(pricebookItems)
    .where(
      and(
        eq(pricebookItems.organizationId, orgId),
        eq(pricebookItems.active, true),
      ),
    );
  // neon-http returns count() as a string.
  const pricebookDone = Number(pricebookRow?.value ?? 0) >= 1;

  // Step 6 — invite your team: ≥1 staff invite (any state) OR ≥2 active users.
  const [inviteRow] = await db
    .select({ value: count() })
    .from(staffInvites)
    .where(eq(staffInvites.organizationId, orgId));
  const inviteCount = Number(inviteRow?.value ?? 0);

  const [activeUserRow] = await db
    .select({ value: count() })
    .from(users)
    .where(and(eq(users.organizationId, orgId), eq(users.isActive, true)));
  const activeUserCount = Number(activeUserRow?.value ?? 0);

  const inviteTeamDone = inviteCount >= 1 || activeUserCount >= 2;

  const steps: OnboardingStep[] = [
    // Step 1 — account created: always done (the org exists).
    { id: "account_created", label: "Create your account", done: true },
    {
      id: "business_details",
      label: "Add your business details",
      done: businessDetailsDone,
    },
    { id: "pricebook", label: "Set up your pricebook", done: pricebookDone },
    {
      id: "service_hours",
      label: "Set your service hours",
      done: serviceHoursDone,
    },
    // Step 5 — embed the widget: the only purely flag-driven step.
    {
      id: "embed_widget",
      label: "Embed the chat widget",
      done: flags.embedViewed === true,
    },
    { id: "invite_team", label: "Invite your team", done: inviteTeamDone },
  ];

  const completedCount = steps.filter((s) => s.done).length;
  const totalCount = steps.length;

  return {
    steps,
    completedCount,
    totalCount,
    allComplete: completedCount === totalCount,
    dismissed: flags.dismissed === true,
  };
}

export type OnboardingFlagUpdate = {
  readonly dismissed?: boolean;
  readonly embedViewed?: boolean;
};

/**
 * Persist a partial update to the non-derivable onboarding flags
 * (dismissed/embedViewed), merged onto whatever is already stored. Org-scoped.
 */
export async function updateOnboardingFlags(
  orgId: string,
  update: OnboardingFlagUpdate,
): Promise<void> {
  const [current] = await db
    .select({ onboardingState: organizationSettings.onboardingState })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, orgId))
    .limit(1);

  const merged = {
    ...(current?.onboardingState ?? {}),
    ...update,
  };

  await db
    .update(organizationSettings)
    .set({ onboardingState: merged, updatedAt: new Date() })
    .where(eq(organizationSettings.organizationId, orgId));
}
