# AI HVAC Customer Service Agent

## Vision
AI-powered customer service platform for HVAC companies. Customers interact through a premium web chat interface where an AI agent extracts service needs, then dispatches requests to admin staff for technician assignment.

## Stack
- **Frontend**: Next.js 15 (App Router) + React 19 + TypeScript + Tailwind CSS + shadcn/ui + Framer Motion
- **Backend**: Next.js API Routes + Drizzle ORM + Neon PostgreSQL (with pgcrypto encryption)
- **AI**: Vercel AI SDK + GPT-4o (single-pass structured output with Zod)
- **Auth**: NextAuth v5 (admin) + opaque session tokens (customer)
- **Real-time**: SSE for streaming + live dashboard updates
- **Deploy**: Vercel + Neon PostgreSQL

## Key Decisions
- Single Next.js app (no monorepo, no separate backend)
- Single-pass GPT-4o extraction (no multi-stage pipeline)
- Manual dispatch only for MVP (no weighted scoring algorithm)
- Multi-tenancy from day 1 (organization_id on every table)
- PII encrypted at rest via pgcrypto
- SSE instead of Socket.IO (stateless, Vercel-native)

## Repository
https://github.com/Sizbei/ai-hvac-agent
