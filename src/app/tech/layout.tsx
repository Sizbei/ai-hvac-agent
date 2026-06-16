import { redirect } from 'next/navigation';
import { getAdminSession } from '@/lib/auth/session';

/**
 * Technician field view shell. Session-gated like the admin dashboard (the tech
 * holds the same JWT admin session — see the tech API routes). Minimal,
 * mobile-first chrome: a tech works one-handed on a phone on-site.
 */
export default async function TechLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getAdminSession();
  if (!session) {
    redirect('/admin/login');
  }

  return (
    <div className="mx-auto min-h-dvh max-w-md bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <h1 className="text-base font-semibold tracking-tight">Field</h1>
        <p className="text-xs text-muted-foreground">{session.name}</p>
      </header>
      <main className="px-4 py-4">{children}</main>
    </div>
  );
}
