'use client';

import { useCallback, useState } from 'react';
import { LogOut } from 'lucide-react';

/**
 * Sign-out control for the tech shell header. Mirrors the admin sidebar's
 * logout convention (POST the logout route, then hard-navigate) — a full
 * navigation, not router.push, so the gated layout re-runs with no cookie.
 */
export function TechSignOutButton() {
  const [busy, setBusy] = useState(false);

  const signOut = useCallback(async () => {
    setBusy(true);
    try {
      await fetch('/api/auth/tech/logout', { method: 'POST' });
    } finally {
      window.location.href = '/tech-login';
    }
  }, []);

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      aria-label="Sign out"
      className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
    >
      <LogOut className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
