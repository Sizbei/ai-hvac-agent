import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { organizations, organizationSettings } from '@/lib/db/schema';
import { parseOnboardingState } from '@/lib/admin/onboarding-state';
import type { SetupPlacement } from '@/components/admin/nav-items';
import { isOrgActive } from '@/lib/billing/entitlements';
import { DashboardShell } from '@/components/admin/dashboard-shell';

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
async function loadBillingState(
  organizationId: string,
): Promise<{ billingAttention: boolean; orgName: string | undefined }> {
  try {
    const [org] = await db
      .select({ status: organizations.status, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return {
      billingAttention: org ? !isOrgActive(org) : false,
      orgName: org?.name ?? undefined,
    };
  } catch {
    return { billingAttention: false, orgName: undefined };
  }
}

/**
 * Setup nav placement (spec §2): second in Operations while the guide is
 * neither dismissed nor finished-and-seen, else last in Integrations. Degrades
 * to the quieter Integrations slot on error.
 */
async function loadSetupPlacement(organizationId: string): Promise<SetupPlacement> {
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
    const state = parseOnboardingState(row.onboardingState);
    return state.dismissedAt || state.completedSeenAt ? 'integrations' : 'operations';
  } catch {
    return 'integrations';
  }
}
