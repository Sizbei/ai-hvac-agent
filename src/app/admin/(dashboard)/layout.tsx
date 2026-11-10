import { cache } from 'react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { organizations, organizationSettings } from '@/lib/db/schema';
import { parseOnboardingState, placementFor } from '@/lib/admin/onboarding-state';
import { isDemoOrg } from '@/lib/tenancy/demo-mode';
import { loadOrgRow } from '@/lib/tenancy/org-row';
import type { SetupPlacement } from '@/components/admin/nav-items';
import { isOrgActive } from '@/lib/billing/entitlements';
import { DashboardShell } from '@/components/admin/dashboard-shell';
import { adminPageTitle } from '@/lib/admin/admin-title';

/** Tab titles read "<page> · <org name>" for server pages that set a title. */
export async function generateMetadata(): Promise<Metadata> {
  const session = await getAdminSession();
  const orgName = session ? (await loadBillingState(session.organizationId)).orgName : undefined;
  const brand = adminPageTitle('', orgName);
  return { title: { template: `%s · ${brand}`, default: brand } };
}

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getAdminSession();

  if (!session) {
    redirect('/admin/login');
  }

  // The two lookups run concurrently and fail independently: a miss on one
  // never changes what the other decides.
  const [{ billingAttention, orgName }, setupPlacement] = await Promise.all([
    loadBillingState(session.organizationId),
    loadSetupPlacement(session.organizationId),
  ]);

  return (
    <DashboardShell
      orgName={orgName}
      adminName={session.name}
      adminEmail={session.email}
      role={session.role}
      billingAttention={billingAttention}
      setupPlacement={setupPlacement}
    >
      {children}
    </DashboardShell>
  );
}

/**
 * Stage 10: surface a non-dismissable billing banner when the org's
 * subscription is past_due/suspended. Degrade-safe — a query miss leaves the
 * org treated as active (no banner) rather than blocking the dashboard.
 */
// cache(): generateMetadata and the layout share one lookup per request.
const loadBillingState = cache(async function loadBillingState(
  organizationId: string,
): Promise<{ billingAttention: boolean; orgName: string | undefined }> {
  try {
    const org = await loadOrgRow(organizationId);
    return {
      billingAttention: org ? !isOrgActive(org) : false,
      orgName: org?.name ?? undefined,
    };
  } catch {
    return { billingAttention: false, orgName: undefined };
  }
});

/**
 * Setup nav placement (spec §2, `placementFor`): second in Operations while
 * the guide is neither dismissed nor finished-and-seen, else last in
 * Integrations; a demo-mode org is always Operations. Degrades to the quieter
 * Integrations slot on error.
 */
async function loadSetupPlacement(organizationId: string): Promise<SetupPlacement> {
  if (isDemoOrg(organizationId)) return 'operations';
  try {
    const [row] = await db
      .select({ onboardingState: organizationSettings.onboardingState })
      .from(organizations)
      .leftJoin(
        organizationSettings,
        eq(organizationSettings.organizationId, organizations.id),
      )
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!row) return 'integrations';
    // parseOnboardingState folds legacy `dismissed: true` into dismissedAt.
    return placementFor(parseOnboardingState(row.onboardingState), false);
  } catch {
    return 'integrations';
  }
}
