import "server-only";

import { and, eq, count, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  organizationSettings,
  pricebookItems,
  staffInvites,
  users,
} from "@/lib/db/schema";
import {
  parseOnboardingState,
  type OnboardingState as StateV2,
  type Signals,
} from "./onboarding-state";
import {
  flagsStatementSql,
  onboardingSelectSql,
  stampStatementSql,
} from "./onboarding-sql";
import {
  deriveSteps,
  grandfatherDecision,
  type OnboardingPayload,
} from "./onboarding-steps";

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

// ---------------------------------------------------------------------------
// Setup guide (v2). The block above is the old checklist, removed in Task 3.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** Map the onboardingSelectSql row (neon-http types) to Signals. */
function signalsFromRow(row: Row): Signals {
  const b = (k: string) => row[k] === true;
  return {
    companyName: typeof row.company_name === "string" ? row.company_name : null,
    phone: b("phone"),
    businessHours: b("business_hours"),
    logoUrl: b("logo_url"),
    technicianReady: b("technician_ready"),
    fpPasswordless: Number(row.fp_passwordless ?? 0) || 0,
    pendingInvite: b("pending_invite"),
    pricebook: b("pricebook"),
    anyRequest: b("any_request"),
    bookedAssigned: b("booked_assigned"),
    techSignedIn: b("tech_signed_in_evidence"),
    widgetKey: b("widget_key"),
    allowedOrigins: b("allowed_origins"),
    integrationConnected: b("integration_connected"),
    completedRequest: b("completed_request"),
    orgCreatedAt: typeof row.org_created_at === "string" ? row.org_created_at : null,
    state: parseOnboardingState(row.onboarding_state),
  };
}

/**
 * GET: one SELECT, then the stamp statement iff there are new stamps or
 * grandfathering keys (never for the demo org). The payload is built from the
 * SELECT copy merged in memory, never from RETURNING.
 */
export async function getOnboarding(
  organizationId: string,
  opts: { demo: boolean; googleEnabled: boolean; appUrl: string; now?: Date },
): Promise<OnboardingPayload> {
  const now = opts.now ?? new Date();
  const res = await db.execute(onboardingSelectSql(organizationId));
  const signals = signalsFromRow((res.rows[0] ?? {}) as Row);
  const derived = deriveSteps(signals, {
    now,
    demo: opts.demo,
    googleEnabled: opts.googleEnabled,
    appUrl: opts.appUrl,
  });
  const top = grandfatherDecision(signals, derived, now, { demo: opts.demo });
  const needsWrite =
    Object.keys(derived.newStamps).length > 0 || Object.keys(top).length > 0;

  if (!opts.demo && needsWrite) {
    try {
      await db.execute(
        stampStatementSql({ organizationId, newStamps: derived.newStamps, top }),
      );
    } catch (error) {
      logger.warn(
        {
          organizationId,
          error: error instanceof Error ? error.message : "unknown",
        },
        "Setup guide stamp write failed; returning the derived payload",
      );
    }
  }

  const { state } = signals;
  return {
    steps: derived.steps,
    progress: derived.progress,
    upNext: derived.upNext,
    dismissedAt: state.dismissedAt ?? top.dismissedAt ?? null,
    completedSeenAt: state.completedSeenAt ?? top.completedSeenAt ?? null,
    demo: opts.demo,
  };
}

export interface OnboardingPatchBody {
  dismissed?: true;
  completedSeen?: true;
  flags?: { embedCopied?: true };
}

function topFor(body: OnboardingPatchBody, nowIso: string) {
  return {
    ...(body.dismissed ? { dismissedAt: nowIso } : {}),
    ...(body.completedSeen ? { completedSeenAt: nowIso } : {}),
  };
}

/** Old values win, as in the SQL statements. */
function applyPatch(state: StateV2, body: OnboardingPatchBody, nowIso: string): StateV2 {
  return {
    ...topFor(body, nowIso),
    ...state,
    firstCompleted: state.firstCompleted,
    flags: { ...(body.flags ?? {}), ...state.flags },
  };
}

/**
 * PATCH: the demo org gets the body applied in memory (one SELECT, no write);
 * every other org runs the flags upsert and gets RETURNING parsed.
 */
export async function patchOnboarding(
  organizationId: string,
  body: OnboardingPatchBody,
  opts: { demo: boolean; now?: Date },
): Promise<StateV2> {
  const nowIso = (opts.now ?? new Date()).toISOString();
  if (opts.demo) {
    const res = await db.execute(
      sql`SELECT onboarding_state FROM organization_settings WHERE organization_id = ${organizationId}`,
    );
    const current = parseOnboardingState((res.rows[0] as Row | undefined)?.onboarding_state);
    return applyPatch(current, body, nowIso);
  }
  const res = await db.execute(
    flagsStatementSql({
      organizationId,
      flags: body.flags ?? {},
      top: topFor(body, nowIso),
    }),
  );
  return parseOnboardingState((res.rows[0] as Row | undefined)?.onboarding_state);
}
