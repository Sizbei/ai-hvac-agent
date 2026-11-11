/**
 * Second layer behind the proxy (final review I1): "View as" a technician is
 * read-only, so every tech write handler refuses a preview session itself.
 * The proxy refuses these first; this holds if it is ever bypassed.
 */
import type { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-response";
import type { TechSession } from "@/lib/auth/tech-session";

/** 403 PREVIEW_READ_ONLY for a non-GET/HEAD request in a preview session; null otherwise. */
export function previewWriteRefusal(
  session: TechSession,
  request: { readonly method: string },
): NextResponse | null {
  if (!session.preview) return null;
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return null;
  return errorResponse("Read-only while viewing as another user", "PREVIEW_READ_ONLY", 403);
}
