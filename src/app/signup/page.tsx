import { notFound } from 'next/navigation';
import { signupEnabledFromEnv } from '@/lib/auth/signup-enabled';
import { getGoogleOidcConfig } from '@/lib/auth/google-oidc';
import { SignupForm } from './signup-form';

/**
 * Public self-serve signup. Server component so it can read the OIDC env config
 * (server-only) and decide whether signup is available — the button never
 * renders when the signup OIDC env isn't configured (the start route 404s).
 */
export default function SignupPage() {
  if (!signupEnabledFromEnv()) notFound();
  const signupEnabled =
    getGoogleOidcConfig() !== null &&
    Boolean(process.env.GOOGLE_OIDC_SIGNUP_REDIRECT_URI);
  return <SignupForm signupEnabled={signupEnabled} />;
}
