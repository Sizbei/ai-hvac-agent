/**
 * The admin shell for unmatched /admin URLs. It reuses the dashboard layout
 * (sidebar, auth redirect, tab title) but sits outside `(dashboard)` so its
 * `loading.tsx` Suspense boundary does not wrap the catch-all: nothing streams
 * before `notFound()` runs, so the response is a real HTTP 404, not a 200.
 */
export { default, generateMetadata } from '../(dashboard)/layout';
