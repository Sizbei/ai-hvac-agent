# Deployment Guide - AI HVAC Agent

Deployment documentation for the AI HVAC Agent platform.

## Table of Contents

1. [Environment Variables](#environment-variables)
2. [Database Setup](#database-setup)
3. [Storage Setup](#storage-setup)
4. [Vercel Deployment](#vercel-deployment)
5. [Self-Hosted Deployment](#self-hosted-deployment)
6. [Post-Deployment](#post-deployment)
7. [Monitoring](#monitoring)

---

## Environment Variables

### Required

```bash
# Database
DATABASE_URL=postgresql://user:password@host/database
# Or for Neon Serverless:
DATABASE_URL=postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/neondb

# AI Provider
OPENAI_API_KEY=sk-proj-xxxxx
OPENAI_BASE_URL=https://api.openai.com/v1  # Optional, defaults to OpenAI
AI_MODEL=gpt-4o-mini
AI_FALLBACK_MODELS=gpt-4o-mini,gpt-4-turbo

# Auth (JWT)
JWT_SECRET=your-secret-key-min-32-chars

# Storage (Cloudflare R2)
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
R2_BUCKET_NAME=hvac-uploads
R2_ENDPOINT=https://xxx.r2.cloudflarestorage.com  # Optional
R2_PUBLIC_URL=https://pub-xxx.r2.dev
```

### Optional

```bash
# Multi-Model Configuration
AI_EXTRACTION_MODEL=gpt-4o-mini
AI_EXTRACTION_FALLBACKS=gpt-4o-mini,llama3
AI_REASONING_MODEL=o1-preview
AI_REASONING_FALLBACKS=o1-preview,gpt-4o

# Ollama (Local Models)
AI_BASE_URL=http://localhost:11434/v1
AI_API_KEY=ollama

# Google OAuth (Admin Auth)
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxx
GOOGLE_REDIRECT_URL=https://your-domain.com/api/auth/callback

# Business Branding
BUSINESS_NAME=Spears Services
BUSINESS_PHONE=+15551234567
BUSINESS_SERVICE_AREA=Johnson City, TN and 50km surrounding
BUSINESS_HOURS=Mon-Fri 7AM-5PM

# Feature Flags
ENABLE_ELEVENLABS_VOICE=false
ELEVENLABS_API_KEY=xxx
ELEVENLABS_VOICE_ID=xxx

# Observability
VERCEL_OTEL_EXPORTER_URL=https://otlp.vercel-management.com
OTEL_SERVICE_NAME=ai-hvac-agent
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

### Cloudflare R2 (Recommended)

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

### Alternative: Vercel Blob

```typescript
// Update src/app/api/upload/route.ts
import { put } from '@vercel/blob';

export async function POST(request: Request) {
  const file = await request.formData();
  const blob = await put(filename, file, { access: 'public' });
  return Response.json({ url: blob.url });
}
```

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
vercel env add DATABASE_URL
vercel env add OPENAI_API_KEY
vercel env add R2_ACCESS_KEY_ID
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

```bash
# Important: Vercel build doesn't run migrations
# Run manually after first deploy:
DATABASE_URL=$(vercel env get DATABASE_URL production) npm run db:migrate
```

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
  -e OPENAI_API_KEY="..." \
  ai-hvac-agent
```

### Node.js Direct

```bash
# Build
npm run build

# Start
NODE_ENV=production \
DATABASE_URL="..." \
OPENAI_API_KEY="..." \
npm start
```

### PM2 Process Manager

```bash
# Install PM2
npm i -g pm2

# Start
pm2 start npm --name "ai-hvac-agent" -- start

# Monitor
pm2 monit

# Logs
pm2 logs ai-hvac-agent
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

### 5. Verify Health

```bash
curl https://your-domain.com/api/health
```

---

## Monitoring

### OpenTelemetry (Built-in)

The app includes OpenTelemetry instrumentation:

```typescript
// src/instrumentation.ts
export function register() {
  if (process.env.VERCEL) {
    // Vercel OTeL integration
    const { VercelOpenTelemetry } = require('@vercel/otel');
    VercelOpenTelemetry();
  }
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

---

## Scaling Considerations

### Database

- **Neon Serverless:** Auto-scales, handles burst traffic
- **Self-hosted:** Use connection pooling (PgBouncer)

### Rate Limiting

Current implementation uses in-memory storage. For production:

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
- [ ] Security headers configured
- [ ] Rate limiting enabled
- [ ] Database connection string uses SSL
- [ ] CSRF protection enabled
- [ ] Input validation on all endpoints
- [ ] File upload magic byte validation
- [ ] JWT secrets are 32+ characters
- [ ] CORS configured correctly
- [ ] API keys rotated regularly
- [ ] Dependency vulnerabilities addressed

---

## Troubleshooting

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

### AI Provider Errors

```bash
# Test OpenAI connection
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

### Build Failures

```bash
# Clear cache and rebuild
rm -rf .next node_modules
npm install
npm run build
```

---

## Cost Estimation

### Vercel (Hobby -> Pro)

| Feature | Hobby | Pro |
|---------|-------|-----|
| Price | Free | $20/mo |
| Bandwidth | 100GB | 1TB |
| Build Minutes | 6000 | 10000 |
| Serverless Function Execution | 100h | 1000h |

### Neon Serverless

- **Free Tier:** 3.x hours compute, 500MB storage
- **Pro:** $19/mo for 193 hours compute

### Cloudflare R2

- **Free Tier:** 10GB storage, 10M read operations
- **Paid:** $0.015/GB/month storage

### OpenAI API

- **GPT-4o-mini:** $0.150/1M input tokens, $0.600/1M output tokens
- **GPT-4o:** $2.50/1M input tokens, $10.00/1M output tokens

Estimated cost per 1,000 chats: $2-5 (depending on length)

---

## References

- [Vercel Deployment Docs](https://vercel.com/docs)
- [Neon Serverless](https://neon.tech/docs)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [OpenAI API](https://platform.openai.com/docs)
- [Next.js Deployment](https://nextjs.org/docs/deployment)
