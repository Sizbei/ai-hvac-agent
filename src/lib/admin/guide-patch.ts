import { adminFetch } from "./admin-fetch";
import type { GuidePatch } from "./admin-guide-state";

/**
 * The one client write to PATCH /api/admin/guide (setup card and quick tour).
 * Fire-and-forget: resolves `ok` and never rejects; a 401 still sends the
 * browser to sign in (adminFetch). Nothing is logged.
 */
export function patchGuide(body: GuidePatch): Promise<boolean> {
  return adminFetch("/api/admin/guide", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(
    (res) => res.ok,
    () => false,
  );
}
