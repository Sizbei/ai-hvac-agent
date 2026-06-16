/**
 * Runtime environment variable validation.
 *
 * This module validates that all required environment variables are present
 * at startup time. It should be called early in the application lifecycle
 * (e.g., in instrumentation.ts or a top-level layout) to fail fast if
 * configuration is missing.
 *
 * For Vercel serverless deployments, these checks happen on each cold start,
 * so missing env vars will be caught immediately rather than causing 500s
 * in production traffic.
 */

interface EnvVarSpec {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
}

/**
 * Environment variables required for the application to function.
 */
const REQUIRED_ENV_VARS: readonly EnvVarSpec[] = [
  // Database
  {
    name: 'DATABASE_URL',
    required: true,
    description: 'Postgres connection string (Neon or self-hosted)',
  },
  // R2/S3 Storage
  {
    name: 'R2_PUBLIC_URL',
    required: true,
    description: 'Public URL for R2 bucket (used to construct attachment URLs)',
  },
  {
    name: 'R2_ACCOUNT_ID',
    required: false,
    description: 'Cloudflare R2 account ID',
  },
  {
    name: 'R2_ACCESS_KEY_ID',
    required: false,
    description: 'R2 access key ID',
  },
  {
    name: 'R2_SECRET_ACCESS_KEY',
    required: false,
    description: 'R2 secret access key',
  },
  {
    name: 'R2_BUCKET_NAME',
    required: false,
    description: 'R2 bucket name',
  },
  {
    name: 'R2_ENDPOINT',
    required: false,
    description: 'R2 endpoint (optional, defaults to account-based URL)',
  },
  // AI Provider — AI_API_KEY is the real var (provider.ts), and it has an
  // "ollama" fallback, so it's optional rather than required. (The old
  // ANTHROPIC_API_KEY entry was a phantom — read nowhere — and made every clean
  // deploy crash at cold start.)
  {
    name: 'AI_API_KEY',
    required: false,
    description: 'API key for the OpenAI-compatible model provider (falls back to ollama)',
  },
  // Google integrations — OAuth login AND Google Calendar are degrade-safe
  // OPTIONAL features (the code returns null / shows "not configured" when
  // unset, and admin password login still works), so these must NOT be required
  // or a deploy that does not use Google crashes at cold start.
  {
    name: 'GOOGLE_CLIENT_ID',
    required: false,
    description: 'Google OAuth client ID (optional — Google login / Calendar)',
  },
  {
    name: 'GOOGLE_CLIENT_SECRET',
    required: false,
    description: 'Google OAuth client secret (optional)',
  },
  {
    name: 'GOOGLE_REDIRECT_URI',
    required: false,
    description: 'Google Calendar OAuth redirect URI (optional)',
  },
  // Optional webhook signing secret for Resend delivery callbacks.
  {
    name: 'RESEND_WEBHOOK_SECRET',
    required: false,
    description: 'HMAC secret for verifying Resend webhook signatures',
  },
  // Core secrets — fail fast at cold start rather than 500 at first use.
  {
    name: 'AUTH_SECRET',
    required: true,
    description: 'JWT signing secret for admin session tokens',
  },
  {
    name: 'ENCRYPTION_KEY',
    required: true,
    description: 'AES-256-GCM key (hex) for PII encryption + blind indexes',
  },
  {
    name: 'CRON_SECRET',
    required: true,
    description: 'Bearer secret authenticating Vercel cron endpoints',
  },
  // App Configuration
  {
    name: 'NEXT_PUBLIC_APP_URL',
    required: true,
    description: 'Public URL of the application (for CSRF validation)',
  },
  // Optional Features
  {
    name: 'ELEVENLABS_API_KEY',
    required: false,
    description: 'ElevenLabs API key for phone voice (optional)',
  },
  {
    name: 'TWILIO_ACCOUNT_SID',
    required: false,
    description: 'Twilio account SID for phone (optional)',
  },
  {
    name: 'TWILIO_API_KEY',
    required: false,
    description: 'Twilio API key for phone (optional)',
  },
  {
    name: 'TWILIO_AUTH_TOKEN',
    required: false,
    description: 'Twilio auth token for phone (optional)',
  },
  {
    name: 'TWILIO_PHONE_NUMBER',
    required: false,
    description: 'Twilio phone number for incoming calls (optional)',
  },
  {
    name: 'TWILITY_WHISPERNamespace',
    required: false,
    description: 'Twilio webhook namespace for Whisper (optional)',
  },
  {
    name: 'ROUTER_ENABLED',
    required: false,
    description: 'Enable deterministic intent router (default: true)',
  },
] as const;

/**
 * Validates that all required environment variables are present.
 *
 * @throws Error if any required environment variable is missing
 */
export function validateEnvVars(): void {
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const spec of REQUIRED_ENV_VARS) {
    const value = process.env[spec.name];

    if (spec.required && !value) {
      missing.push(spec.name);
    } else if (!spec.required && !value) {
      warnings.push(`${spec.name} (optional) - ${spec.description}`);
    }
  }

  // Fail fast on missing required vars
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing.map((name) => `  - ${name}`).join('\n')}\n\n` +
        `Please set these in your deployment environment or .env.local for local development.`
    );
  }

  // Log warnings for missing optional vars (don't fail)
  if (warnings.length > 0 && process.env.NODE_ENV === 'development') {
    console.warn(
      `Optional environment variables not set:\n${warnings.join('\n')}\n\n` +
      `These features will be disabled.`
    );
  }
}

/**
 * Checks if the application is running in development mode.
 */
export function isDevelopment(): boolean {
  return process.env.NODE_ENV === 'development';
}

/**
 * Checks if the application is running in production mode.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}
