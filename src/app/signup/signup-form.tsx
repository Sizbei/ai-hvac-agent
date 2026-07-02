'use client';

import { useState } from 'react';
import { Wind, AlertCircle } from 'lucide-react';
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

/** Friendly, typed messages for the ?error= codes the signup flow redirects
 * with. Each maps to a human, non-technical line. */
const SIGNUP_ERROR_MESSAGES: Record<string, string> = {
  invalid_name: 'Please enter a business name (1–100 characters).',
  verification:
    'We could not verify your Google account. Please try again.',
  signups_paused:
    'New signups are paused right now. Please check back soon.',
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
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-gradient-to-br from-[oklch(0.22_0.05_258)] to-[oklch(0.16_0.05_260)] px-4">
      {/* Cyan brand glow (mirrors the login page) */}
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
          <CardTitle className="font-heading text-xl">
            Start your account
          </CardTitle>
          <CardDescription>
            Create your service console in a minute
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <Alert variant="destructive" className="mb-4">
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
              </div>

              <button
                type="submit"
                disabled={businessName.trim().length === 0}
                className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-input bg-background px-4 text-sm font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
              >
                <GoogleGlyph />
                Sign up with Google
              </button>
            </form>
          ) : (
            <Alert>
              <AlertCircle className="size-4" />
              <AlertDescription>
                Signup is not available right now. Please contact us to get
                started.
              </AlertDescription>
            </Alert>
          )}

          <p className="mt-4 text-center text-xs text-muted-foreground">
            Already have an account?{' '}
            <a
              href="/admin/login"
              className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
            >
              Sign in
            </a>
          </p>
        </CardContent>
      </Card>
    </div>
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
