# Deployment Runbook

Step-by-step instructions for deploying the AI HVAC Customer Service Agent to production using Vercel and Neon PostgreSQL.

## 1. Prerequisites

- **Vercel account** — [https://vercel.com](https://vercel.com)
- **Neon account** — [https://neon.tech](https://neon.tech)
- **OpenAI API key** — [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **GitHub repository** connected to Vercel for automatic deployments
- **Node.js 20+** installed locally (for running migrations and seed scripts)

## 2. Neon PostgreSQL Setup

1. Create a new Neon project at [https://console.neon.tech](https://console.neon.tech).
2. Select a region closest to your users (e.g., `us-east-1` for US East Coast).
3. Create a database named `hvac_prod` (or use the default `neondb`).
4. Copy the **pooled connection string** from the Neon dashboard. Pooled connections are recommended for serverless environments like Vercel.

The connection string format is:

```
postgresql://user:password@ep-xxx.region.neon.tech/hvac_prod?sslmode=require
```

## 3. Run Database Migrations

Run all migrations in `drizzle/` against the production database:

```bash
DATABASE_URL="your-neon-connection-string" npm run db:migrate
```

This creates all tables, indexes, and constraints defined in the schema. The migration script is located at `src/lib/db/migrate.ts`.

## 4. Seed Production Data

Seed the database with the demo organization, admin user, and technicians:

```bash
DATABASE_URL="your-neon-connection-string" npm run db:seed
```

This creates:

- **Demo organization** — "Demo HVAC Co."
- **Admin user** — `admin@demo-hvac.com` with password `admin123`
- **Three technicians** — For service request assignment

> **IMPORTANT:** Change the admin password immediately after first login in production. The default credentials are for initial setup only.

## 5. Environment Variables

Set all environment variables in the Vercel Dashboard under **Settings > Environment Variables**.

| Variable | Description | How to generate |
|----------|-------------|-----------------|
| `DATABASE_URL` | Neon PostgreSQL pooled connection string | Copy from Neon dashboard |
| `OPENAI_API_KEY` | OpenAI API key for GPT-4o | Copy from [OpenAI platform](https://platform.openai.com/api-keys) |
| `ENCRYPTION_KEY` | 32-byte hex key for AES-256-GCM PII encryption | `openssl rand -hex 32` |
| `AUTH_SECRET` | Secret for admin JWT token signing (min 32 chars) | `openssl rand -hex 32` |
| `CRON_SECRET` | Secret for cron endpoint authentication | `openssl rand -hex 32` |
| `NODE_ENV` | Runtime environment | `production` |
| `LOG_LEVEL` | Pino log level | `info` |

**Security notes:**

- Generate unique values for `ENCRYPTION_KEY`, `AUTH_SECRET`, and `CRON_SECRET` for each environment. Never reuse secrets across dev/staging/production.
- Never commit `.env` files to version control. The `.env.example` file documents required variables without secret values.
- Store backup copies of `ENCRYPTION_KEY` securely — if lost, encrypted PII data cannot be decrypted.

## 6. Deploy to Vercel

### Option A: GitHub Integration (Recommended)

1. Connect your GitHub repository in the [Vercel dashboard](https://vercel.com/new).
2. Vercel auto-detects Next.js and configures the build command (`next build`) and output directory.
3. Push to the `main` branch to trigger automatic deployments.

### Option B: Vercel CLI

```bash
npx vercel --prod
```

### Cron Job

The `vercel.json` file configures a daily cron job at 3:00 AM UTC that cleans up expired sessions and enforces the 90-day data retention policy. Vercel automatically sends the `Authorization: Bearer <CRON_SECRET>` header to the cron endpoint.

After deployment, verify the cron job appears in the Vercel dashboard under **Settings > Cron Jobs**.

## 7. Post-Deploy Verification

Run through this checklist after each production deployment:

### Public Pages

- [ ] Visit `https://your-app.vercel.app` — landing page loads without errors
- [ ] Click "Get Help Now" — a new chat session starts
- [ ] Send a message describing an HVAC issue — AI responds with streaming text
- [ ] Complete the conversation — service request is created with a confirmation

### Admin Dashboard

- [ ] Visit `https://your-app.vercel.app/admin/login` — login page loads
- [ ] Log in with `admin@demo-hvac.com` / `admin123` — dashboard loads
- [ ] Dashboard displays stats cards (total requests, pending, in-progress, completed)
- [ ] Request queue shows any submitted service requests
- [ ] Assign a technician to a request — status updates correctly

### Infrastructure

- [ ] Cron job visible in Vercel dashboard under Settings > Cron Jobs
- [ ] Database accessible in Neon dashboard with tables populated
- [ ] Application logs visible in Vercel dashboard (Functions tab)

## 8. Security Checklist

Complete before handling real customer data:

- [ ] Change default admin password (`admin123`)
- [ ] Verify `ENCRYPTION_KEY` is unique per environment (not shared with dev/staging)
- [ ] Verify all environment variables are set in Vercel (missing vars cause runtime errors)
- [ ] Execute OpenAI Data Processing Agreement (see [PRIVACY.md](./PRIVACY.md))
- [ ] Verify cron job is active in Vercel dashboard
- [ ] Review [PRIVACY.md](./PRIVACY.md) for OpenAI data handling obligations
- [ ] Enable Vercel's DDoS protection and rate limiting if available on your plan

## 9. Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| `AUTH_SECRET environment variable must be set` | Missing or too-short `AUTH_SECRET` | Set `AUTH_SECRET` in Vercel env vars (min 32 chars) |
| `ENCRYPTION_KEY must be a 64-character hex string` | Missing or malformed `ENCRYPTION_KEY` | Generate with `openssl rand -hex 32` (produces 64 hex chars) |
| Database connection timeout | Wrong connection string or region mismatch | Use pooled connection string; check Neon region matches Vercel region |
| Cron job not running | `CRON_SECRET` not set | Set `CRON_SECRET` in Vercel env vars |
| Chat AI not responding | Missing `OPENAI_API_KEY` | Set API key in Vercel env vars; verify key has API access (not just ChatGPT) |
| Build fails on Vercel | Node.js version mismatch | Ensure Vercel uses Node.js 20+ (Settings > General > Node.js Version) |
