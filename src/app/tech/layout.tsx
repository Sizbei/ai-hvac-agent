import { redirect } from 'next/navigation';
import { getTechSession } from '@/lib/auth/tech-session';
import { TechLocationTracker } from '@/components/tech/tech-location-tracker';

/**
 * Technician field view shell. Gated on the dedicated technician session (NOT the
 * admin session) — see tech-session.ts. The login page lives at the ungated
 * top-level /tech-login (outside this layout) to avoid a redirect loop. Minimal,
 * mobile-first chrome: a tech works one-handed on a phone on-site.
 */
export default async function TechLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getTechSession();
  if (!session) {
    redirect('/tech-login');
  }

  return (
    <div className="mx-auto min-h-dvh max-w-md bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <h1 className="text-base font-semibold tracking-tight">Field</h1>
        <p className="text-xs text-muted-foreground">{session.name}</p>
      </header>
      <main className="space-y-4 px-4 py-4">
        <TechLocationTracker />
        {children}
      </main>
    </div>
  );
}
