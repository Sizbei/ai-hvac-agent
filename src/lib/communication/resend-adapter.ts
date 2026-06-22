/**
 * Resend Email Adapter
 *
 * Handles sending emails via Resend (resend.com).
 * Validates email addresses and handles delivery status webhooks.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Resend, type CreateEmailOptions } from "resend";

let _resend: Resend | null = null;

/**
 * Lazily construct the Resend client.
 *
 * Throwing at call time (rather than at module load) means importing this module
 * never crashes the production build / page-data collection when RESEND_API_KEY
 * is absent — only an actual email send fails, and only then, with a clear
 * error. Email is an optional integration; its missing key must not block deploy.
 */
export function getResend(): Resend {
  if (_resend) return _resend;
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("RESEND_API_KEY environment variable is not set");
  }
  _resend = new Resend(apiKey);
  return _resend;
}

/**
 * Email message result
 */
export interface EmailResult {
  id: string;
  to: string;
  from: string;
  subject: string;
}

/**
 * Send an email via Resend
 *
 * @param options - Email options
 * @returns Resend message result with ID
 * @throws Error if sending fails
 */
export async function sendEmail(options: {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
}): Promise<EmailResult> {
  try {
    // Validate email addresses
    const to = Array.isArray(options.to) ? options.to : [options.to];
    for (const email of to) {
      if (!isValidEmail(email)) {
        // Do NOT interpolate the address — it would leak recipient PII into logs.
        throw new Error("Invalid email address format");
      }
    }

    // Validate content
    if (!options.html && !options.text) {
      throw new Error("Email must have either html or text content");
    }

    // Default from address (can be overridden per organization in Phase 2)
    const from =
      options.from || "Spears Services <notifications@spears-services.com>";

    // Send email
    const sendOptions: {
      from: string;
      to: string | string[];
      subject: string;
      html?: string;
      text?: string;
      replyTo?: string | string[];
    } = {
      from,
      to,
      subject: options.subject,
    };
    if (options.html) sendOptions.html = options.html;
    if (options.text) sendOptions.text = options.text;
    if (options.replyTo) sendOptions.replyTo = options.replyTo;

    // Either html or text is guaranteed present by the validation above, so the
    // assembled options satisfy CreateEmailOptions' "at least one content field"
    // constraint (which the incrementally-built object can't express statically).
    const result = await getResend().emails.send(
      sendOptions as CreateEmailOptions,
    );

    // Check for errors
    if (result.error) {
      throw new Error(result.error.message);
    }

    // Extract the email ID from successful response
    // Resend returns { data: [{ id, ... }], error: null } on success
    const emailId = result.data?.id;
    if (!emailId) {
      throw new Error("No email ID returned from Resend");
    }

    return {
      id: emailId,
      to: Array.isArray(options.to) ? options.to.join(", ") : options.to,
      from,
      subject: options.subject,
    };
  } catch (error) {
    // Log only the message — the raw SDK error object can embed recipient PII.
    console.error(
      "Resend email error:",
      error instanceof Error ? error.message : "Unknown error",
    );
    throw new Error(
      `Failed to send email: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Validate email address format
 *
 * @param email - Email address to validate
 * @returns true if valid, false otherwise
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Normalize email address (lowercase and trim)
 *
 * @param email - Email address to normalize
 * @returns Normalized email address
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Get batch email status
 *
 * Resend doesn't have a single-message status endpoint.
 * Use webhooks or the batch endpoint for tracking.
 *
 * @param batchId - Batch ID from Resend
 * @returns Batch status information
 */
export async function getBatchStatus(batchId: string): Promise<{
  id: string;
  status: string;
  created_at: string;
}> {
  try {
    // Note: Resend SDK's batch API structure may vary
    // This is a placeholder for when batch status tracking is needed
    const batch = await (
      getResend().batch as unknown as {
        retrieve: (
          id: string,
        ) => Promise<{ id: string; status: string; created_at: string }>;
      }
    ).retrieve(batchId);
    return batch;
  } catch (error) {
    console.error("Failed to fetch Resend batch status:", error);
    throw new Error(
      `Failed to fetch batch status: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Webhook event types
 */
export interface ResendWebhookEvent {
  type: "email.delivery_delayed" | "email.delivered" | "email.complained" | "email.bounced";
  data: {
    created_at: string;
    email_id: string;
    from: string;
    to: string[];
    subject: string;
    [key: string]: unknown;
  };
}

/**
 * Parse a Resend webhook event
 *
 * @param event - Raw webhook event data
 * @returns Parsed event data
 */
export function parseWebhookEvent(event: Record<string, unknown>): ResendWebhookEvent {
  return {
    type: event.type as ResendWebhookEvent["type"],
    data: event.data as ResendWebhookEvent["data"],
  };
}

/**
 * Validate Resend webhook signature
 *
 * @param signature - The resend-signature header value
 * @param body - The raw body of the request
 * @returns true if valid, false otherwise
 */
export function validateWebhookSignature(
  signature: string,
  body: string,
): boolean {
  try {
    // Sign with a DEDICATED webhook secret, never the API key — leaking the API
    // key's HMAC would expose the send credential, and rotating the API key
    // would silently break webhook verification. Fail closed if unset.
    const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
    if (!secret) {
      console.error("RESEND_WEBHOOK_SECRET not configured; rejecting webhook");
      return false;
    }

    // Format: <timestamp>.<signature>
    const [timestamp, signatureHash] = signature.split(".");
    if (!timestamp || !signatureHash) {
      return false;
    }

    // Check timestamp is within 5 minutes (replay protection)
    const now = Math.floor(Date.now() / 1000);
    const eventTime = parseInt(timestamp, 10);
    if (Number.isNaN(eventTime) || Math.abs(now - eventTime) > 300) {
      return false;
    }

    const hmac = createHmac("sha256", secret);
    hmac.update(`${timestamp}.${body}`);
    const computedSignature = hmac.digest("hex");

    // Timing-safe comparison — guard equal length first (timingSafeEqual throws
    // on length mismatch).
    const provided = Buffer.from(signatureHash);
    const expected = Buffer.from(computedSignature);
    if (provided.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(provided, expected);
  } catch (error) {
    console.error("Webhook signature validation error:", error);
    return false;
  }
}
