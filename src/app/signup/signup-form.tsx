'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AuthShell } from '@/components/auth/auth-shell';

/** Friendly, typed messages for the ?error= codes the signup flow redirects
 * with. Each maps to a human, non-technical line. */
const SIGNUP_ERROR_MESSAGES: Record<string, string> = {
  invalid_name: 'Please enter a business name (1–100 characters).',
  verification: 'We could not verify your Google account. Please try again.',
  signups_paused: 'New signups are paused right now. Please check back soon.',
  try_again: 'Something went wrong creating your account. Please try again.',
  rate_limited:
    'Too many attempts. Please wait a minute and try signing up again.',
};

/** Read the ?error= code from the URL and map it to a friendly message.
 * Runs during state init (client only); returns '' on the server or no error. */
function initialError(): string {
  if (typeof window === 'undefined') return '';
  const code = new URLSearchParams(window.location.search).get('error');
  return code ? (SIGNUP_ERROR_MESSAGES[code] ?? '') : '';
}

interface SignupFormProps {
  /** True when self-serve signup is configured server-side; gates the button. */
  readonly signupEnabled: boolean;
}

export function SignupForm({ signupEnabled }: SignupFormProps) {
  const [businessName, setBusinessName] = useState('');
  const [error] = useState(() => initialError());

  return (
    <AuthShell
      title="Start your account"
      subtitle="Stand up a service console in about a minute."
      footer={
        <p>
          Already have an account?{' '}
          <Link
            href="/admin/login"
            className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
          >
            Sign in
          </Link>
        </p>
      }
    >
      <div className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {signupEnabled ? (
          // A full-page POST (not fetch): the start route redirects to Google
          // and back, so it must be a top-level navigation.
          <form
            method="POST"
            action="/api/auth/signup/start"
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="businessName">Business name</Label>
              <Input
                id="businessName"
                name="businessName"
                type="text"
                placeholder="Acme Heating &amp; Air"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                required
                maxLength={100}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                You can rename it later in settings.
              </p>
            </div>

            <button
              type="submit"
              disabled={businessName.trim().length === 0}
              className="inline-flex h-11 w-full items-center justify-center gap-2.5 rounded-lg border border-input bg-background px-4 text-sm font-medium shadow-xs transition-all duration-200 ease-out hover:bg-accent hover:text-accent-foreground hover:shadow-md focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
            >
              <GoogleGlyph />
              Sign up with Google
            </button>

            <p className="text-center text-xs text-muted-foreground">
              We only use Google to verify who you are — nothing is posted on
              your behalf.
            </p>
          </form>
        ) : (
          <Alert>
            <AlertCircle className="size-4" />
            <AlertDescription>
              Signups are invite-only right now. Ask your administrator for an
              invite, or reach out and we&apos;ll get you set up.
            </AlertDescription>
          </Alert>
        )}
      </div>
    </AuthShell>
  );
}

/** Google "G" mark (matches the login page). */
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
