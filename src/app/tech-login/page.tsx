import { getGoogleOidcConfig } from '@/lib/auth/google-oidc';
import { TechLoginForm } from './tech-login-form';

/**
 * Technician login (mobile-first, ungated, top-level so it sits OUTSIDE the
 * /tech session gate — no redirect loop). Server component so it can read the
 * OIDC env config (server-only) and gate the "Continue with Google" button —
 * a dead button never renders when Google sign-in isn't configured.
 */
export default function TechLoginPage() {
  const googleEnabled = getGoogleOidcConfig() !== null;
  return <TechLoginForm googleEnabled={googleEnabled} />;
}
