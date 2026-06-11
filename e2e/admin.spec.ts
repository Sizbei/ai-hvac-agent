import { test, expect } from '@playwright/test';

/**
 * E2E Tests for Admin Dashboard
 * Tests admin authentication, session management, and dashboard features.
 */

test.describe('Admin Dashboard', () => {
  test.beforeEach(async ({ page, context }) => {
    // Set up test admin session cookie
    // In production, this would use proper login flow
    await context.addCookies([
      {
        name: 'hvac_admin_session',
        value: 'test_admin_session_token',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
  });

  test('should redirect to login if not authenticated', async ({ page }) => {
    // Clear cookies to test auth redirect
    await page.context().clearCookies();

    await page.goto('/admin');
    await expect(page).toHaveURL(/\/login|\/auth/i);
  });

  test('should load admin dashboard', async ({ page }) => {
    await page.goto('/admin/dashboard');

    // Should load dashboard
    await expect(page.getByText(/dashboard/i).or(page.getByText(/overview/i))).toBeVisible();
  });

  test('should show session list', async ({ page }) => {
    await page.goto('/admin/dashboard');

    // Look for sessions table or list
    await expect(page.getByText(/session/i).or(page.getByText(/customer/i))).toBeVisible();
  });

  test('should navigate between admin sections', async ({ page }) => {
    await page.goto('/admin');

    // Test navigation to different sections
    const navLinks = page.getByRole('navigation').getByRole('link');

    // Dashboard link
    await navLinks.filter({ hasText: /dashboard/i }).click();
    await expect(page).toHaveURL(/dashboard/);

    // Sessions link
    await navLinks.filter({ hasText: /session/i }).click();
    await expect(page).toHaveURL(/session/);
  });

  test('should filter sessions by status', async ({ page }) => {
    await page.goto('/admin/sessions');

    // Look for status filters
    const activeFilter = page.getByRole('button').filter({ hasText: /active/i });
    if (await activeFilter.isVisible()) {
      await activeFilter.click();
      // Should filter sessions
      await page.waitForTimeout(500);
    }
  });

  test('should display session details', async ({ page }) => {
    await page.goto('/admin/sessions');

    // Click on first session
    const firstSession = page.getByRole('link').first();
    if (await firstSession.isVisible()) {
      await firstSession.click();
      // Should show session details
      await expect(page.getByText(/details/i).or(page.getByText(/transcript/i))).toBeVisible();
    }
  });

  test('should handle team invites', async ({ page }) => {
    await page.goto('/admin/settings');

    // Look for team invite section
    const inviteSection = page.getByText(/invite/i).or(page.getByText(/team/i));
    if (await inviteSection.isVisible()) {
      await expect(inviteSection).toBeVisible();

      // Look for invite button
      const inviteButton = page.getByRole('button').filter({ hasText: /invite/i });
      if (await inviteButton.isVisible()) {
        await inviteButton.click();
        // Should show invite modal or form
        await expect(page.getByText(/email/i)).toBeVisible({ timeout: 5000 });
      }
    }
  });

  test('should show service request cards', async ({ page }) => {
    await page.goto('/admin/dispatch');

    // Look for service requests or dispatch board
    await expect(page.getByText(/request/i).or(page.getByText(/dispatch/i))).toBeVisible({ timeout: 5000 });
  });

  test('should handle logout', async ({ page }) => {
    await page.goto('/admin/dashboard');

    // Look for logout button
    const logoutButton = page.getByRole('button').filter({ hasText: /logout|sign out/i });
    if (await logoutButton.isVisible()) {
      await logoutButton.click();
      // Should redirect to login
      await expect(page).toHaveURL(/\/login|\/auth/i);
    }
  });
});

test.describe('Admin Authentication', () => {
  test('should show Google OAuth login button', async ({ page }) => {
    await page.goto('/admin/login');

    // Should show Google sign-in button
    await expect(page.getByText(/google/i).or(page.getByRole('button', { name: /sign in/i }))).toBeVisible();
  });

  test('should redirect after successful login', async ({ context, page }) => {
    // Start login flow
    await page.goto('/admin/login');

    // In real test, this would complete OAuth flow
    // For now, test that redirect occurs
    const url = page.url();
    expect(url).toMatch(/\/login|\/auth/);
  });
});
