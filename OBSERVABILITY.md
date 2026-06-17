# Observability & Error Tracking

Error aggregation is provided by **Sentry** (`@sentry/nextjs`), wired
**degrade-safe**: with no DSN configured the app builds and runs exactly as
before — every Sentry call is a no-op.

## How it's wired

| Concern | File | Guard |
| --- | --- | --- |
| Shared config + PII scrubbing | `src/lib/observability/sentry.ts` | — |
| Server + edge init | `src/instrumentation.ts` (`register`) | `SENTRY_DSN` |
| Server error hook | `src/instrumentation.ts` (`onRequestError` → `Sentry.captureRequestError`) | inert without DSN |
| Browser init + router tracing | `src/instrumentation-client.ts` | `NEXT_PUBLIC_SENTRY_DSN` |
| Root error boundary | `src/app/global-error.tsx` (`Sentry.captureException`) | inert without DSN |
| Build plugin / source-map upload | `next.config.ts` (`withSentryConfig`) | only when `SENTRY_DSN` set |
| Cron failures | `reconcile-payments`, `dunning` routes (`Sentry.captureException` in the top-level catch) | inert without DSN |

The existing `register()` (env validation + `@vercel/otel`) and `src/proxy.ts`
(the fork's native middleware) are untouched in behavior.

### Degrade-safe behavior (no DSN set)

- `Sentry.init()` is never called → all `Sentry.*` calls are inert.
- `next.config.ts` exports the plain config (no build plugin, no source-map step).
- The pipeline, build, and runtime are identical to before Sentry was added.

### PII scrubbing

`sendDefaultPii: false`, and a `beforeSend` hook recursively redacts keys that
look like PII (phone / email / name / address / token / password / cookie /
authorization — mirrors `src/lib/logger.ts`'s key-list) from request
headers/cookies/data, `extra`, and `contexts`, and drops `user` entirely.

### Environment & release tagging

- `environment` = `VERCEL_ENV` → `NODE_ENV` → `development`.
- `release` = `VERCEL_GIT_COMMIT_SHA` (server) / `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA` (client).

## Environment variables

See `.env.example` (Sentry block). `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN`
enable capture; `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` enable
build-time source-map upload (optional — runtime capture works without them).

## Alerts to configure (in the Sentry dashboard)

Alerting is configured in Sentry, not in code. Set up these alert rules once a
project exists:

1. **Error-rate spike** — Issue/metric alert when event volume for the project
   rises sharply over baseline (e.g. > N events / 5 min, or % increase
   week-over-week). Notify the on-call channel.
2. **Failed cron** — Alert on events tagged `cron:reconcile-payments` or
   `cron:dunning` (these are emitted by the cron top-level catch). Any
   occurrence is actionable: a failed reconcile means money state may be
   stranded; a failed dunning sweep means overdue reminders didn't enqueue.
3. **Webhook failures** — Alert on exceptions originating from the inbound
   webhook routes (Fieldpulse `webhook` / `invoice-webhook`, Resend, financing,
   payment webhooks). A spike means upstream events are being dropped.
4. **Failed payment reconcile** — In addition to (2), alert when the reconcile
   summary reports `failed > 0` (these are logged; you can also add a
   `Sentry.captureMessage` if you want them as first-class Sentry events). A
   stuck `pending` payment means money moved at the provider with no local
   success.

Consider routing (1)–(4) to a dedicated incident channel and the rest to a
lower-priority feed.

## Conversation-quality eval

Bot quality is measured by a separate, offline-first eval harness — see
**[EVAL.md](./EVAL.md)**. `npm run eval` gates CI on safety properties (no price
leak, no false booking, emergencies escalate, injections hard-block);
`npm run eval:ab` compares registry models (Qwen vs GLM) when keys are present.
