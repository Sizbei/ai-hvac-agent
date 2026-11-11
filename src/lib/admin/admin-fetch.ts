/**
 * Thin fetch wrapper for admin client hooks. On a 401 response it redirects to
 * the login page and throws a sentinel so callers abort early without rendering
 * an error banner.
 *
 * Drop-in replacement for the global `fetch` in admin data hooks:
 *   const res = await adminFetch('/api/admin/...', { signal });
 *
 * The `signal` in `init` is forwarded as-is so AbortController / monotonic-run
 * patterns in callers are not disrupted.
 */

/** Thrown after a 401-redirect so hook code can `return` in the catch branch
 *  without setting an error banner. */
export class AdminAuthRedirectError extends Error {
  constructor() {
    super('Unauthenticated — redirecting to login');
    this.name = 'AdminAuthRedirectError';
  }
}

export async function adminFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401) {
    // Carry where the user was, so signing back in returns them there.
    window.location.href = loginUrlWithReturn(window.location.pathname + window.location.search);
    // Throw so the caller's try/catch exits without running further logic.
    throw new AdminAuthRedirectError();
  }
  return res;
}

/**
 * A same-site admin path that is safe to return to after sign-in, or null.
 * Only `/admin/...` paths are accepted — never a scheme, host, `//` or
 * backslash form — so `?next=` can't be used as an open redirect.
 */
export function safeAdminReturnPath(next: string | null | undefined): string | null {
  if (!next) return null;
  if (!/^\/admin(\/|\?|$)/.test(next)) return null;
  if (next.includes('//') || next.includes('\\') || /[\u0000-\u001f]/.test(next)) return null;
  if (/^\/admin\/(login|forgot-password|invite)(\/|\?|$)/.test(next)) return null;
  return next;
}

/** The sign-in URL carrying a return path (dropped when it isn't a safe one). */
export function loginUrlWithReturn(current: string): string {
  const safe = safeAdminReturnPath(current);
  return safe ? `/admin/login?next=${encodeURIComponent(safe)}` : '/admin/login';
}
