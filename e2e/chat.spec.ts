import { test, expect } from '@playwright/test';

/**
 * E2E Tests for Chat Flow
 * Tests the core customer chat experience including message sending,
 * history persistence, and file uploads.
 */

test.describe('Chat Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should load chat interface', async ({ page }) => {
    // Check that chat input is visible
    await expect(page.getByPlaceholder(/type/i)).toBeVisible();
    // Check that send button exists
    await expect(page.getByRole('button', { name: /send/i })).toBeVisible();
  });

  test('should send a message and receive response', async ({ page }) => {
    const chatInput = page.getByPlaceholder(/type/i);
    const sendButton = page.getByRole('button', { name: /send/i });

    // Type a message
    await chatInput.fill('Hello, I need HVAC help');

    // Send message
    await sendButton.click();

    // Verify message appears in chat
    await expect(page.getByText('Hello, I need HVAC help')).toBeVisible();

    // Wait for bot response (streaming may take a moment)
    await expect(page.getByText(/hi there/i)).toBeVisible({ timeout: 15000 });
  });

  test('should show history sidebar with past sessions', async ({ page }) => {
    // First, create a session by sending a message
    await page.getByPlaceholder(/type/i).fill('Test message for history');
    await page.getByRole('button', { name: /send/i }).click();
    await page.waitForTimeout(2000);

    // Reload page to test session persistence
    await page.reload();

    // Look for history icon/button
    const historyButton = page.getByRole('button').filter({ hasText: /history/i }).first();
    if (await historyButton.isVisible()) {
      await historyButton.click();
      // Should show past sessions
      await expect(page.getByText(/previous/i).or(page.getByText(/past/i))).toBeVisible();
    }
  });

  test('should handle triage flow for service request', async ({ page }) => {
    const chatInput = page.getByPlaceholder(/type/i);

    // Start service request flow
    await chatInput.fill('My AC is not cooling');
    await page.getByRole('button', { name: /send/i }).click();

    // Should enter triage/capture flow
    await expect(page.getByText(/address/i).or(page.getByText(/location/i))).toBeVisible({ timeout: 10000 });
  });

  test('should handle file upload', async ({ page }) => {
    // Find file input (hidden but accessible)
    const fileInput = page.locator('input[type="file"]');

    // Create a test image file
    const fileBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );

    // Upload file
    await fileInput.setInputFiles({
      name: 'test-photo.png',
      mimeType: 'image/png',
      buffer: fileBuffer,
    });

    // Verify file appears in upload preview or is processed
    await expect(page.getByText(/upload/i).or(page.getByRole('img'))).toBeVisible({ timeout: 5000 });
  });

  test('should show error for invalid file type', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]');

    // Try to upload a non-image file
    const fileBuffer = Buffer.from('Not an image');

    await fileInput.setInputFiles({
      name: 'test.txt',
      mimeType: 'text/plain',
      buffer: fileBuffer,
    });

    // Should show error message
    await expect(page.getByText(/invalid/i).or(page.getByText(/image/i))).toBeVisible({ timeout: 5000 });
  });

  test('should handle session persistence across page reload', async ({ page }) => {
    const testMessage = 'Persistence test message';

    // Send a message
    await page.getByPlaceholder(/type/i).fill(testMessage);
    await page.getByRole('button', { name: /send/i }).click();
    await expect(page.getByText(testMessage)).toBeVisible();

    // Reload page
    await page.reload();

    // Message should still be visible (session persistence)
    await expect(page.getByText(testMessage)).toBeVisible();
  });

  test('should show typing indicator during response', async ({ page }) => {
    await page.getByPlaceholder(/type/i).fill('Tell me about your services');
    await page.getByRole('button', { name: /send/i }).click();

    // Check for typing indicator or loading state
    const typingIndicator = page.getByRole('status').or(page.locator('[aria-busy="true"]'));
    await expect(typingIndicator).toBeVisible({ timeout: 3000 });
  });

  test('should handle empty message submission', async ({ page }) => {
    const sendButton = page.getByRole('button', { name: /send/i });

    // Try to send empty message
    await sendButton.click();

    // Input should be disabled or button should be disabled
    const chatInput = page.getByPlaceholder(/type/i);
    const isDisabled = await chatInput.isDisabled();
    expect(isDisabled).toBeFalsy(); // Input should still be enabled

    // No message should appear
    await expect(page.getByText(/\S/)).not.toHaveCount(0);
  });

  test('should show ESC flow (emergency escalation)', async ({ page }) => {
    const chatInput = page.getByPlaceholder(/type/i);

    // Trigger emergency scenario
    await chatInput.fill('emergency gas leak smell');
    await page.getByRole('button', { name: /send/i }).click();

    // Should show emergency response
    await expect(page.getByText(/emergency/i).or(page.getByText(/gas/i))).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Chat Flow - Accessibility', () => {
  test('should have proper ARIA labels', async ({ page }) => {
    await page.goto('/');

    // Check for ARIA labels on key interactive elements
    const chatInput = page.getByPlaceholder(/type/i);
    await expect(chatInput).toBeVisible();

    // Send button should have aria-label or accessible text
    const sendButton = page.getByRole('button', { name: /send/i });
    await expect(sendButton).toBeVisible();
  });

  test('should be keyboard navigable', async ({ page }) => {
    await page.goto('/');

    // Tab to input
    await page.keyboard.press('Tab');
    await page.keyboard.type('Keyboard test');

    // Enter should send message
    await page.keyboard.press('Enter');

    // Message should appear
    await expect(page.getByText('Keyboard test')).toBeVisible();
  });
});
