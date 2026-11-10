import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  parseOnboardingState,
  type OnboardingState as StateV2,
  type Signals,
} from "./onboarding-state";
import {
  clearDismissalSql,
  flagsStatementSql,
  onboardingSelectSql,
  stampStatementSql,
} from "./onboarding-sql";
import {
  deriveSteps,
  grandfatherDecision,
  type OnboardingPayload,
} from "./onboarding-steps";

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
    passwordless: Number(row.tech_passwordless ?? 0) || 0,
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
 * Demo read-time rule (spec §2): stored acknowledgements never hide the demo
 * guide (its × lives in sessionStorage), even if a row carries them.
 */
function demoSafe(state: StateV2, demo: boolean): StateV2 {
  if (!demo) return state;
  const { dismissedAt: _d, completedSeenAt: _c, ...rest } = state;
  return rest;
}

/**
 * GET: one SELECT, then the stamp statement iff there are new stamps or `$top`
 * keys (the write-once `firstSeenAt` on the first GET, plus grandfathering);
 * never for the demo org, and never when `write` is false ("View as" preview:
 * the read must not stamp, grandfather or set `firstSeenAt`). The payload is
 * built from the SELECT copy merged in memory, never from RETURNING.
 */
export async function getOnboarding(
  organizationId: string,
  opts: { demo: boolean; write: boolean; googleEnabled: boolean; appUrl: string; now?: Date },
): Promise<OnboardingPayload> {
  const now = opts.now ?? new Date();
  const res = await db.execute(onboardingSelectSql(organizationId));
  const raw = signalsFromRow((res.rows[0] ?? {}) as Row);
  const signals: Signals = { ...raw, state: demoSafe(raw.state, opts.demo) };
  const derived = deriveSteps(signals, {
    now,
    demo: opts.demo,
    googleEnabled: opts.googleEnabled,
    appUrl: opts.appUrl,
  });
  const top = {
    ...(signals.state.firstSeenAt ? {} : { firstSeenAt: now.toISOString() }),
    ...grandfatherDecision(signals, derived, now, { demo: opts.demo }),
  };
  const needsWrite =
    Object.keys(derived.newStamps).length > 0 || Object.keys(top).length > 0;

  if (opts.write && !opts.demo && needsWrite) {
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
  /** Undo `dismissed`: never sent together with it (the route rejects that). */
  showOnHome?: true;
  completedSeen?: true;
  flags?: { embedCopied?: true };
}

function topFor(body: OnboardingPatchBody, nowIso: string) {
  return {
    ...(body.dismissed ? { dismissedAt: nowIso } : {}),
    ...(body.completedSeen ? { completedSeenAt: nowIso } : {}),
  };
}

/** Old values win, as in the SQL statements; `showOnHome` drops dismissedAt. */
function applyPatch(state: StateV2, body: OnboardingPatchBody, nowIso: string): StateV2 {
  if (body.showOnHome) {
    const { dismissedAt: _dismissed, ...rest } = state;
    return rest;
  }
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
  if (body.showOnHome && !opts.demo) {
    const res = await db.execute(clearDismissalSql(organizationId));
    return parseOnboardingState((res.rows[0] as Row | undefined)?.onboarding_state);
  }
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
