import { getGoogleOidcConfig } from '@/lib/auth/google-oidc';
import { LoginForm } from './login-form';

/**
 * Admin login. Server component so it can read the OIDC env config (server-only)
 * and decide whether to show the "Sign in with Google" button — a dead button
 * never renders when login-with-Google isn't configured.
 */
export default function AdminLoginPage() {
  const googleEnabled = getGoogleOidcConfig() !== null;
  return <LoginForm googleEnabled={googleEnabled} />;
}
