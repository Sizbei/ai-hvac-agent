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
): NextResponse<ApiError> {
  return NextResponse.json(
    { success: false as const, error: { message, code } },
    { status },
  );
}
