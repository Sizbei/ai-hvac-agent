# Privacy Policy — AI Data Handling

This document describes how the AI HVAC Customer Service Agent handles customer data when interacting with OpenAI's API, and what protections are in place at the application level.

## 1. Overview

This application uses OpenAI's GPT-4o API for two purposes:

1. **Customer service chat** — Answering customer questions about HVAC issues, scheduling, and service availability.
2. **Structured data extraction** — Extracting service request details (issue type, urgency, contact information) from natural-language conversations.

## 2. Data Sent to OpenAI

The following data is transmitted to OpenAI's API during a chat session:

- **Chat messages** — User questions and responses about HVAC issues.
- **Conversation history** — Prior messages within the current session, provided for context continuity.
- **System prompts** — Instructions that guide the AI's behavior and extraction logic.

**What is NOT sent in system prompts:**
No personally identifiable information (PII) is included in system prompts. Customer-provided PII (name, phone number, email address, street address) appears only in user messages and in the structured extraction results returned by the model.

## 3. OpenAI API Data Usage Policy

OpenAI's API operates under different data policies than the ChatGPT consumer product:

- **No training on API data** — As of the March 2023 policy update, OpenAI does **not** use data submitted through the API to train or improve its models.
- **Abuse monitoring retention** — API data may be retained by OpenAI for up to 30 days solely for abuse and misuse monitoring, after which it is deleted.
- **Zero-retention option** — Some API plans offer a zero-retention policy where no data is stored at all. Check your plan's eligibility.

**References:**
- [OpenAI Enterprise Privacy](https://openai.com/enterprise-privacy/)
- [OpenAI API Data Usage Policies](https://openai.com/policies/api-data-usage-policies/)

## 4. Data Processing Agreement (DPA)

OpenAI offers a Data Processing Agreement for API customers:

- Organizations processing personal data through the OpenAI API **should execute OpenAI's DPA** before going live in production.
- The DPA covers data processing obligations, security measures, sub-processor management, and breach notification procedures.
- The DPA is available at: [https://openai.com/policies/data-processing-agreement/](https://openai.com/policies/data-processing-agreement/)

**Action required:** Execute the DPA before deploying this application with real customer data.

## 5. Training Opt-Out

- API usage is **already opted out of model training by default**. No additional configuration or API flags are needed.
- This is distinct from the ChatGPT consumer product, which has different default settings and requires users to manually opt out via account settings.
- No action is required on your part to prevent training on your API data.

## 6. Application-Level Data Protection

Beyond OpenAI's policies, this application implements the following data protections:

| Protection | Details |
|------------|---------|
| **Encryption at rest** | PII fields (name, email, phone, address) are encrypted using AES-256-GCM with column-level encryption before storage. |
| **Log redaction** | PII fields are redacted in application logs via Pino's redaction configuration. Sensitive values never appear in log output. |
| **Session expiry** | Chat sessions expire after 24 hours of inactivity. Expired sessions are no longer accessible to users. |
| **Data retention** | All session data and associated PII are purged after a 90-day retention period via an automated daily cleanup job. |
| **Multi-tenant isolation** | All data queries are scoped by `organization_id`, preventing cross-tenant data access. |
| **Encryption key isolation** | Each environment (development, staging, production) must use a unique `ENCRYPTION_KEY`. |

## 7. Recommendations for Production

Before deploying to production with real customer data:

- [ ] **Execute OpenAI's DPA** — Required before processing personal data through the API.
- [ ] **Review OpenAI's data retention policies periodically** — Policies evolve; confirm current terms at least annually.
- [ ] **Consider zero-retention** — If your OpenAI plan supports it, enable zero-retention for maximum data minimization.
- [ ] **Generate a unique ENCRYPTION_KEY** — Use `openssl rand -hex 32` to generate a 32-byte key. Never reuse keys across environments.
- [ ] **Change default credentials** — The seed data includes a demo admin account. Change the password immediately after first login.
- [ ] **Audit access logs** — Monitor admin dashboard access and API usage for unauthorized activity.
