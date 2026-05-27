import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  // Add request ID for tracing (use Web Crypto API for Edge runtime compatibility)
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  response.headers.set("X-Request-Id", requestId);

  // Add security headers
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  return response;
}

export const config = {
  matcher: "/api/:path*",
};
