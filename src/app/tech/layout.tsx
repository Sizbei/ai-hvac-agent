import { redirect } from 'next/navigation';
import { getTechSession } from '@/lib/auth/tech-session';
import { TechLocationTracker } from '@/components/tech/tech-location-tracker';
import { TechSignOutButton } from '@/components/tech/tech-sign-out-button';
import { GuideLink } from '@/components/tech/guide-link';

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
    <div className="mx-auto min-h-dvh w-full max-w-md bg-canvas">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border-strong bg-surface px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold tracking-tight">Field</h1>
          <p className="truncate text-xs text-muted-foreground">{session.name}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <GuideLink />
          <TechSignOutButton />
        </div>
      </header>
      <main className="space-y-4 px-4 py-4">
        <TechLocationTracker />
        {children}
      </main>
    </div>
  );
}
