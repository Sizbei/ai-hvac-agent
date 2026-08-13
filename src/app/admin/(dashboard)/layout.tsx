import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { organizations } from '@/lib/db/schema';
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

  // Stage 10: surface a non-dismissable billing banner when the org's
  // subscription is past_due/suspended. Degrade-safe — a query miss leaves the
  // org treated as active (no banner) rather than blocking the dashboard.
  let billingAttention = false;
  let orgName: string | undefined;
  try {
    const [org] = await db
      .select({ status: organizations.status, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, session.organizationId))
      .limit(1);
    billingAttention = org ? !isOrgActive(org) : false;
    orgName = org?.name ?? undefined;
  } catch {
    billingAttention = false;
  }

  return (
    <DashboardShell
      orgName={orgName}
      adminName={session.name}
      adminEmail={session.email}
      role={session.role}
      billingAttention={billingAttention}
    >
      {children}
    </DashboardShell>
  );
}
