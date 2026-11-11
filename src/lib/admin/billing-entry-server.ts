import "server-only";

import type { ViewerContext } from "@/lib/auth/viewer";
import { isPlatformManagedOrg } from "@/lib/auth/authz";
import { historyContactOrFallback } from "@/lib/admin/admin-guide-queries";
import { billingPageView, seesPlatformUi } from "@/lib/admin/preview-view";
import type { BillingEntry } from "@/lib/admin/billing-entry";

/** The viewer's billing entry: `billingPageView`, plus who handles billing when the platform does. */
export async function resolveBillingEntry(
  viewer: Pick<ViewerContext, "session" | "uiRole" | "isPlatformAdmin" | "preview">,
): Promise<BillingEntry> {
  const { organizationId } = viewer.session;
  const view = billingPageView({
    uiRole: viewer.uiRole,
    platformUi: seesPlatformUi(viewer),
    platformManagedOrg: isPlatformManagedOrg(organizationId),
  });
  return { view, contact: view === "handled" ? await historyContactOrFallback(organizationId) : null };
}
