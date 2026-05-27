import { redirect } from 'next/navigation';
import { getAdminSession } from '@/lib/auth/session';
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

  return (
    <DashboardShell adminName={session.name} adminEmail={session.email}>
      {children}
    </DashboardShell>
  );
}
