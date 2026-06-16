/**
 * Twilio SMS Adapter
 *
 * Handles sending SMS messages via Twilio.
 * Validates phone numbers and handles delivery status webhooks.
 */

import { Twilio } from "twilio";

let _twilio: Twilio | null = null;

/**
 * Lazily construct the Twilio client.
 *
 * Throwing at call time (rather than at module load) keeps importing this module
 * from crashing the production build / page-data collection when the Twilio env
 * vars are absent — only an actual SMS send fails, and only then, with a clear
 * error.
 */
function getTwilio(): Twilio {
  if (_twilio) return _twilio;
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!sid) {
    throw new Error("TWILIO_ACCOUNT_SID environment variable is not set");
  }
  if (!token) {
    throw new Error("TWILIO_AUTH_TOKEN environment variable is not set");
  }
  _twilio = new Twilio(sid, token);
  return _twilio;
}

function getTwilioFromNumber(): string {
  const num = process.env.TWILIO_PHONE_NUMBER?.trim();
  if (!num) {
    throw new Error("TWILIO_PHONE_NUMBER environment variable is not set");
  }
  return num;
}

/**
 * SMS message result
 */
export interface SmsResult {
  sid: string;
  status: string;
  to: string;
  direction: "outbound-api";
  price?: string;
  priceUnit?: string;
}

/**
 * Send an SMS message via Twilio
 *
 * @param options - SMS options
 * @returns Twilio message result with SID
 * @throws Error if sending fails
 */
export async function sendSms(options: {
  to: string;
  body: string;
  from?: string;
}): Promise<SmsResult> {
  try {
    // Validate phone number format (basic E.164 check)
    const to = normalizePhoneNumber(options.to);
    const from = options.from || getTwilioFromNumber();

    // Validate message length
    if (!options.body || options.body.length === 0) {
      throw new Error("SMS body cannot be empty");
    }

    if (options.body.length > 1600) {
      // Twilio allows up to 1600 characters for concatenated messages
      console.warn(
        `SMS message is ${options.body.length} characters (may be sent as multiple segments)`,
      );
    }

    // Send message
    const message = await getTwilio().messages.create({
      body: options.body,
      to,
      from,
    });

    return {
      sid: message.sid,
      status: message.status,
      to: message.to,
      direction: message.direction as "outbound-api",
      price: message.price ?? undefined,
      priceUnit: message.priceUnit ?? undefined,
    };
  } catch (error) {
    console.error("Twilio SMS error:", error);
    throw new Error(
      `Failed to send SMS: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Normalize phone number to E.164 format
 *
 * @param phone - Phone number in various formats
 * @returns E.164 formatted phone number
 * @throws Error if phone number is invalid
 */
export function normalizePhoneNumber(phone: string): string {
  // Remove all non-numeric characters
  const cleaned = phone.replace(/\D/g, "");

  // Validate length (US numbers should be 10 or 11 digits with country code)
  if (cleaned.length < 10 || cleaned.length > 15) {
    throw new Error(
      `Invalid phone number format: ${phone}. Must be 10-15 digits.`,
    );
  }

  // If no country code, assume US (+1)
  if (cleaned.length === 10) {
    return `+1${cleaned}`;
  }

  // If country code is present but missing +, add it
  if (cleaned.length === 11 && cleaned.startsWith("1")) {
    return `+${cleaned}`;
  }

  // Otherwise, assume it already has country code
  return `+${cleaned}`;
}

/**
 * Get message delivery status
 *
 * @param messageSid - Twilio message SID
 * @returns Message status information
 */
export async function getMessageStatus(messageSid: string): Promise<{
  sid: string;
  status: string;
  errorCode?: number;
  errorMessage?: string;
}> {
  try {
    const message = await getTwilio().messages(messageSid).fetch();

    return {
      sid: message.sid,
      status: message.status,
      errorCode: message.errorCode ?? undefined,
      errorMessage: message.errorMessage ?? undefined,
    };
  } catch (error) {
    console.error("Failed to fetch Twilio message status:", error);
    throw new Error(
      `Failed to fetch message status: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Webhook event types
 */
export interface TwilioWebhookEvent {
  MessageSid: string;
  MessageStatus: string;
  To: string;
  From: string;
  ErrorCode?: string;
  ErrorMessage?: string;
}

/**
 * Map an already-verified Twilio webhook form payload to a typed event.
 *
 * SIGNATURE VERIFICATION IS THE CALLER'S RESPONSIBILITY — use
 * parseAndVerifyTwilioRequest() (src/lib/voice/request.ts), which implements
 * Twilio's real signature algorithm over the sorted params and the forwarded
 * public URL. This function only shapes the data.
 */
export function parseWebhookEvent(
  event: Record<string, unknown>,
): TwilioWebhookEvent {
  return {
    MessageSid: event.MessageSid as string,
    MessageStatus: event.MessageStatus as string,
    To: event.To as string,
    From: event.From as string,
    ErrorCode: event.ErrorCode as string | undefined,
    ErrorMessage: event.ErrorMessage as string | undefined,
  };
}
