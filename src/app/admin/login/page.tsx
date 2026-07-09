import { getGoogleOidcConfig } from '@/lib/auth/google-oidc';
import { resolveLoginMode } from '@/lib/auth/login-mode';
import { LoginForm } from './login-form';

/**
 * Admin login. Server component so it can read the OIDC env config
 * (server-only) and pick the login mode: Google-only when configured, the
 * password form as the not-configured fallback or via the ?password=1
 * break-glass override.
 */
export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const googleEnabled = getGoogleOidcConfig() !== null;
  const mode = resolveLoginMode({
    googleEnabled,
    passwordParam: (await searchParams).password,
  });
  return <LoginForm mode={mode} googleEnabled={googleEnabled} />;
}
