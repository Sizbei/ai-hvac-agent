import { describe, it, expect } from 'vitest';
import { successResponse, errorResponse } from '@/lib/api-response';

describe('successResponse', () => {
  it('should return response with success: true and data', async () => {
    const data = { id: '123', name: 'Test' };
    const response = successResponse(data);
    const body = await response.json();
    expect(body).toEqual({ success: true, data: { id: '123', name: 'Test' } });
  });

  it('should default to 200 status', () => {
    const response = successResponse({ value: 1 });
    expect(response.status).toBe(200);
  });

  it('should accept custom status code', () => {
    const response = successResponse({ created: true }, 201);
    expect(response.status).toBe(201);
  });

  it('should handle null data', async () => {
    const response = successResponse(null);
    const body = await response.json();
    expect(body).toEqual({ success: true, data: null });
  });

  it('should handle array data', async () => {
    const response = successResponse([1, 2, 3]);
    const body = await response.json();
    expect(body).toEqual({ success: true, data: [1, 2, 3] });
  });

  it('should handle string data', async () => {
    const response = successResponse('hello');
    const body = await response.json();
    expect(body).toEqual({ success: true, data: 'hello' });
  });
});

describe('errorResponse', () => {
  it('should return response with success: false and error details', async () => {
    const response = errorResponse('Not found', 'NOT_FOUND', 404);
    const body = await response.json();
    expect(body).toEqual({
      success: false,
      error: { message: 'Not found', code: 'NOT_FOUND' },
    });
  });

  it('should default to 400 status', () => {
    const response = errorResponse('Bad input', 'VALIDATION_ERROR');
    expect(response.status).toBe(400);
  });

  it('should accept custom status code', () => {
    const response = errorResponse('Server error', 'INTERNAL_ERROR', 500);
    expect(response.status).toBe(500);
  });

  it('should include message and code in error object', async () => {
    const response = errorResponse('Unauthorized', 'AUTH_REQUIRED', 401);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.message).toBe('Unauthorized');
    expect(body.error.code).toBe('AUTH_REQUIRED');
  });
});
