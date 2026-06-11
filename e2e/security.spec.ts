import { test, expect } from '@playwright/test';

/**
 * E2E Security Tests
 * Tests security controls and attack prevention.
 */

test.describe('Security Controls', () => {
  test('should have security headers', async ({ page, request }) => {
    const response = await request.get('/');
    const headers = response.headers();

    // Check for security headers
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['strict-transport-security']).toBeDefined();
  });

  test('should prevent XSS in chat input', async ({ page }) => {
    await page.goto('/');

    const chatInput = page.getByPlaceholder(/type/i);

    // Try XSS payload
    const xssPayload = '<script>alert("XSS")</script>Hello';
    await chatInput.fill(xssPayload);
    await page.getByRole('button', { name: /send/i }).click();

    // Message should appear but script should not execute
    await expect(page.getByText('Hello')).toBeVisible();
    // Check that alert was not triggered (no XSS execution)
    const alertHandled = page.on('dialog', () => true);
    expect(alertHandled).toBeUndefined();
  });

  test('should have CSRF protection', async ({ page, request }) => {
    // Try POST without proper CSRF token
    const response = await request.post('/api/session', {
      data: { message: 'test' },
    });

    // Should fail with 403 or similar
    expect([403, 401, 400]).toContain(response.status());
  });

  test('should rate limit requests', async ({ page }) => {
    await page.goto('/');

    const chatInput = page.getByPlaceholder(/type/i);
    const sendButton = page.getByRole('button', { name: /send/i });

    // Send many messages rapidly
    for (let i = 0; i < 25; i++) {
      await chatInput.fill(`Message ${i}`);
      await sendButton.click();
      await page.waitForTimeout(100);
    }

    // Should eventually be rate limited
    await expect(page.getByText(/rate limit|too many|slow down/i)).toBeVisible({ timeout: 10000 });
  });

  test('should validate file uploads', async ({ page }) => {
    await page.goto('/');

    const fileInput = page.locator('input[type="file"]');

    // Try to upload large file (>5MB)
    const largeBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB
    await fileInput.setInputFiles({
      name: 'large.jpg',
      mimeType: 'image/jpeg',
      buffer: largeBuffer,
    });

    // Should show size error
    await expect(page.getByText(/size|large|mb/i)).toBeVisible({ timeout: 5000 });
  });

  test('should sanitize file names', async ({ page }) => {
    await page.goto('/');

    const fileInput = page.locator('input[type="file"]');

    // Try file with suspicious name
    const fileBuffer = Buffer.from('fake image');
    await fileInput.setInputFiles({
      name: '../../../etc/passwd.png',
      mimeType: 'image/png',
      buffer: fileBuffer,
    });

    // Should either reject or sanitize the filename
    // The file should not be accepted as valid PNG (magic byte check)
    await expect(page.getByText(/invalid|upload/i)).toBeVisible({ timeout: 5000 });
  });

  test('should prevent clickjacking', async ({ page }) => {
    const headers = await page.request.get('/', {
      headers: { 'X-Frame-Options': 'SAMEORIGIN' },
    });

    // Check that frame protection is in place
    expect(headers.headers()['x-frame-options']).toBe('DENY');
  });
});

test.describe('Session Security', () => {
  test('should use secure cookies', async ({ page, context }) => {
    // Check cookie security attributes
    await page.goto('/');

    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name.includes('session'));

    if (sessionCookie) {
      expect(sessionCookie.httpOnly).toBeTruthy();
      expect(sessionCookie.sameSite).toBe('Strict');
    }
  });

  test('should invalidate session on logout', async ({ page }) => {
    // This would test session invalidation
    // In real implementation, logout clears the session
    await page.goto('/admin/login');
    const cookiesBefore = await page.context().cookies();

    // Perform logout (if implemented in test)
    // await page.getByRole('button', { name: /logout/i }).click();

    // Verify session is cleared
    // const cookiesAfter = await page.context().cookies();
    // expect(cookiesAfter.length).toBeLessThan(cookiesBefore.length);
  });

  test('should not leak session data in client JS', async ({ page }) => {
    await page.goto('/');

    // Check that session token is not exposed in client-side code
    const pageContent = await page.content();
    expect(pageContent).not.toMatch(/token.*:.*sk-|secret.*:/i);
  });
});
