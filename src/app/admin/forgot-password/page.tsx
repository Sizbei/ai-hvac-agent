import { getGoogleOidcConfig } from '@/lib/auth/google-oidc';
import { ForgotPasswordForm } from './forgot-password-form';

/**
 * Password recovery. Passwords are the break-glass fallback here (Google OIDC is
 * primary and Google accounts have no password), and staff passwords are reset
 * by an administrator from settings — there is no self-serve email reset. This
 * page is the honest recovery guide: it never claims to email a reset link, and
 * responds identically for every address (no account enumeration).
 */
export default function ForgotPasswordPage() {
  const googleEnabled = getGoogleOidcConfig() !== null;
  return <ForgotPasswordForm googleEnabled={googleEnabled} />;
}
