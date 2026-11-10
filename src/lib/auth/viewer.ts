import "server-only";

import * as React from "react";
import { cookies } from "next/headers";
import { getAdminSession } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/authz";
import { PREVIEW_COOKIE, verifyPreviewCookie } from "@/lib/auth/preview-cookie";
import { findPreviewTarget } from "@/lib/admin/preview-targets";
import type { AdminRole, AdminSessionPayload } from "@/lib/auth/types";
import { computeShowHidden, type Visibility } from "@/lib/admin/visibility";
import { getFeatures } from "@/lib/tenancy/features";
import { DEFAULT_FEATURES, type Features } from "@/lib/tenancy/feature-flags";
import { errorCode, logger } from "@/lib/logger";

export type PreviewState =
  | {
      readonly status: "active";
      readonly targetUserId: string;
      readonly targetName: string;
      readonly targetRole: AdminRole | "technician";
    }
  | { readonly status: "stale" };

/** Who is looking, and whether they see hidden (imported) history. */
export interface ViewerContext extends Visibility {
  readonly session: AdminSessionPayload;
  readonly isPlatformAdmin: boolean;
  readonly features: Features;
  /** Platform-admin "view as" state (spec P7); null when not previewing. */
  readonly preview: PreviewState | null;
  readonly uiRole: AdminRole | "technician";
}

// React.cache only exists under the react-server condition; plain Node (vitest,
// scripts) gets an uncached passthrough.
const cache: <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A) => R =
  (React as { cache?: <F>(fn: F) => F }).cache ?? ((fn) => fn);

/** Fail safe: an env/config error means "not the platform admin". */
function safeIsPlatformAdmin(session: AdminSessionPayload): boolean {
  try {
    return isPlatformAdmin(session);
  } catch (error) {
    logger.error(
      { code: errorCode(error), organizationId: session.organizationId },
      "Platform admin check failed; treating viewer as an org user",
    );
    return false;
  }
}

/** Fail safe: a lookup error means DEFAULT_FEATURES (`showHistory: false`). */
async function safeFeatures(organizationId: string): Promise<Features> {
  try {
    return await getFeatures(organizationId);
  } catch (error) {
    logger.error(
      { code: errorCode(error), organizationId },
      "Feature lookup failed; hiding imported history",
    );
    return DEFAULT_FEATURES;
  }
}

/**
 * "View as" (spec P7). Only a platform admin's request is looked at. A cookie
 * with a valid signature, bound to THIS session, resolves to the target when
 * it is still an active user of the session org, else `stale` (plan ruling 9:
 * the proxy keeps refusing writes, so the banner must still show). Anything
 * else — no cookie, bad signature, another admin's cookie, any error — is
 * "not previewing" (the proxy clears a cookie it would ignore).
 */
async function resolvePreview(
  session: AdminSessionPayload,
  platform: boolean,
): Promise<PreviewState | null> {
  if (!platform) return null;
  try {
    const value = (await cookies()).get(PREVIEW_COOKIE)?.value;
    if (!value) return null;
    const claims = await verifyPreviewCookie(value, process.env.AUTH_SECRET ?? "");
    if (!claims || claims.adminUserId !== session.userId) return null;
    const target = await findPreviewTarget(session.organizationId, claims.targetUserId);
    if (!target) return { status: "stale" };
    return {
      status: "active",
      targetUserId: target.userId,
      targetName: target.name,
      targetRole: target.role,
    };
  } catch (error) {
    logger.error(
      { code: errorCode(error), organizationId: session.organizationId },
      "Preview resolution failed; rendering as the signed-in admin",
    );
    return null;
  }
}

/** One viewer per request (React cache). Null without an admin session. */
export const getViewerContext = cache(async function getViewerContext(): Promise<ViewerContext | null> {
  const session = await getAdminSession();
  if (!session) return null;
  const platform = safeIsPlatformAdmin(session);
  const [features, preview] = await Promise.all([
    safeFeatures(session.organizationId),
    resolvePreview(session, platform),
  ]);
  return {
    session,
    isPlatformAdmin: platform,
    features,
    preview,
    uiRole: preview?.status === "active" ? preview.targetRole : session.role,
    showHidden: computeShowHidden({
      isPlatformAdmin: platform,
      previewing: preview !== null,
      showHistory: features.showHistory,
    }),
  };
});
