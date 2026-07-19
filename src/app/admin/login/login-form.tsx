'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AuthShell } from '@/components/auth/auth-shell';
import type { LoginMode } from '@/lib/auth/login-mode';

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

/** A friendly notice the self-serve signup callback redirects with when the
 * Google account already has an account ("?notice=existing_account"). */
function initialNotice(): string {
  if (typeof window === 'undefined') return '';
  const notice = new URLSearchParams(window.location.search).get('notice');
  return notice === 'existing_account'
    ? 'You already have an account — sign in to continue.'
    : '';
}

interface LoginFormProps {
  /** Which UI to render — Google-only (policy) or the password fallback. */
  readonly mode: LoginMode;
  /** True when Google OIDC is configured server-side; gates the button. */
  readonly googleEnabled: boolean;
}

export function LoginForm({ mode, googleEnabled }: LoginFormProps) {
  const [error, setError] = useState(() => initialOidcError());
  const [notice] = useState(() => initialNotice());

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to the service console."
      footer={
        <p>
          New to Spears?{' '}
          <Link
            href="/signup"
            className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
          >
            Create an account
          </Link>
        </p>
      }
    >
      <div className="flex flex-col gap-4">
        {notice && !error && (
          <Alert>
            <AlertCircle className="size-4" />
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {mode === 'google' ? (
          <>
            <GoogleSignInButton prominent />
            <p className="text-center text-xs text-muted-foreground">
              Use the Google account your administrator invited.{' '}
              <Link
                href="/admin/forgot-password"
                className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
              >
                Trouble signing in?
              </Link>
            </p>
          </>
        ) : (
          <>
            <PasswordForm onError={setError} />
            {googleEnabled && (
              <>
                <div className="flex items-center gap-3">
                  <span className="h-px flex-1 bg-border" />
                  <span className="text-xs text-muted-foreground">or</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
                <GoogleSignInButton />
              </>
            )}
          </>
        )}
      </div>
    </AuthShell>
  );
}

/** Email + password fallback. Shown only when Google OIDC is not configured
 * (dev/preview/bootstrap) or via the ?password=1 break-glass override. */
function PasswordForm({ onError }: { readonly onError: (msg: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    onError('');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data: unknown = await res.json();

      if (!res.ok) {
        const errorData = data as { error?: { message?: string } };
        onError(errorData.error?.message ?? 'Login failed');
        return;
      }

      window.location.href = '/admin/requests';
    } catch {
      onError('Network error. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
          disabled={isLoading}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between">
          <Label htmlFor="password">Password</Label>
          <Link
            href="/admin/forgot-password"
            className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Forgot password?
          </Link>
        </div>
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
            Signing in…
          </>
        ) : (
          'Sign in'
        )}
      </Button>
    </form>
  );
}

/** "Continue with Google" — a plain styled anchor (not fetch): the OAuth flow
 * is a full-page redirect to Google and back. `prominent` is the Google-only
 * hero treatment; the default is the compact under-the-form variant. */
function GoogleSignInButton({ prominent = false }: { readonly prominent?: boolean }) {
  return (
    <a
      href="/api/auth/google/start"
      className={
        prominent
          ? 'inline-flex h-11 w-full items-center justify-center gap-2.5 rounded-lg border border-input bg-background px-4 text-sm font-medium shadow-xs transition-all duration-200 ease-out hover:bg-accent hover:text-accent-foreground hover:shadow-md focus-visible:ring-3 focus-visible:ring-ring/50'
          : 'inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-input bg-background px-4 text-sm font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50'
      }
    >
      <GoogleGlyph />
      Continue with Google
    </a>
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
