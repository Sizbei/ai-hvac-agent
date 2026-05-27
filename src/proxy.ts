import { NextResponse, type NextRequest } from "next/server";
import { verifyToken } from "@/lib/auth/config";

const ADMIN_SESSION_COOKIE = "hvac_admin_session";

function addSecurityHeaders(response: NextResponse, requestId: string): void {
  response.headers.set("X-Request-Id", requestId);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // --- Admin page route protection ---
  if (pathname.startsWith("/admin")) {
    // Redirect /admin exactly to /admin/requests
    if (pathname === "/admin") {
      return NextResponse.redirect(new URL("/admin/requests", request.url));
    }

    // Allow /admin/login without authentication
    if (pathname === "/admin/login") {
      const response = NextResponse.next();
      const requestId =
        request.headers.get("x-request-id") ?? crypto.randomUUID();
      addSecurityHeaders(response, requestId);
      return response;
    }

    // All other /admin/* pages require authentication
    const token = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
    const session = token ? await verifyToken(token) : null;

    if (!session) {
      return NextResponse.redirect(new URL("/admin/login", request.url));
    }
  }

  // --- Admin API route protection ---
  if (pathname.startsWith("/api/admin")) {
    const token = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
    const session = token ? await verifyToken(token) : null;

    if (!session) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "Unauthorized", code: "UNAUTHORIZED" },
        },
        { status: 401 },
      );
    }
  }

  // --- Default: apply security headers and pass through ---
  const response = NextResponse.next();
  const requestId =
    request.headers.get("x-request-id") ?? crypto.randomUUID();
  addSecurityHeaders(response, requestId);

  return response;
}

export const config = {
  matcher: ["/api/:path*", "/admin/:path*"],
};
