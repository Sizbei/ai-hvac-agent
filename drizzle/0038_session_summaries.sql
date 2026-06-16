-- Stage 3 (AI summaries/outcomes) + Stage 4 (human takeover mode).

CREATE TYPE "session_outcome" AS ENUM ('booked', 'escalated', 'info_provided', 'abandoned', 'unresolved');
CREATE TYPE "session_mode" AS ENUM ('ai', 'human');

ALTER TABLE "customer_sessions" ADD COLUMN "summary" text;
ALTER TABLE "customer_sessions" ADD COLUMN "outcome" "session_outcome";
ALTER TABLE "customer_sessions" ADD COLUMN "next_steps" jsonb;
ALTER TABLE "customer_sessions" ADD COLUMN "mode" "session_mode" NOT NULL DEFAULT 'ai';
