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
    window.location.href = '/admin/login';
    // Throw so the caller's try/catch exits without running further logic.
    throw new AdminAuthRedirectError();
  }
  return res;
}
