import { Suspense } from 'react';
import { getGoogleOidcConfig } from '@/lib/auth/google-oidc';
import { resolveLoginMode } from '@/lib/auth/login-mode';
import { LoginForm, LoginFormFromUrl } from './login-form';

/**
 * Admin login. Server component so it can read the OIDC env config
 * (server-only). The page itself is STATIC — it reads no request data, so it is
 * prerendered and served from the edge instead of booting a function. The
 * ?password=1 break-glass override is read in the browser (LoginFormFromUrl);
 * until then the form renders in its default mode.
 */
export default function AdminLoginPage() {
  const googleEnabled = getGoogleOidcConfig() !== null;
  const defaultMode = resolveLoginMode({ googleEnabled, passwordParam: undefined });
  return (
    <Suspense fallback={<LoginForm mode={defaultMode} googleEnabled={googleEnabled} />}>
      <LoginFormFromUrl googleEnabled={googleEnabled} />
    </Suspense>
  );
}
