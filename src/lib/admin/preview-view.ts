/**
 * What a page shows for the viewer while "View as" may be on (spec P7: the
 * preview applies the target's role and P3 gates; the real session stays
 * authoritative for the APIs). Pure, type-only imports: client-safe.
 */
import type { PreviewState } from "@/lib/auth/viewer";
import type { AdminRole } from "@/lib/auth/types";

type UiRole = AdminRole | "technician";

/** Tooltip on a write control disabled by a "View as" preview. */
export const READ_ONLY_PREVIEW = "Read-only preview";

/** Platform-only UI (console, import run history, unmanaged billing): the platform owner, not previewing. */
export function seesPlatformUi(v: { isPlatformAdmin: boolean; preview: PreviewState | null }): boolean {
  return v.isPlatformAdmin && v.preview === null;
}

/** The sidebar account chip: the active target's name and email while previewing. */
export function chipIdentity(
  session: { name: string; email: string },
  preview: PreviewState | null,
): { name: string; email: string } {
  if (preview?.status === "active") return { name: preview.targetName, email: preview.targetEmail };
  return { name: session.name, email: session.email };
}

/** The staff row marked "(you)": the active target while previewing. */
export function selfUserId(session: { userId: string }, preview: PreviewState | null): string {
  return preview?.status === "active" ? preview.targetUserId : session.userId;
}

/** The accounting export is super_admin-only (same rule as its API). */
export function canExportAccounting(uiRole: UiRole): boolean {
  return uiRole === "super_admin";
}

export type BillingPageView = "panel" | "handled" | "redirect";

/**
 * /admin/settings/billing: the platform owner (not previewing) always gets the
 * panel; an org super_admin gets it unless the platform handles the org's
 * billing (then a one-line "handled by"); anyone else is sent back.
 */
export function billingPageView(p: {
  uiRole: UiRole;
  platformUi: boolean;
  platformManagedOrg: boolean;
}): BillingPageView {
  if (p.platformUi) return "panel";
  if (p.uiRole !== "super_admin") return "redirect";
  return p.platformManagedOrg ? "handled" : "panel";
}
