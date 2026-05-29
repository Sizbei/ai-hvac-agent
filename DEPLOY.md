# Deployment Runbook

Step-by-step instructions for deploying the AI HVAC Customer Service Agent to production using Vercel and Neon PostgreSQL.

## 1. Prerequisites

- **Vercel account** — [https://vercel.com](https://vercel.com)
- **Neon account** — [https://neon.tech](https://neon.tech)
- **LLM API key** — an OpenAI-compatible endpoint. This project uses **Qwen via
  Alibaba DashScope** ([https://dashscope.console.aliyun.com](https://dashscope.console.aliyun.com));
  any OpenAI-compatible base URL + key works.
- **GitHub repository** connected to Vercel for automatic deployments
  (already pushed: `Sizbei/ai-hvac-agent`)
- **Node.js 20+** installed locally (for running migrations and seed scripts)

> **Fast path for a portfolio demo:** point the deployment at the **same Neon
> database you already use locally**. It is already seeded
> (`npm run db:seed:demo`), so the live admin dashboard shows real conversations,
> service requests, and insights the moment it goes up — no extra steps. If you
> do this, reuse the **same `ENCRYPTION_KEY`** so the encrypted PII decrypts.

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

- **Demo organization** — "Demo HVAC Company"
- **Admin user** — `admin@demo-hvac.com` with password `admin123`
- **Three technicians** — For service request assignment

> **IMPORTANT:** Change the admin password immediately after first login in production. The default credentials are for initial setup only.

### Optional: seed demo conversations (recommended for a live demo)

To make the admin dashboard look alive (9 realistic conversations, service
requests with assigned technicians, AI Insights metrics, and CRM customers):

```bash
DATABASE_URL="your-neon-connection-string" \
ENCRYPTION_KEY="your-encryption-key" \
npm run db:seed:demo
```

This seeder is idempotent — it clears its own prior demo rows before
reinserting, so it is safe to re-run. It must use the **same `ENCRYPTION_KEY`**
that the deployment uses, or the encrypted customer details won't decrypt in the
dashboard.

## 5. Environment Variables

Set all environment variables in the Vercel Dashboard under **Settings > Environment Variables**.

| Variable | Description | How to generate / source |
|----------|-------------|-----------------|
| `DATABASE_URL` | Neon PostgreSQL pooled connection string | Copy from Neon dashboard (reuse your seeded DB for the demo) |
| `AI_BASE_URL` | OpenAI-compatible LLM endpoint | DashScope: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` — copy from `.env.local` |
| `AI_API_KEY` | LLM API key | DashScope key — copy from `.env.local` (works from Vercel's servers) |
| `AI_MODEL` | Chat model id | e.g. `qwen-plus` — copy from `.env.local` |
| `AI_EXTRACTION_MODEL` | *(optional)* cheaper model for JSON extraction | e.g. `qwen-turbo`; defaults to `AI_MODEL` if unset |
| `ROUTER_ENABLED` | *(optional)* deterministic router toggle | defaults to on; set `false` only to force the LLM path |
| `ENCRYPTION_KEY` | 64-hex-char key for AES-256-GCM PII encryption | `openssl rand -hex 32` — **must match the key used to seed** |
| `AUTH_SECRET` | Secret for admin JWT token signing (min 32 chars) | `openssl rand -hex 32` |
| `CRON_SECRET` | Secret for cron endpoint authentication | `openssl rand -hex 32` |
| `NODE_ENV` | Runtime environment | `production` (Vercel sets this automatically) |

> The exact values for `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` are already in
> your local `.env.local` — copy them across verbatim. The app reads these in
> `src/lib/ai/provider.ts`; there is **no** `OPENAI_API_KEY` in this codebase.

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

- [ ] Visit `https://your-app.vercel.app` — the landing page loads without errors
- [ ] Click "Start a conversation" — a new chat session starts at `/chat`
- [ ] Send "hi" — the deterministic greeting returns instantly (0 tokens)
- [ ] Send "I smell gas" in a fresh chat — it escalates and locks the session
- [ ] Describe a real issue + give an address/contact — a service request is created with an `HVAC-…` confirmation number

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
- [ ] Execute a Data Processing Agreement with your LLM provider (DashScope/Alibaba Cloud, or whichever OpenAI-compatible provider you use) — see [PRIVACY.md](./PRIVACY.md)
- [ ] Verify cron job is active in Vercel dashboard
- [ ] Review [PRIVACY.md](./PRIVACY.md) for LLM-provider data handling obligations
- [ ] Enable Vercel's DDoS protection and rate limiting if available on your plan

## 9. Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| `AUTH_SECRET environment variable must be set` | Missing or too-short `AUTH_SECRET` | Set `AUTH_SECRET` in Vercel env vars (min 32 chars) |
| `ENCRYPTION_KEY must be a 64-character hex string` | Missing or malformed `ENCRYPTION_KEY` | Generate with `openssl rand -hex 32` (produces 64 hex chars) |
| Database connection timeout | Wrong connection string or region mismatch | Use pooled connection string; check Neon region matches Vercel region |
| Cron job not running | `CRON_SECRET` not set | Set `CRON_SECRET` in Vercel env vars |
| Chat AI not responding | Missing/incorrect `AI_API_KEY`, `AI_BASE_URL`, or `AI_MODEL` | Copy all three from `.env.local`; confirm the DashScope key is active. Note: the deterministic router still answers greetings/FAQs/emergencies even if the LLM is down |
| Seeded customer names show as garbled/blank | `ENCRYPTION_KEY` differs from the seed-time key | Redeploy with the same `ENCRYPTION_KEY`, or re-run `db:seed:demo` with the deployment's key |
| Build fails on Vercel | Node.js version mismatch | Ensure Vercel uses Node.js 20+ (Settings > General > Node.js Version) |
