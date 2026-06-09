import { NextResponse } from "next/server";

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiError {
  success: false;
  error: {
    message: string;
    code: string;
    /** Optional structured payload for errors the client must act on (e.g. a
     * 409 SCHEDULE_CONFLICT carries the conflicting jobs so the UI can offer an
     * override). PII-free by contract — callers pass ids/flags only. */
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export function successResponse<T>(
  data: T,
  status: number = 200,
): NextResponse<ApiSuccess<T>> {
  return NextResponse.json({ success: true as const, data }, { status });
}

export function errorResponse(
  message: string,
  code: string,
  status: number = 400,
  details?: unknown,
): NextResponse<ApiError> {
  return NextResponse.json(
    {
      success: false as const,
      error:
        details === undefined
          ? { message, code }
          : { message, code, details },
    },
    { status },
  );
}
