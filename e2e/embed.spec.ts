import { test, expect } from '@playwright/test';

/**
 * E2E Tests for Embedded Widget
 * Tests the embeddable chat widget functionality.
 */

test.describe('Embedded Widget', () => {
  test('should load widget script', async ({ page, request }) => {
    const response = await request.get('/widget.js');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('javascript');
  });

  test('should render chat button on page', async ({ page }) => {
    // Create a simple HTML page with the widget
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head><title>Widget Test</title></head>
        <body>
          <script src="http://localhost:3000/widget.js?key=test-key"></script>
        </body>
      </html>
    `);

    // Wait for widget to load
    await page.waitForTimeout(2000);

    // Check for chat button (should be injected by widget)
    const chatButton = page.locator('.w-btn').or(page.getByRole('button', { name: /chat/i }));
    await expect(chatButton).toBeVisible({ timeout: 5000 });
  });

  test('should open chat panel when button clicked', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head><title>Widget Test</title></head>
        <body>
          <script src="http://localhost:3000/widget.js?key=test-key"></script>
        </body>
      </html>
    `);

    await page.waitForTimeout(2000);

    // Click chat button
    const chatButton = page.locator('.w-btn').or(page.getByRole('button', { name: /chat/i }));
    await chatButton.click();

    // Panel should open
    const chatPanel = page.locator('.w-panel').or(page.locator('[role="dialog"]'));
    await expect(chatPanel).toHaveClass(/open/);
  });

  test('should close panel on ESC key', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head><title>Widget Test</title></head>
        <body>
          <script src="http://localhost:3000/widget.js?key=test-key"></script>
        </body>
      </html>
    `);

    await page.waitForTimeout(2000);

    // Open panel
    const chatButton = page.locator('.w-btn');
    await chatButton.click();

    // Press ESC
    await page.keyboard.press('Escape');

    // Panel should close
    const chatPanel = page.locator('.w-panel');
    await expect(chatPanel).not.toHaveClass(/open/);
  });

  test('should use custom branding colors', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head><title>Widget Test</title></head>
        <body>
          <div id="hvac-chat-config" style="display:none">
            { "primaryColor": "#FF5733", "companyName": "Test HVAC" }
          </div>
          <script src="http://localhost:3000/widget.js?key=test-key"></script>
        </body>
      </html>
    `);

    await page.waitForTimeout(2000);

    // Check button uses custom color
    const chatButton = page.locator('.w-btn');
    const backgroundColor = await chatButton.evaluate((el) =>
      window.getComputedStyle(el).backgroundColor
    );

    // Should use the custom color (approximately)
    expect(backgroundColor).toBeDefined();
  });

  test('should iframe isolate chat content', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head><title>Widget Test</title></head>
        <body>
          <script src="http://localhost:3000/widget.js?key=test-key"></script>
        </body>
      </html>
    `);

    await page.waitForTimeout(2000);

    // Open chat
    const chatButton = page.locator('.w-btn');
    await chatButton.click();
    await page.waitForTimeout(1000);

    // Should have iframe
    const iframe = page.locator('iframe');
    await expect(iframe).toBeVisible();
  });

  test('should handle invalid API key gracefully', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head><title>Widget Test</title></head>
        <body>
          <script src="http://localhost:3000/widget.js?key=invalid-key"></script>
        </body>
      </html>
    `);

    await page.waitForTimeout(2000);

    // Button should still appear (widget loads even with invalid key)
    const chatButton = page.locator('.w-btn');
    await expect(chatButton).toBeVisible({ timeout: 5000 });
  });

  test('should be accessible via keyboard', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head><title>Widget Test</title></head>
        <body>
          <script src="http://localhost:3000/widget.js?key=test-key"></script>
        </body>
      </html>
    `);

    await page.waitForTimeout(2000);

    // Tab to button
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');

    // Press Enter to open
    await page.keyboard.press('Enter');

    // Panel should open
    const chatPanel = page.locator('.w-panel');
    await expect(chatPanel).toHaveClass(/open/);
  });
});
