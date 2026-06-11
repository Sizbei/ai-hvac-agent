# Deployment Guide - AI HVAC Agent

Deployment documentation for the AI HVAC Agent platform.

## Table of Contents

1. [Environment Variables](#environment-variables)
2. [Database Setup](#database-setup)
3. [Storage Setup](#storage-setup)
4. [Vercel Deployment](#vercel-deployment)
5. [Self-Hosted Deployment](#self-hosted-deployment)
6. [Post-Deployment](#post-deployment)
7. [Security Considerations](#security-considerations)
8. [Monitoring](#monitoring)

---

## Environment Variables

### Required (Application will fail to start without these)

```bash
# Database (Neon Serverless or self-hosted Postgres)
DATABASE_URL=postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/neondb

# AI Provider (Anthropic Claude)
ANTHROPIC_API_KEY=sk-ant-xxxxx

# Admin Authentication (Google OAuth)
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxx
GOOGLE_REDIRECT_URI=https://your-domain.com/api/auth/callback

# Session Security
SESSION_SECRET=your-secret-key-min-32-chars-random

# Application URL (for CSRF validation)
NEXT_PUBLIC_APP_URL=https://your-domain.com
```

### Required for File Upload Feature

```bash
# Cloudflare R2 Storage
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-r2-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
R2_BUCKET_NAME=hvac-uploads
R2_PUBLIC_URL=https://pub-xxx.r2.dev  # Public URL for attachment links
R2_ENDPOINT=https://xxx.r2.cloudflarestorage.com  # Optional, auto-constructed from ACCOUNT_ID
```

### Optional (Phone Voice Feature)

```bash
# ElevenLabs TTS (phone voice)
ELEVENLABS_API_KEY=sk_xxx
ELEVENLABS_VOICE_ID=xxx  # Default: "Brian" (21m00Tcm4TlvDq8ikWAM)

# Twilio (phone calls)
TWILIO_ACCOUNT_SID=ACxxx
TWILIO_API_KEY=SKxxx
TWILIO_AUTH_TOKEN=xxx
TWILIO_PHONE_NUMBER=+15551234567
```

### Optional (Feature Flags & Routing)

```bash
# Deterministic Router (enabled by default)
ROUTER_ENABLED=true  # Set to "false" to disable and route everything through LLM
```

### Business Branding (Optional, set in admin UI instead)

```bash
# These can also be configured per-organization in the admin dashboard
BUSINESS_NAME=Spears Services
BUSINESS_PHONE=+15551234567
BUSINESS_BASE_LOCATION=Johnson City, TN
BUSINESS_SERVICE_AREA_RADIUS=50  # km
```

---

## Database Setup

### Neon Serverless (Recommended)

1. **Create a Neon project:**
   ```bash
   # Via CLI
   npm install -g neonctl
   neonctl projects create ai-hvac-agent
   ```

2. **Get connection string:**
   ```bash
   neonctl connection-string --ai-hvac-agent
   ```

3. **Run migrations:**
   ```bash
   DATABASE_URL="postgresql://..." npm run db:migrate
   ```

4. **Seed admin user:**
   ```bash
   DATABASE_URL="..." npm run db:seed:super-admin
   ```

### Self-Hosted Postgres

1. **Create database:**
   ```sql
   CREATE DATABASE ai_hvac_agent;
   ```

2. **Run migrations:**
   ```bash
   DATABASE_URL="postgresql://localhost/ai_hvac_agent" npm run db:migrate
   ```

---

## Storage Setup

### Cloudflare R2 (Recommended for file uploads)

1. **Create R2 bucket:**
   ```bash
   # Via Cloudflare dashboard
   # R2 > Create Bucket > "hvac-uploads"
   ```

2. **Create API token:**
   ```
   # Cloudflare Dashboard > Manage Account > API Tokens
   # Create Token > Custom Token > R2 Read & Write
   ```

3. **Set environment variables:**
   ```bash
   R2_ACCOUNT_ID=xxx
   R2_ACCESS_KEY_ID=xxx
   R2_SECRET_ACCESS_KEY=xxx
   R2_BUCKET_NAME=hvac-uploads
   R2_PUBLIC_URL=https://pub-xxx.r2.dev
   ```

**IMPORTANT:** The `R2_PUBLIC_URL` must be set or attachment URLs will be `undefined`. The application validates this at startup.

---

## Vercel Deployment

### 1. Install Vercel CLI

```bash
npm i -g vercel
```

### 2. Link Project

```bash
cd ai-hvac-agent
vercel link
```

### 3. Set Environment Variables

```bash
# Via CLI
vercel env add DATABASE_URL production
vercel env add ANTHROPIC_API_KEY production
vercel env add GOOGLE_CLIENT_ID production
vercel env add GOOGLE_CLIENT_SECRET production
vercel env add SESSION_SECRET production
vercel env add NEXT_PUBLIC_APP_URL production
# ... etc

# Or via dashboard
# Vercel Project > Settings > Environment Variables
```

### 4. Deploy

```bash
# Production
vercel --prod

# Preview
vercel
```

### 5. Post-Deploy Migration

**IMPORTANT:** Vercel builds do NOT run migrations. You must run migrations manually after deploying:

```bash
# Get the production DATABASE_URL from Vercel
vercel env pull .env.production

# Run migrations
npm run db:migrate
```

See memory `migrations-not-run-on-deploy` for details.

---

## Self-Hosted Deployment

### Docker (Recommended)

```dockerfile
# Dockerfile
FROM node:20-alpine AS base

# Install dependencies
FROM base AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Build application
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 vercel

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

USER vercel

EXPOSE 3000

ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

CMD ["node", "server.js"]
```

```bash
# Build and run
docker build -t ai-hvac-agent .
docker run -p 3000:3000 \
  -e DATABASE_URL="..." \
  -e ANTHROPIC_API_KEY="..." \
  ai-hvac-agent
```

### Node.js Direct

```bash
# Build
npm run build

# Start
NODE_ENV=production \
DATABASE_URL="..." \
ANTHROPIC_API_KEY="..." \
npm start
```

---

## Post-Deployment

### 1. Seed Database

```bash
# Create super admin
npm run db:seed:super-admin

# Seed demo data (optional)
npm run db:seed:demo
```

### 2. Configure Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create OAuth 2.0 credentials
3. Add authorized redirect URI: `https://your-domain.com/api/auth/callback`
4. Copy `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

### 3. Test Chat Flow

```bash
# Test chat endpoint
curl -X POST https://your-domain.com/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello"}'
```

### 4. Test File Upload

```bash
# Test upload
curl -X POST https://your-domain.com/api/upload \
  -F "file=@test.jpg"
```

---

## Security Considerations

### Widget Host Header Validation

**CRITICAL:** If you self-host behind a reverse proxy, ensure the proxy validates the `Host` header. The widget loader derives `appOrigin` from `request.nextUrl.origin`, which relies on the `Host` header being trustworthy.

For Vercel deployments, this is handled automatically. For self-hosted deployments behind nginx, Caddy, or similar proxies, ensure:

```nginx
# nginx example
server {
    server_name your-domain.com;
    # Only accept this hostname
    if ($host != "your-domain.com") { return 444; }
}
```

### CSRF Protection

The application uses same-origin CSRF protection via `isSameOriginRequest()`. This requires:

1. `NEXT_PUBLIC_APP_URL` to be set correctly
2. Requests include a valid `Origin` header (browser requests do this automatically)
3. For API clients (mobile apps, etc.), send an appropriate `Origin` header

### Rate Limiting

Current implementation uses in-memory storage. For production Vercel serverless deployments:

- Rate limits reset on each serverless function cold start
- A determined attacker could bypass limits by sending requests from different edge workers
- Consider upgrading to Redis-backed rate limiting for production

See docs/DEPLOYMENT.md > Scaling Considerations for Redis implementation example.

### File Upload Security

The upload endpoint includes multiple security layers:

1. **Magic byte validation** - File content is verified against declared MIME type
2. **Size validation** - Server-side 5MB limit enforced (not just client-side)
3. **MIME type normalization** - Only `image/jpeg` and `image/png` allowed
4. **Filename sanitization** - Dangerous characters removed
5. **Secure storage keys** - UUID-based keys prevent path traversal

### Environment Variable Validation

The application validates all required environment variables at startup (via `src/instrumentation.ts`). Missing required variables will cause the application to fail fast with a clear error message.

---

## Monitoring

### OpenTelemetry (Built-in)

The app includes OpenTelemetry instrumentation via `src/instrumentation.ts`:

```typescript
export function register() {
  validateEnvVars();  // Fail fast on missing config
  registerOTel({
    serviceName: 'ai-hvac-agent',
  });
}
```

### Metrics to Monitor

1. **Request Rate:** `/api/chat` requests per minute
2. **Error Rate:** 4xx/5xx responses
3. **Latency:** P50, P95, P99 response times
4. **Token Usage:** Total tokens per organization
5. **Session Duration:** Average chat session length

### Logs

```typescript
// Pino logger
import { logger } from '@/lib/logger';

logger.info({ sessionId, messageCount }, 'Chat session completed');
logger.error({ error, sessionId }, 'Chat endpoint error');
```

### Alerts

Recommended alerting:

- Error rate > 5%
- P95 latency > 3s
- Token budget exhausted
- Database connection failures
- Missing required environment variables

---

## Scaling Considerations

### Database

- **Neon Serverless:** Auto-scales, handles burst traffic
- **Self-hosted:** Use connection pooling (PgBouncer)

### Rate Limiting

Current implementation uses in-memory storage. For production, upgrade to Redis:

```typescript
// Upgrade to Redis-backed rate limiting
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN,
});

async function slidingWindow(key: string, max: number, window: number) {
  const now = Date.now();
  const windowStart = now - window;

  // Add current request
  await redis.zadd(key, now, `req_${now}`);

  // Remove old requests
  await redis.zremrangebyscore(key, 0, windowStart);

  // Count requests in window
  const count = await redis.zcard(key);

  return count <= max;
}
```

### File Storage

- **R2:** No scaling needed (S3-compatible)
- **CDN:** Use Cloudflare CDN for file delivery

---

## Security Checklist

Before production deployment:

- [ ] All secrets in environment variables (not in code)
- [ ] HTTPS enforced (redirect HTTP to HTTPS)
- [ ] Security headers configured (X-Frame-Options, X-XSS-Protection, Permissions-Policy)
- [ ] Rate limiting enabled
- [ ] Database connection string uses SSL
- [ ] CSRF protection enabled (same-origin validation)
- [ ] Input validation on all endpoints
- [ ] File upload magic byte validation enabled
- [ ] Session secrets are 32+ characters
- [ ] CORS configured correctly
- [ ] API keys rotated regularly
- [ ] Dependency vulnerabilities addressed (`npm audit`)
- [ ] Host header validated (self-hosted deployments only)

---

## Troubleshooting

### Application fails to start on missing env vars

The application now validates required environment variables at startup. If you see:

```
Missing required environment variables:
  - DATABASE_URL
  - ANTHROPIC_API_KEY
  ...
```

Set the missing variables in your deployment environment or `.env.local` for local development.

### Database Connection Errors

```bash
# Test connection
psql $DATABASE_URL -c "SELECT 1"

# Check SSL
DATABASE_URL="postgresql://...?sslmode=require"
```

### File Upload Failures

```bash
# Test R2 credentials
aws s3 ls \
  --endpoint-url=$R2_ENDPOINT \
  --access-key-id=$R2_ACCESS_KEY_ID \
  --secret-access-key=$R2_SECRET_ACCESS_KEY \
  s3://$R2_BUCKET_NAME
```

### Attachment URLs are undefined

If attachment URLs show as `undefined`, check that `R2_PUBLIC_URL` is set. The application validates this at startup.

### Build Failures

```bash
# Clear cache and rebuild
rm -rf .next node_modules
npm install
npm run build
```

---

## References

- [Vercel Deployment Docs](https://vercel.com/docs)
- [Neon Serverless](https://neon.tech/docs)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [Anthropic API](https://docs.anthropic.com/)
- [Next.js Deployment](https://nextjs.org/docs/deployment)
