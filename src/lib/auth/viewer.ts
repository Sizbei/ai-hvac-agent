import "server-only";

import * as React from "react";
import { getAdminSession } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/authz";
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
  /** Platform-admin "view as" state; null until the preview cookie lands (Task 15). */
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

/** One viewer per request (React cache). Null without an admin session. */
export const getViewerContext = cache(async function getViewerContext(): Promise<ViewerContext | null> {
  const session = await getAdminSession();
  if (!session) return null;
  const platform = safeIsPlatformAdmin(session);
  const features = await safeFeatures(session.organizationId);
  const preview: PreviewState | null = null;
  return {
    session,
    isPlatformAdmin: platform,
    features,
    preview,
    uiRole: session.role,
    showHidden: computeShowHidden({
      isPlatformAdmin: platform,
      previewing: preview !== null,
      showHistory: features.showHistory,
    }),
  };
});
