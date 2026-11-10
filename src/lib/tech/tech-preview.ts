/**
 * "View as" a technician (spec P7 stretch): pure helpers over a tech session.
 * Type-only imports, so client and server code can both use them.
 */
import type { TechSession } from "@/lib/auth/tech-session";
import { previewBannerLine } from "@/lib/admin/preview-banner-copy";

/** The id a tech route's rate limit keys on: the real admin's while previewing (spec P7). */
export function rateKeyFor(session: TechSession): string {
  return session.preview?.adminUserId ?? session.userId;
}

export interface TechPreviewBanner {
  readonly line: string;
  readonly targetUserId: string;
  /** The preview cookie's expiry, unix seconds. */
  readonly exp: number;
}

/** The banner props while previewing; null for a real technician. */
export function techPreviewBanner(session: TechSession): TechPreviewBanner | null {
  if (!session.preview) return null;
  return {
    line: previewBannerLine({
      status: "active",
      targetUserId: session.userId,
      targetName: session.name,
      targetRole: "technician",
      exp: session.preview.exp,
    }),
    targetUserId: session.userId,
    exp: session.preview.exp,
  };
}
