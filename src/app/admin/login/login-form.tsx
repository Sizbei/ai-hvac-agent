'use client';

import { useState } from 'react';
import { Wind, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

/** Generic, non-enumerating messages for the ?error= codes the OIDC callback
 * redirects with. All denial paths map to a single uninformative message. */
const OIDC_ERROR_MESSAGES: Record<string, string> = {
  no_account: 'This Google account is not authorized to sign in.',
  email_unverified:
    'Your Google email is not verified. Verify it with Google and try again.',
  google_failed: 'Google sign-in could not be completed. Please try again.',
};

/** Read the OIDC ?error= code from the URL and map it to a generic message.
 * Runs during state init (client only); returns '' on the server or no error. */
function initialOidcError(): string {
  if (typeof window === 'undefined') return '';
  const code = new URLSearchParams(window.location.search).get('error');
  return code ? (OIDC_ERROR_MESSAGES[code] ?? '') : '';
}

interface LoginFormProps {
  /** True when Google OIDC is configured server-side; gates the button. */
  readonly googleEnabled: boolean;
}

export function LoginForm({ googleEnabled }: LoginFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Initialize from the ?error= the OIDC callback may have redirected with, so
  // the message is present on first paint (no effect, no flash).
  const [error, setError] = useState(() => initialOidcError());
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data: unknown = await res.json();

      if (!res.ok) {
        const errorData = data as { error?: { message?: string } };
        setError(errorData.error?.message ?? 'Login failed');
        return;
      }

      window.location.href = '/admin/requests';
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-gradient-to-br from-[oklch(0.22_0.05_258)] to-[oklch(0.16_0.05_260)] px-4">
      {/* Cyan brand glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 right-[-10%] size-[34rem] rounded-full bg-[radial-gradient(circle_at_center,oklch(0.72_0.13_220/0.3),transparent_70%)] blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-[-12rem] left-[-8%] size-[28rem] rounded-full bg-[radial-gradient(circle_at_center,oklch(0.4_0.1_250/0.25),transparent_70%)] blur-3xl"
      />
      <Card className="relative z-10 w-full max-w-sm shadow-2xl">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-[oklch(0.62_0.13_222)] text-primary-foreground shadow-lg">
            <Wind className="size-7" />
          </div>
          <CardTitle className="font-heading text-xl">Spears Services</CardTitle>
          <CardDescription>Sign in to the service console</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="admin@demo-hvac.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                disabled={isLoading}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={isLoading}
              />
            </div>

            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                'Sign In'
              )}
            </Button>
          </form>

          {googleEnabled && (
            <>
              <div className="my-4 flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted-foreground">or</span>
                <span className="h-px flex-1 bg-border" />
              </div>
              {/* A plain styled anchor (not fetch) — the OAuth flow is a
                  full-page redirect to Google and back. */}
              <a
                href="/api/auth/google/start"
                aria-disabled={isLoading}
                className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-input bg-background px-4 text-sm font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-disabled:pointer-events-none aria-disabled:opacity-50"
              >
                <GoogleGlyph />
                Sign in with Google
              </a>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Google "G" mark. */
function GoogleGlyph() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.26 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
      />
    </svg>
  );
}
