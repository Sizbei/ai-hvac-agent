# Stage C: Communication Automation - Technical Specification

> **For agentic workers:** This is a technical specification, not an implementation plan. Use this as the foundation for creating detailed implementation plans with the `superpowers:writing-plans` skill.

**Goal:** Design and specify the complete communication automation system that acts as a "Ghost CSR" — automating confirmations, rescheduling, follow-ups, and review requests while maintaining human oversight and escalation.

**Architecture:** Event-driven communication system with message templates, scheduling engine, multi-channel delivery (SMS/Email/Phone), and intelligent escalation triggers.

**Tech Stack:**
- **Core:** Next.js API Routes, Drizzle ORM, Neon Serverless Postgres
- **Communication:** Twilio (SMS/Voice), Resend/Postmark (Email)
- **Scheduling:** Vercel Cron Jobs, in-memory job queue (later Redis/BullMQ)
- **Templates:** Handlebars/React Template Engine
- **Compliance:** TCPA (SMS), CAN-SPAM (Email) compliance layer

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Feature Requirements](#feature-requirements)
3. [Technical Architecture](#technical-architecture)
4. [Database Schema](#database-schema)
5. [Message Template System](#message-template-system)
6. [Scheduling & Timing Engine](#scheduling--timing-engine)
7. [Multi-Channel Delivery](#multi-channel-delivery)
8. [Conversation Design](#conversation-design)
9. [Integration Points](#integration-points)
10. [Compliance & Quality](#compliance--quality)
11. [Escalation & Human Handoff](#escalation--human-handoff)
12. [API Endpoints](#api-endpoints)
13. [Implementation Phases](#implementation-phases)

---

## System Overview

### The Ghost CSR Concept

The communication automation system functions as an invisible Customer Service Representative that:

1. **Proactively reaches out** - Never waits for customers to initiate
2. **Maintains context** - Knows appointment history, service records, preferences
3. **Handles routine tasks autonomously** - Confirmations, rescheduling, reviews
4. **Escalates intelligently** - Brings humans in when judgment is needed
5. **Learns from feedback** - Optimize timing, messaging based on responses

### Customer Journey Touchpoints

```
Appointment Booked
    ↓
[Immediate] Confirmation sent
    ↓
[24 hours prior] Reminder with reschedule option
    ↓
[2 hours prior] "On my way" notification (when assigned)
    ↓
[After completion] Review request (24-48 hours later)
    ↓
[30 days post-service] Maintenance reminder (if applicable)
    ↓
[90 days inactive] Re-engagement campaign
```

---

## Feature Requirements

### C1. Automated Appointment Confirmations

**Trigger:** When a service request transitions to `scheduled` status with a valid `arrivalWindowStart` and `arrivalWindowEnd`.

**Behavior:**
- Send confirmation via customer's preferred channel (SMS/email from `contactPreference`)
- Include appointment details: date, time window, service address, technician (if assigned)
- Provide one-click reschedule link
- Include business phone for manual contact
- Support both English and Spanish (organization-level config)

**Edge Cases:**
- No `contactPreference` set → default to SMS, fallback email
- Missing email/phone → flag for manual follow-up
- Appointment within 2 hours → send immediate confirmation, skip 24h reminder

---

### C2. Intelligent Rescheduling System

**Trigger:** Customer clicks reschedule link OR replies "reschedule" to automated message.

**Behavior:**
- Identify next 3 available slots within 7 days
- Present as numbered list (SMS) or clickable buttons (email)
- Capture selection via reply or link click
- Update `serviceRequests` with new window
- Send updated confirmation
- If no available slots within 7 days → escalate to human

**Slot Availability Logic:**
```typescript
// Pseudo-code for slot finding
function findAvailableSlots(requestId: string): Slot[] {
  const request = getServiceRequest(requestId);
  const techId = request.assignedTo;
  const orgId = request.organizationId;
  
  // Get technician availability for next 7 days
  const availability = getTechnicianAvailability(orgId, techId);
  
  // Get existing bookings for this technician
  const bookings = getScheduledJobs(orgId, techId, {
    startDate: tomorrow,
    endDate: tomorrow + 7 days
  });
  
  // Find windows where:
  // 1. Technician is working (availability table)
  // 2. No conflicting booking exists
  // 3. Window matches customer's preferredWindow preference
  
  return findCompatibleWindows(availability, bookings, request.preferredWindow)
    .slice(0, 3); // Max 3 options
}
```

**Rescheduling State Machine:**
```
[Linked/Started] → [Options Presented] → [Selection Captured] → [Confirmed]
     ↓ (timeout)      ↓ (invalid)           ↓ (conflict)
[Escalate to Human] [Re-present Options]  [Offer Alternatives]
```

---

### C3. Proactive Follow-ups for Reviews

**Trigger:** Service request transitions to `completed` status.

**Behavior:**
- Wait 24-48 hours (configurable per organization)
- Send review request via customer's preferred channel
- Include direct links to Google, Facebook, Yelp (from organization config)
- Track which platform customer reviewed on (via link tracking)
- If no response after 7 days → send one follow-up reminder
- After 14 days with no response → mark as "no review" and stop

**Review Incentives (Optional):**
- Organizations can configure review incentives
- Must comply with platform terms of service
- Template system supports incentive messaging

---

### C4. Repeat Business Automation

**Trigger Types:**

**A. Maintenance Reminders**
- Based on `customer_equipment.installDate` + recommended service interval
- Trigger 30 days before recommended maintenance
- Include last service date and work performed
- Offer scheduling link

**B. Seasonal Campaigns**
- Pre-season: AC check before summer (March-April)
- Pre-season: Furnace check before winter (September-October)
- Filter customers by equipment type and last service date
- Batch send with throttle (10 messages/minute max)

**C. Win-Back Campaign**
- Customers with no service in 90+ days
- Personalized with last service date and technician
- Special offer support (organization-configured)

---

### C5. Human Escalation Logic

**Escalation Triggers:**

**Automatic Escalation (Create Human Task):**
1. Rescheduling request with no available slots
2. Customer responds with "complaint" or similar keywords
3. Customer replies "cancel" to appointment (requires human review)
4. Three consecutive failed message deliveries
5. Customer responds with "speak to human" or similar
6. Review request generates negative sentiment (future ML enhancement)

**Manual Escalation (Admin-Initiated):**
1. Admin clicks "Escalate" button in dashboard
2. System assigns to available admin/technician
3. Escalating user gets notification

**Escalation Data Package:**
```typescript
interface EscalationPackage {
  escalationId: string;
  triggerReason: EscalationReason;
  customerInfo: {
    name: string;
    phone: string;
    email: string;
    customerId: string;
  };
  context: {
    originalSessionId?: string;
    serviceRequestId?: string;
    communicationHistory: Message[];
    lastInteraction: Date;
  };
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignedTo?: string; // userId
  status: 'pending' | 'in_progress' | 'resolved';
}
```

---

### C6. Ghost CSR Experience Principles

**Personality Guidelines:**
- Professional but warm (match organization brand voice)
- Concise (SMS under 160 characters when possible)
- Clear action items (one primary call-to-action)
- Context-aware (reference history, equipment, preferences)

**Quality Standards:**
- Grammar/spell check all automated messages
- Verify personalization tokens populate correctly
- Test all link flows end-to-end
- No "robot" giveaways (avoid excessive formality, stilted language)

---

## Technical Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────────┐
│                      Communication Engine                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌────────────────┐    ┌─────────────────┐    ┌─────────────┐ │
│  │ Event Triggers │───▶│ Job Scheduler   │───▶│    Queue    │ │
│  │                │    │                 │    │             │ │
│  │ - DB Webhooks   │    │ - Vercel Cron   │    │ - In-Memory │ │
│  │ - API Routes    │    │ - After() Hooks │    │ - Later:    │ │
│  │ - State Changes │    │ - Delayed Jobs  │    │   Redis/Bull│ │
│  └────────────────┘    └─────────────────┘    └─────────────┘ │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────┐    ┌─────────────────┐    ┌─────────────┐ │
│  │ Template      │───▶│ Message         │───▶│   Channel   │ │
│  │ Engine        │    │ Builder         │    │   Adapters  │ │
│  │                │    │                 │    │             │ │
│  │ - Handlebars   │    │ - Personalize   │    │ - Twilio    │ │
│  │ - React        │    │ - Format        │    │ - Resend    │ │
│  │ - i18n         │    │ - Validate      │    │ - Internal  │ │
│  └────────────────┘    └─────────────────┘    └─────────────┘ │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────┐    ┌─────────────────┐    ┌─────────────┐ │
│  │ Compliance     │───▶│ Response        │───▶│  Reporting  │ │
│  │ Layer          │    │ Handler         │    │             │ │
│  │                │    │                 │    │ - Delivery  │ │
│  │ - TCPA Checks  │    │ - Parse Reply   │    │   Metrics   │ │
│  │ - CAN-SPAM     │    │ - Update State  │    │ - Open Rate │ │
│  │ - Opt-Out      │    │ - Trigger Next  │    │ - Link Click │ │
│  └────────────────┘    └─────────────────┘    └─────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
1. EVENT OCCURS
   - Service request scheduled
   - Job completed
   - Time-based trigger fires
   - Customer interacts
   ↓
2. JOB CREATED
   - CommunicationJob inserted
   - Scheduled for immediate or future execution
   - Contains template ID, recipient data, channel
   ↓
3. JOB EXECUTED
   - Template resolver loads template
   - Data merged with customer/request context
   - Channel adapter sends message
   - Delivery status recorded
   ↓
4. RESPONSE HANDLED
   - Inbound webhook processes reply
   - Conversation state updated
   - Next action triggered
   - Escalation if needed
   ↓
5. REPORTING
   - Metrics updated
   - Admin dashboard shows activity
   - Optimization data collected
```

---

## Database Schema

### New Tables

```typescript
// 1. communication_jobs - Message send queue and audit trail
export const communicationJobs = pgTable("communication_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  
  // Job scheduling
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  
  // Job configuration
  jobType: jobTypeEnum("job_type").notNull(), // 'confirmation', 'reminder', 'review_request', etc.
  channel: channelEnum("channel").notNull(), // 'sms', 'email', 'voice'
  priority: priorityEnum("priority").notNull().default("normal"),
  
  // Recipient (encrypted PII)
  recipientPhoneEncrypted: text("recipient_phone_encrypted"),
  recipientEmailEncrypted: text("recipient_email_encrypted"),
  recipientCustomerId: uuid("recipient_customer_id").references(() => customers.id),
  
  // Content
  templateId: text("template_id").notNull(),
  templateVersion: integer("template_version").notNull(),
  renderedSubject: text("rendered_subject"), // For email
  renderedBody: text("rendered_body").notNull(),
  
  // Context
  serviceRequestId: uuid("service_request_id").references(() => serviceRequests.id),
  sessionId: uuid("session_id").references(() => customerSessions.id),
  
  // Delivery tracking
  status: jobStatusEnum("status").notNull().default("pending"),
  deliveryAttempts: integer("delivery_attempts").notNull().default(0),
  lastError: text("last_error"),
  externalId: text("external_id"), // Twilio MessageSid, Email Message-ID
  
  // Response tracking
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  responseCategory: text("response_category"), // 'confirmed', 'rescheduled', 'declined', etc.
  
  // Metadata
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("comm_jobs_org_id_idx").on(table.organizationId),
  index("comm_jobs_scheduled_for_idx").on(table.scheduledFor),
  index("comm_jobs_status_idx").on(table.status),
  index("comm_jobs_service_request_idx").on(table.serviceRequestId),
  index("comm_jobs_customer_idx").on(table.recipientCustomerId),
]);

// Enums for communication_jobs
export const jobTypeEnum = pgEnum("communication_job_type", [
  "appointment_confirmation",
  "appointment_reminder_24h",
  "appointment_reminder_2h",
  "reschedule_options",
  "reschedule_confirmation",
  "review_request",
  "review_reminder",
  "maintenance_reminder",
  "seasonal_campaign",
  "win_back_campaign",
  "escalation_notification",
  "manual_message",
]);

export const channelEnum = pgEnum("communication_channel", [
  "sms",
  "email",
  "voice",
]);

export const priorityEnum = pgEnum("communication_priority", [
  "low",
  "normal",
  "high",
  "urgent",
]);

export const jobStatusEnum = pgEnum("communication_job_status", [
  "pending",
  "processing",
  "sent",
  "delivered",
  "failed",
  "cancelled",
  "responded",
]);

// 2. communication_templates - Reusable message templates
export const communicationTemplates = pgTable("communication_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  
  // Template identification
  key: text("key").notNull(), // e.g., 'appointment_confirmation_sms'
  name: text("name").notNull(), // Human-readable name
  description: text("description"),
  
  // Template content (Handlebars or React)
  subjectTemplate: text("subject_template"), // For email
  bodyTemplate: text("body_template").notNull(),
  
  // Versioning
  version: integer("version").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  
  // Configuration
  channel: channelEnum("channel").notNull(),
  jobType: jobTypeEnum("job_type").notNull(),
  
  // Template options
  variables: jsonb("variables").$type<TemplateVariable[]>().notNull().default(sql`'[]'::jsonb`),
  supportedLanguages: jsonb("supported_languages").$type<string[]>().notNull().default(sql`'["en"]'::jsonb`),
  
  // Approval workflow
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("comm_templates_org_id_idx").on(table.organizationId),
  index("comm_templates_key_idx").on(table.key),
  index("comm_templates_active_idx").on(table.isActive),
  uniqueIndex("comm_templates_org_key_version_unique").on(
    table.organizationId,
    table.key,
    table.version,
  ),
]);

// Template variable definition
interface TemplateVariable {
  name: string;
  type: 'text' | 'date' | 'number' | 'boolean' | 'enum';
  required: boolean;
  description: string;
  defaultValue?: unknown;
  enumValues?: string[]; // For type: 'enum'
}

// 3. conversation_states - Track ongoing automated conversations
export const conversationStates = pgTable("conversation_states", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  
  // Participant
  customerId: uuid("customer_id").references(() => customers.id),
  sessionId: uuid("session_id").references(() => customerSessions.id),
  
  // Conversation tracking
  conversationType: conversationTypeEnum("conversation_type").notNull(),
  currentStep: text("current_step").notNull(),
  
  // State data (serialized, not PII)
  stateData: jsonb("state_data").$type<Record<string, unknown>>().notNull(),
  
  // Timing
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: time }),
  
  // Status
  status: conversationStatusEnum("status").notNull().default("active"),
  
  // Resolution
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolution: text("resolution"),
  
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("conv_states_org_id_idx").on(table.organizationId),
  index("conv_states_customer_idx").on(table.customerId),
  index("conv_states_session_idx").on(table.sessionId),
  index("conv_states_type_idx").on(table.conversationType),
  index("conv_states_status_idx").on(table.status),
  index("conv_states_expires_at_idx").on(table.expiresAt),
]);

export const conversationTypeEnum = pgEnum("conversation_type", [
  "rescheduling",
  "review_collection",
  "feedback",
  "support",
]);

export const conversationStatusEnum = pgEnum("conversation_status", [
  "active",
  "awaiting_response",
  "escalated",
  "completed",
  "abandoned",
]);

// 4. escalation_tasks - Human intervention queue
export const escalationTasks = pgTable("escalation_tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  
  // Task details
  triggerReason: escalationReasonEnum("trigger_reason").notNull(),
  priority: priorityEnum("priority").notNull().default("normal"),
  
  // Context
  customerId: uuid("customer_id").references(() => customers.id),
  serviceRequestId: uuid("service_request_id").references(() => serviceRequests.id),
  communicationJobId: uuid("communication_job_id").references(() => communicationJobs.id),
  
  // Assignment
  assignedTo: uuid("assigned_to").references(() => users.id),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  
  // Status tracking
  status: escalationStatusEnum("status").notNull().default("pending"),
  response: text("response"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: uuid("resolved_by").references(() => users.id),
  
  // SLA tracking
  dueAt: timestamp("due_at", { withTimezone: true }),
  overdueAt: timestamp("overdue_at", { withTimezone: true }),
  
  // Context for human reviewer
  contextNotes: text("context_notes"),
  communicationHistory: jsonb("communication_history").$type<CommunicationSummary[]>().notNull().default(sql`'[]'::jsonb`),
  
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("escalation_tasks_org_id_idx").on(table.organizationId),
  index("escalation_tasks_status_idx").on(table.status),
  index("escalation_tasks_assigned_to_idx").on(table.assignedTo),
  index("escalation_tasks_due_at_idx").on(table.dueAt),
  index("escalation_tasks_priority_idx").on(table.priority),
]);

export const escalationReasonEnum = pgEnum("escalation_reason", [
  "no_available_slots",
  "customer_request",
  "complaint_detected",
  "cancellation_request",
  "delivery_failure",
  "negative_sentiment",
  "complex_reschedule",
  "other",
]);

export const escalationStatusEnum = pgEnum("escalation_status", [
  "pending",
  "assigned",
  "in_progress",
  "resolved",
  "cancelled",
]);

// 5. message_deliverability - Track delivery metrics for optimization
export const messageDeliverability = pgTable("message_deliverability", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  
  // Link to job
  communicationJobId: uuid("communication_job_id")
    .notNull()
    .references(() => communicationJobs.id),
  
  // Delivery events
  eventType: deliveryEventTypeEnum("event_type").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  
  // Event metadata (provider-specific data)
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  
  // Error information
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
}, (table) => [
  index("msg_deliverability_org_id_idx").on(table.organizationId),
  index("msg_deliverability_job_id_idx").on(table.communicationJobId),
  index("msg_deliverability_type_idx").on(table.eventType),
  index("msg_deliverability_timestamp_idx").on(table.timestamp),
]);

export const deliveryEventTypeEnum = pgEnum("delivery_event_type", [
  "queued",
  "sent",
  "delivered",
  "failed",
  "opened", // Email only
  "clicked", // Email only
  "unsubscribed",
  "bounced",
  "opted_out",
]);

// 6. communication_preferences - Customer communication preferences
export const communicationPreferences = pgTable("communication_preferences", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  customerId: uuid("customer_id")
    .notNull()
    .references(() => customers.id),
  
  // Channel preferences
  preferredChannel: contactPreferenceEnum("preferred_channel").notNull().default("call"),
  smsEnabled: boolean("sms_enabled").notNull().default(true),
  emailEnabled: boolean("email_enabled").notNull().default(true),
  voiceEnabled: boolean("voice_enabled").notNull().default(true),
  
  // Content preferences
  language: text("language").notNull().default("en"),
  timeZone: text("time_zone"),
  
  // Timing preferences
  noCallsBefore: integer("no_calls_before"), // Hour of day (0-23)
  noCallsAfter: integer("no_calls_after"), // Hour of day (0-23)
  noCallsOnWeekends: boolean("no_calls_on_weekends").notNull().default(false),
  
  // Review preferences
  reviewRequestsEnabled: boolean("review_requests_enabled").notNull().default(true),
  lastReviewRequestAt: timestamp("last_review_request_at", { withTimezone: true }),
  
  // Compliance
  smsConsent: boolean("sms_consent"), // Override service_request-level
  
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("comm_prefs_org_id_idx").on(table.organizationId),
  index("comm_prefs_customer_idx").on(table.customerId),
  uniqueIndex("comm_prefs_org_customer_unique").on(table.organizationId, table.customerId),
]);
```

### Schema Additions to Existing Tables

```typescript
// Add to service_requests (if not present):
// communication_preferences: contact_preference_enum (already exists as contact_preference)
// sms_consent: boolean (already exists)

// Add to organization_settings:
export const organizationSettings = {
  // ... existing fields
  
  // Communication automation settings
  communicationEnabled: boolean("communication_enabled").notNull().default(true),
  
  // Channel configuration
  smsEnabled: boolean("sms_enabled").notNull().default(true),
  emailEnabled: boolean("email_enabled").notNull().default(true),
  
  // Review settings
  reviewPlatforms: jsonb("review_platforms").$type<{
    google?: { url: string; enabled: boolean };
    facebook?: { url: string; enabled: boolean };
    yelp?: { url: string; enabled: boolean };
  }>().notNull().default(sql`'{}'::jsonb`),
  
  // Timing defaults (organization-level overrides)
  reminder24hEnabled: boolean("reminder_24h_enabled").notNull().default(true),
  reminder2hEnabled: boolean("reminder_2h_enabled").notNull().default(true),
  reviewRequestDelay: integer("review_request_delay").notNull().default(36), // hours
  reviewReminderDelay: integer("review_reminder_delay").notNull().default(168), // hours (7 days)
  
  // Branding for messages
  messageSignature: text("message_signature"), // "- {company_name}"
  messageFromNumber: text("message_from_number"), // For SMS display
  messageFromEmail: text("message_from_email"), // For email
  
  // Compliance
  smsDisclaimer: text("sms_disclaimer"), // "Msg&data rates may apply"
  emailPhysicalAddress: text("email_physical_address"), // CAN-SPAM requirement
  emailUnsubscribeUrl: text("email_unsubscribe_url"),
};
```

---

## Message Template System

### Template Architecture

**Template Engine:** Handlebars.js for SMS, React Email for HTML emails

**Template Hierarchy:**
```
System Defaults (fallback)
    ↓
Organization Templates (override)
    ↓
Customer-Specific (future - personalization at scale)
```

### Template Variables

**Available Context:**

```typescript
interface TemplateContext {
  // Organization
  organization: {
    name: string;
    phone: string;
    logoUrl?: string;
  };
  
  // Customer
  customer: {
    firstName: string;
    lastName: string;
    fullName: string;
    // Not PII - use encrypted fields in DB
  };
  
  // Service Request
  appointment: {
    referenceNumber: string;
    date: string; // Formatted "Monday, June 16"
    timeWindow: string; // "8:00 AM - 12:00 PM"
    serviceType: string;
    address: string;
    technicianName?: string;
    isAfterHours: boolean;
  };
  
  // Links (generated)
  links: {
    confirm: string;
    reschedule: string;
    cancel: string;
    reviewGoogle?: string;
    reviewFacebook?: string;
    reviewYelp?: string;
  };
  
  // Business info
  business: {
    address: string;
    phone: string;
    hours: string;
    serviceArea: string;
  };
}
```

### Template Examples

**SMS Templates**

```handlebars
{{!-- appointment_confirmation_sms --}}
Hi {{customer.firstName}}, your {{appointment.serviceType}} appt is confirmed for {{appointment.date}} {{appointment.timeWindow}}. Tech: {{appointment.technicianName}}. Need to change? {{links.reschedule}} Questions? {{business.phone}}
```

```handlebars
{{!-- appointment_reminder_24h_sms --}}
Reminder: Your {{appointment.serviceType}} appt is tomorrow {{appointment.timeWindow}} at {{appointment.address}}. Reply RESCHEDULE if needed or {{links.reschedule}}. {{business.phone}}
```

```handlebars
{{!-- reschedule_options_sms --}}
Hi {{customer.firstName}}, here are 3 options to reschedule your {{appointment.serviceType}} appt:
1. {{option1.date}} {{option1.timeWindow}} - Reply "1"
2. {{option2.date}} {{option2.timeWindow}} - Reply "2"  
3. {{option3.date}} {{option3.timeWindow}} - Reply "3"
Or {{links.calendar}} to see all times.
```

```handlebars
{{!-- review_request_sms --}}
Hi {{customer.firstName}}, thanks for choosing {{organization.name}}! How was your {{appointment.serviceType}}? Quick review: {{links.reviewGoogle}} (takes 30 sec). We appreciate your feedback!
```

**Email Templates (React Email)**

```tsx
// appointment_confirmation_email.tsx
interface AppointmentConfirmationEmailProps {
  organization: OrganizationInfo;
  customer: CustomerInfo;
  appointment: AppointmentInfo;
  links: LinkBundle;
}

export function AppointmentConfirmationEmail({
  organization,
  customer,
  appointment,
  links,
}: AppointmentConfirmationEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Appointment Confirmed</Heading>
          <Text>Hi {customer.firstName},</Text>
          <Text>
            Your {appointment.serviceType} appointment has been confirmed for:
          </Text>
          
          <Section style={appointmentBox}>
            <Hr style={hr} />
            <Text style={bold}>
              {appointment.date} • {appointment.timeWindow}
            </Text>
            <Text>{appointment.address}</Text>
            {appointment.technicianName && (
              <Text>Technician: {appointment.technicianName}</Text>
            )}
            <Text>Reference: {appointment.referenceNumber}</Text>
            {appointment.isAfterHours && (
              <Text style={afterHours}>
                ⚠️ After-hours appointment may incur additional charges
              </Text>
            )}
            <Hr style={hr} />
          </Section>
          
          <Section>
            <Button style={button} href={links.confirm}>
              Confirm Appointment
            </Button>
            <Button style={buttonSecondary} href={links.reschedule}>
              Reschedule
            </Button>
            <Button style={buttonSecondary} href={links.cancel}>
              Cancel
            </Button>
          </Section>
          
          <Text style={footer}>
            Questions? Call us at {organization.phone}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const main = { fontFamily: 'sans-serif' };
const container = { maxWidth: '600px', margin: '0 auto' };
const appointmentBox = { 
  background: '#f5f5f5', 
  padding: '20px', 
  borderRadius: '8px',
  margin: '20px 0'
};
const button = {
  background: '#000',
  color: '#fff',
  padding: '12px 24px',
  borderRadius: '6px',
  textDecoration: 'none',
  display: 'block',
  marginBottom: '10px',
  textAlign: 'center',
};
// ... additional styles
```

### Template Management API

**List Templates:**
```http
GET /api/admin/communication/templates
Response: {
  templates: [{
    id, key, name, description, version, isActive,
    channel, jobType, variables, supportedLanguages
  }]
}
```

**Get Template (with current version):**
```http
GET /api/admin/communication/templates/:key
Response: { template, renderedPreview }
```

**Create/Update Template:**
```http
PUT /api/admin/communication/templates/:key
Body: {
  name, description, subjectTemplate, bodyTemplate,
  channel, jobType, variables, supportedLanguages
}
```

**Preview Template:**
```http
POST /api/admin/communication/templates/:key/preview
Body: { context: { organization, customer, appointment, links } }
Response: { renderedSubject, renderedBody }
```

---

## Scheduling & Timing Engine

### Job Scheduling System

**Job Queue Implementation (Phase 1 - In-Memory):**

```typescript
// src/lib/communication/job-queue.ts

interface JobPayload {
  jobType: CommunicationJobType;
  organizationId: string;
  recipientCustomerId: string;
  templateId: string;
  context: TemplateContext;
  scheduledFor: Date;
  priority: Priority;
  channel: CommunicationChannel;
  serviceRequestId?: string;
}

class CommunicationJobQueue {
  /**
   * Schedule a communication job for future execution
   */
  async schedule(payload: JobPayload): Promise<string> {
    // Insert into communication_jobs table
    const job = await db.insert(communicationJobs).values({
      organizationId: payload.organizationId,
      recipientCustomerId: payload.recipientCustomerId,
      jobType: payload.jobType,
      channel: payload.channel,
      templateId: payload.templateId,
      scheduledFor: payload.scheduledFor,
      priority: payload.priority,
      serviceRequestId: payload.serviceRequestId,
      status: 'pending',
      renderedBody: '', // Will be populated at execution time
      // ... recipient fields (encrypted)
    }).returning();
    
    return job[0].id;
  }
  
  /**
   * Process pending jobs (called by cron worker)
   */
  async processPendingJobs(limit: number = 50): Promise<void> {
    const now = new Date();
    
    const pendingJobs = await db
      .select()
      .from(communicationJobs)
      .where(and(
        eq(communicationJobs.status, 'pending'),
        lte(communicationJobs.scheduledFor, now)
      ))
      .orderBy(desc(communicationJobs.priority), asc(communicationJobs.scheduledFor))
      .limit(limit);
    
    for (const job of pendingJobs) {
      await this.executeJob(job);
    }
  }
  
  /**
   * Execute a single communication job
   */
  private async executeJob(job: CommunicationJob): Promise<void> {
    try {
      await db.update(communicationJobs)
        .set({ status: 'processing', startedAt: new Date() })
        .where(eq(communicationJobs.id, job.id));
      
      // Load and render template
      const rendered = await this.renderTemplate(job);
      
      // Send via appropriate channel
      const result = await this.sendViaChannel(job, rendered);
      
      // Update with result
      await db.update(communicationJobs)
        .set({
          status: 'sent',
          completedAt: new Date(),
          externalId: result.externalId,
          deliveryAttempts: job.deliveryAttempts + 1,
        })
        .where(eq(communicationJobs.id, job.id));
      
      // Track delivery event
      await this.trackDeliveryEvent(job.id, 'sent', result.metadata);
      
    } catch (error) {
      await db.update(communicationJobs)
        .set({
          status: 'failed',
          completedAt: new Date(),
          lastError: String(error),
          deliveryAttempts: job.deliveryAttempts + 1,
        })
        .where(eq(communicationJobs.id, job.id));
      
      await this.trackDeliveryEvent(job.id, 'failed', { error: String(error) });
      
      // Create escalation if 3+ failures
      if (job.deliveryAttempts >= 3) {
        await this.createEscalation(job, 'delivery_failure');
      }
    }
  }
  
  /**
   * Render template with context
   */
  private async renderTemplate(job: CommunicationJob): Promise<RenderedMessage> {
    const template = await this.loadTemplate(job.templateId);
    const context = await this.buildContext(job);
    
    if (job.channel === 'email') {
      return renderEmailTemplate(template, context);
    } else {
      return renderSmsTemplate(template, context);
    }
  }
  
  /**
   * Build template context from job and database
   */
  private async buildContext(job: CommunicationJob): Promise<TemplateContext> {
    const [org, customer, appointment] = await Promise.all([
      getOrganization(job.organizationId),
      getCustomer(job.recipientCustomerId),
      job.serviceRequestId ? getServiceRequest(job.serviceRequestId) : null,
    ]);
    
    const links = this.generateLinks(job, appointment);
    
    return {
      organization: {
        name: org.name,
        phone: org.phone,
        logoUrl: org.logoUrl,
      },
      customer: {
        firstName: decrypt(customer.nameEncrypted).split(' ')[0],
        lastName: decrypt(customer.nameEncrypted).split(' ').slice(1).join(' '),
        fullName: decrypt(customer.nameEncrypted),
      },
      appointment: appointment ? {
        referenceNumber: appointment.referenceNumber,
        date: formatDate(appointment.arrivalWindowStart),
        timeWindow: formatTimeWindow(appointment.arrivalWindowStart, appointment.arrivalWindowEnd),
        serviceType: appointment.issueType,
        address: decrypt(appointment.addressEncrypted),
        technicianName: appointment.assignedTo ? await getTechnicianName(appointment.assignedTo) : undefined,
        isAfterHours: appointment.isAfterHours,
      } : null,
      links,
      business: org.businessInfo,
    };
  }
  
  /**
   * Generate action links for the message
   */
  private generateLinks(job: CommunicationJob, appointment: ServiceRequest | null): LinkBundle {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
    const token = generateActionToken(job.id); // Short-lived JWT
    
    return {
      confirm: `${baseUrl}/a/confirm/${job.id}/${token}`,
      reschedule: `${baseUrl}/a/reschedule/${job.id}/${token}`,
      cancel: `${baseUrl}/a/cancel/${job.id}/${token}`,
      calendar: `${baseUrl}/a/calendar/${job.id}/${token}`,
      reviewGoogle: appointment?.reviewLinks?.google,
      reviewFacebook: appointment?.reviewLinks?.facebook,
      reviewYelp: appointment?.reviewLinks?.yelp,
    };
  }
}
```

### Cron Job Triggers

**Vercel Cron Configuration (vercel.json):**
```json
{
  "crons": [
    {
      "path": "/api/cron/communication/process",
      "schedule": "*/5 * * * *"
    },
    {
      "path": "/api/cron/communication/reminders",
      "schedule": "0 * * * *"
    },
    {
      "path": "/api/cron/communication/reviews",
      "schedule": "0 9-17 * * *"
    },
    {
      "path": "/api/cron/communication/cleanup",
      "schedule": "0 2 * * *"
    }
  ]
}
```

**Cron Endpoints:**

```typescript
// src/app/api/cron/communication/process/route.ts
// Process pending communication jobs every 5 minutes

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  
  const queue = new CommunicationJobQueue();
  await queue.processPendingJobs(50);
  
  return new Response('OK');
}
```

```typescript
// src/app/api/cron/communication/reminders/route.ts
// Schedule reminder jobs for upcoming appointments hourly

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  
  const now = new Date();
  
  // Schedule 24-hour reminders (for appointments 24-25 hours from now)
  const tomorrow24 = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrow25 = new Date(now.getTime() + 25 * 60 * 60 * 1000);
  
  const appointmentsFor24hReminder = await db
    .select()
    .from(serviceRequests)
    .where(and(
      eq(serviceRequests.status, 'scheduled'),
      gte(serviceRequests.arrivalWindowStart, tomorrow24),
      lt(serviceRequests.arrivalWindowStart, tomorrow25),
      isNull(serviceRequests.reminder24hSentAt) // Track sent state
    ));
  
  for (const appointment of appointmentsFor24hReminder) {
    await scheduleReminder(appointment.id, '24h');
    await db.update(serviceRequests)
      .set({ reminder24hSentAt: now })
      .where(eq(serviceRequests.id, appointment.id));
  }
  
  // Similar for 2-hour reminders...
  
  return new Response('OK');
}
```

```typescript
// src/app/api/cron/communication/reviews/route.ts
// Schedule review requests during business hours (9am-5pm)

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  
  const delayHours = 36; // Configurable per org
  
  const completedJobs = await db
    .select({
      requestId: serviceRequests.id,
      organizationId: serviceRequests.organizationId,
      customerId: serviceRequests.customerId,
      completedAt: serviceRequests.completedAt,
      reviewRequestSentAt: serviceRequests.reviewRequestSentAt,
    })
    .from(serviceRequests)
    .where(and(
      eq(serviceRequests.status, 'completed'),
      isNotNull(serviceRequests.completedAt),
      isNull(serviceRequests.reviewRequestSentAt)
    ))
    .orderBy(serviceRequests.completedAt);
  
  for (const job of completedJobs) {
    const hoursSinceCompletion = (Date.now() - job.completedAt.getTime()) / (1000 * 60 * 60);
    
    if (hoursSinceCompletion >= delayHours) {
      await scheduleReviewRequest(job.requestId);
      await db.update(serviceRequests)
        .set({ reviewRequestSentAt: new Date() })
        .where(eq(serviceRequests.id, job.requestId));
    }
  }
  
  return new Response('OK');
}
```

### Event-Based Triggers

**Trigger on State Change:**

```typescript
// src/lib/communication/triggers.ts

export async function triggerAppointmentConfirmation(
  requestId: string
): Promise<void> {
  const request = await getServiceRequest(requestId);
  
  if (!request.arrivalWindowStart || !request.arrivalWindowEnd) {
    return; // Not scheduled yet
  }
  
  const queue = new CommunicationJobQueue();
  
  // Schedule immediate confirmation
  await queue.schedule({
    jobType: 'appointment_confirmation',
    organizationId: request.organizationId,
    recipientCustomerId: request.customerId,
    templateId: 'appointment_confirmation',
    context: { serviceRequestId: requestId },
    scheduledFor: new Date(),
    priority: 'high',
    channel: request.contactPreference,
    serviceRequestId: requestId,
  });
}

export async function triggerRescheduleConfirmation(
  requestId: string,
  newWindowStart: Date,
  newWindowEnd: Date
): Promise<void> {
  const request = await getServiceRequest(requestId);
  
  const queue = new CommunicationJobQueue();
  
  await queue.schedule({
    jobType: 'reschedule_confirmation',
    organizationId: request.organizationId,
    recipientCustomerId: request.customerId,
    templateId: 'reschedule_confirmation',
    context: {
      serviceRequestId: requestId,
      previousWindow: formatTimeWindow(request.arrivalWindowStart, request.arrivalWindowEnd),
      newWindow: formatTimeWindow(newWindowStart, newWindowEnd),
    },
    scheduledFor: new Date(),
    priority: 'high',
    channel: request.contactPreference,
    serviceRequestId: requestId,
  });
}
```

---

## Multi-Channel Delivery

### Channel Adapters

**Interface:**

```typescript
interface ChannelAdapter {
  send(message: Message): Promise<SendResult>;
  parseWebhook(request: NextRequest): Promise<WebhookEvent>;
  validateRecipient(recipient: Recipient): Promise<boolean>;
}

interface Message {
  to: string; // phone number or email
  body: string;
  subject?: string; // Email only
  html?: string; // Email only
  metadata?: Record<string, unknown>;
}

interface SendResult {
  success: boolean;
  externalId?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

interface WebhookEvent {
  type: string;
  externalId: string;
  timestamp: Date;
  data: Record<string, unknown>;
}
```

### SMS Adapter (Twilio)

```typescript
// src/lib/communication/channels/sms.ts

export class TwilioSMSAdapter implements ChannelAdapter {
  private client: Twilio;
  
  constructor() {
    this.client = new Twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }
  
  async send(message: Message): Promise<SendResult> {
    try {
      const result = await this.client.messages.create({
        to: message.to,
        from: process.env.TWILIO_PHONE_NUMBER,
        body: message.body,
        statusCallback: `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/twilio/sms`,
      });
      
      return {
        success: true,
        externalId: result.sid,
        metadata: { status: result.status, direction: result.direction },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
  
  async parseWebhook(request: NextRequest): Promise<WebhookEvent> {
    const params = await request.formData();
    
    return {
      type: params.get('MessageStatus') || 'unknown',
      externalId: params.get('MessageSid') || '',
      timestamp: new Date(params.get('Timestamp') || Date.now()),
      data: {
        from: params.get('From'),
        to: params.get('To'),
        body: params.get('Body'),
        errorCode: params.get('ErrorCode'),
        errorMessage: params.get('ErrorMessage'),
      },
    };
  }
  
  async validateRecipient(phone: string): Promise<boolean> {
    // Basic E.164 validation
    return /^\+?[1-9]\d{1,14}$/.test(phone);
  }
}
```

### Email Adapter (Resend)

```typescript
// src/lib/communication/channels/email.ts

import { Resend } from 'resend';

export class ResendEmailAdapter implements ChannelAdapter {
  private client: Resend;
  
  constructor() {
    this.client = new Resend(process.env.RESEND_API_KEY);
  }
  
  async send(message: Message): Promise<SendResult> {
    try {
      const result = await this.client.emails.send({
        from: process.env.EMAIL_FROM || 'noreply@example.com',
        to: message.to,
        subject: message.subject || '',
        html: message.html || message.body,
        text: message.body,
        headers: {
          'List-Unsubscribe': `<${process.env.NEXT_PUBLIC_APP_URL}/unsubscribe/{context.token}>`,
        },
      });
      
      return {
        success: true,
        externalId: result.id,
        metadata: { provider: 'resend' },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
  
  async parseWebhook(request: NextRequest): Promise<WebhookEvent> {
    // Resend webhooks are signed
    const body = await request.json();
    
    return {
      type: body.type,
      externalId: body.data?.email_id || '',
      timestamp: new Date(body.created_at),
      data: body,
    };
  }
  
  async validateRecipient(email: string): Promise<boolean> {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
}
```

### Channel Selection Logic

```typescript
// src/lib/communication/channel-selection.ts

interface ChannelSelectionContext {
  organizationId: string;
  customerId: string;
  jobType: CommunicationJobType;
  customerPreference?: ContactPreference;
}

export async function selectBestChannel(
  context: ChannelSelectionContext
): Promise<CommunicationChannel> {
  // 1. Check customer preference
  const customerPref = await getCommunicationPreference(context.customerId);
  
  // 2. Check organization settings
  const orgSettings = await getOrganizationSettings(context.organizationId);
  
  // 3. Check compliance state (opt-outs, consent)
  const compliance = await checkCompliance(context);
  
  // Decision matrix
  if (customerPref?.preferredChannel === 'call') {
    if (compliance.smsConsent && orgSettings.smsEnabled) {
      return 'sms';
    }
  }
  
  if (customerPref?.preferredChannel === 'text' && compliance.smsConsent) {
    return 'sms';
  }
  
  // Default: SMS if consent, otherwise email
  if (compliance.smsConsent && orgSettings.smsEnabled) {
    return 'sms';
  }
  
  if (orgSettings.emailEnabled) {
    return 'email';
  }
  
  // Fallback: Create escalation for manual follow-up
  await createEscalation(context, 'no_available_channel');
  throw new Error('No communication channel available');
}
```

---

## Conversation Design

### Conversation State Machines

**Rescheduling Conversation:**

```typescript
// src/lib/communication/conversations/rescheduling.ts

interface ReschedulingState {
  step: 'init' | 'options_presented' | 'awaiting_selection' | 'confirming' | 'complete';
  requestId: string;
  offeredSlots: Slot[];
  selectedSlot?: Slot;
  attempts: number;
}

export class ReschedulingConversation {
  async start(requestId: string): Promise<void> {
    const state: ReschedulingState = {
      step: 'init',
      requestId,
      offeredSlots: [],
      attempts: 0,
    };
    
    await this.saveState(state);
    await this.offerOptions(state);
  }
  
  private async offerOptions(state: ReschedulingState): Promise<void> {
    const slots = await findAvailableSlots(state.requestId);
    
    if (slots.length === 0) {
      await this.escalate(state);
      return;
    }
    
    state.offeredSlots = slots.slice(0, 3);
    state.step = 'options_presented';
    await this.saveState(state);
    
    await this.sendMessage(state.requestId, 'reschedule_options', {
      options: state.offeredSlots.map((slot, i) => ({
        number: i + 1,
        date: formatDate(slot.start),
        timeWindow: formatTimeWindow(slot.start, slot.end),
      })),
    });
  }
  
  async handleReply(message: string): Promise<void> {
    const state = await this.loadState();
    
    switch (state.step) {
      case 'options_presented':
        // Parse selection
        const selection = this.parseSelection(message);
        if (selection && selection <= state.offeredSlots.length) {
          state.selectedSlot = state.offeredSlots[selection - 1];
          state.step = 'confirming';
          await this.confirmSelection(state);
        } else {
          await this.representOptions(state);
        }
        break;
      
      case 'confirming':
        if (this.isConfirmation(message)) {
          await this.completeReschedule(state);
        } else if (this.isCancellation(message)) {
          await this.start(state.requestId); // Restart
        } else {
          await this.reconfirm(state);
        }
        break;
    }
  }
  
  private async confirmSelection(state: ReschedulingState): Promise<void> {
    await this.sendMessage(state.requestId, 'reschedule_confirm_selection', {
      slot: state.selectedSlot,
    });
  }
  
  private async completeReschedule(state: ReschedulingState): Promise<void> {
    // Update service request
    await updateServiceRequestWindow(state.requestId, state.selectedSlot);
    
    // Send confirmation
    await triggerRescheduleConfirmation(
      state.requestId,
      state.selectedSlot.start,
      state.selectedSlot.end
    );
    
    // Mark conversation complete
    state.step = 'complete';
    await this.saveState(state);
  }
  
  private async escalate(state: ReschedulingState): Promise<void> {
    await createEscalation({
      organizationId: state.organizationId,
      serviceRequestId: state.requestId,
      reason: 'no_available_slots',
      priority: 'normal',
    });
    
    await this.sendMessage(state.requestId, 'reschedule_escalated', {
      message: "I couldn't find an available time slot. A team member will contact you shortly to help reschedule.",
    });
  }
}
```

### Response Parsing

```typescript
// src/lib/communication/response-parser.ts

interface ParsedResponse {
  intent: string;
  confidence: number;
  entities: Record<string, unknown>;
}

export function parseCustomerResponse(
  message: string,
  expectedIntents: string[]
): ParsedResponse {
  const lower = message.toLowerCase().trim();
  
  // Deterministic intent matching (no LLM for speed/reliability)
  
  // Confirmation
  if (/^(yes|yep|sure|ok|sounds good|confirm|that works|do it)/.test(lower)) {
    return { intent: 'confirm', confidence: 0.95, entities: {} };
  }
  
  // Cancellation
  if (/^(no|nope|cancel|never mind|forget it|don't)/.test(lower)) {
    return { intent: 'cancel', confidence: 0.95, entities: {} };
  }
  
  // Reschedule request
  if (/(reschedule|change time|different time|move|can't make it)/.test(lower)) {
    return { intent: 'reschedule', confidence: 0.9, entities: {} };
  }
  
  // Numeric selection (for slot selection)
  const numberMatch = lower.match(/^(\d+)$/);
  if (numberMatch) {
    return { 
      intent: 'select_slot', 
      confidence: 0.9, 
      entities: { selection: parseInt(numberMatch[1], 10) } 
    };
  }
  
  // Help/Human
  if (/(speak to human|talk to person|agent|representative|help me)/.test(lower)) {
    return { intent: 'escalate', confidence: 0.95, entities: {} };
  }
  
  // Default: unknown
  return { intent: 'unknown', confidence: 0.5, entities: {} };
}
```

---

## Integration Points

### Connection to Stage A (After-Hours Capture)

**Trigger:** Service request created or status change detected.

```typescript
// src/lib/communication/integrations/stage-a.ts

export async function onServiceRequestCreated(requestId: string): Promise<void> {
  const request = await getServiceRequest(requestId);
  
  // Check if organization has communication enabled
  const orgSettings = await getOrganizationSettings(request.organizationId);
  if (!orgSettings.communicationEnabled) {
    return;
  }
  
  // If immediately scheduled, send confirmation
  if (request.status === 'scheduled' && request.arrivalWindowStart) {
    await triggerAppointmentConfirmation(requestId);
  }
}

export async function onServiceRequestUpdated(
  requestId: string,
  changes: Record<string, unknown>
): Promise<void> {
  const request = await getServiceRequest(requestId);
  
  // Status changed to scheduled
  if (changes.status === 'scheduled' && request.arrivalWindowStart) {
    await triggerAppointmentConfirmation(requestId);
  }
  
  // Window changed (reschedule by admin)
  if (changes.arrivalWindowStart || changes.arrivalWindowEnd) {
    await triggerRescheduleConfirmation(
      requestId,
      request.arrivalWindowStart,
      request.arrivalWindowEnd
    );
  }
  
  // Status changed to completed
  if (changes.status === 'completed') {
    // Review request will be scheduled by cron after delay period
    await markForReviewRequest(requestId);
  }
  
  // Status changed to cancelled
  if (changes.status === 'cancelled') {
    await notifyCancellation(requestId);
  }
}
```

### Connection to Stage B (Scheduling Changes)

**Trigger:** Admin reschedules via calendar UI.

```typescript
// src/lib/communication/integrations/stage-b.ts

export async function onAdminReschedule(
  requestId: string,
  previousWindow: ArrivalWindow,
  newWindow: ArrivalWindow,
  adminUserId: string
): Promise<void> {
  const request = await getServiceRequest(requestId);
  
  // Send reschedule confirmation to customer
  await triggerRescheduleConfirmation(
    requestId,
    newWindow.start,
    newWindow.end
  );
  
  // If appointment is within 24 hours, send immediate reminder
  const hoursUntil = differenceInHours(newWindow.start, new Date());
  if (hoursUntil <= 24) {
    await scheduleReminder(requestId, '24h');
  }
  
  // Log for audit
  await logAdminAction({
    userId: adminUserId,
    action: 'reschedule_appointment',
    entityType: 'service_request',
    entityId: requestId,
    details: {
      previous: previousWindow,
      new: newWindow,
    },
  });
}
```

### Connection to Customer Database

**Customer Preference Resolution:**

```typescript
// src/lib/communication/integrations/crm.ts

export async function getCommunicationContext(customerId: string): Promise<CommunicationContext> {
  const [customer, prefs, lastService] = await Promise.all([
    getCustomer(customerId),
    getCommunicationPreference(customerId),
    getLastServiceRequest(customerId),
  ]);
  
  return {
    customer: {
      id: customer.id,
      firstName: decrypt(customer.nameEncrypted).split(' ')[0],
      lastName: decrypt(customer.nameEncrypted).split(' ').slice(1).join(' '),
      // Never include full PII in logs
    },
    preferences: {
      preferredChannel: prefs?.preferredChannel || 'call',
      smsEnabled: prefs?.smsEnabled ?? true,
      emailEnabled: prefs?.emailEnabled ?? true,
      language: prefs?.language || 'en',
    },
    lastService: lastService ? {
      date: lastService.completedAt,
      technicianId: lastService.assignedTo,
      issueType: lastService.issueType,
    } : null,
    compliance: {
      smsConsent: lastService?.smsConsent ?? false,
      optOuts: await getCustomerOptOuts(customerId),
    },
  };
}
```

---

## Compliance & Quality

### TCPA Compliance (SMS)

**Requirements:**
1. **Express Consent:** Must have prior written consent from customer
2. **Opt-Out Mechanism:** Every message must include STOP opt-out
3. **Hours Restriction:** No messages 9PM-8AM local time
4. **Content Restrictions:** No telemarketing to cell phones without consent

**Implementation:**

```typescript
// src/lib/communication/compliance/tcpa.ts

export class TCPACompliance {
  /**
   * Check if SMS can be sent to this customer
   */
  async canSendSMS(customerId: string): Promise<{ allowed: boolean; reason?: string }> {
    const customer = await getCustomer(customerId);
    const prefs = await getCommunicationPreference(customerId);
    
    // 1. Check consent
    if (!customer.smsConsent && !prefs?.smsConsent) {
      return { allowed: false, reason: 'No SMS consent' };
    }
    
    // 2. Check opt-out
    const optOut = await getOptOut(customerId, 'sms');
    if (optOut && optOut.active) {
      return { allowed: false, reason: 'Customer opted out' };
    }
    
    // 3. Check time restrictions (customer timezone)
    const customerHour = this.getCurrentHour(customer.timeZone);
    if (customerHour < 8 || customerHour >= 21) {
      return { allowed: false, reason: 'Outside allowed hours (9PM-8AM)' };
    }
    
    // 4. Check preferences
    if (prefs?.smsEnabled === false) {
      return { allowed: false, reason: 'SMS disabled in preferences' };
    }
    
    return { allowed: true };
  }
  
  /**
   * Add TCPA compliant disclaimer to message
   */
  addDisclaimer(message: string, organizationId: string): string {
    // Check if message already has disclaimer
    if (this.hasDisclaimer(message)) {
      return message;
    }
    
    const disclaimer = this.getDisclaimer(organizationId);
    
    // For SMS, append if room
    if (message.length + disclaimer.length <= 160) {
      return `${message} ${disclaimer}`;
    }
    
    // For email, add as footer
    return message; // Email handles separately
  }
  
  /**
   * Process STOP opt-out request
   */
  async handleOptOut(customerId: string, channel: 'sms' | 'email'): Promise<void> {
    await db.insert(optOuts).values({
      customerId,
      channel,
      optedOutAt: new Date(),
      source: 'customer_reply',
    });
    
    // Update preferences
    await db.update(communicationPreferences)
      .set(channel === 'sms' 
        ? { smsEnabled: false }
        : { emailEnabled: false })
      .where(eq(communicationPreferences.customerId, customerId));
    
    // Send confirmation
    await this.sendOptOutConfirmation(customerId, channel);
  }
}
```

### CAN-SPAM Compliance (Email)

**Requirements:**
1. **Physical Address:** Must include in every email
2. **Unsubscribe Mechanism:** Must be functional and prominent
3. **Subject Line:** Must not be misleading
4. **Header Info:** Accurate "From" and "Reply-To"

**Implementation:**

```typescript
// src/lib/communication/compliance/canspam.ts

export class CANSPAMCompliance {
  /**
   * Add required CAN-SPAM elements to email
   */
  complyEmail(email: EmailTemplate, organizationId: string): EmailTemplate {
    const org = getOrganization(organizationId);
    
    // Add physical address footer
    if (!email.footer) {
      email.footer = this.buildAddressFooter(org);
    }
    
    // Add unsubscribe link
    if (!email.unsubscribeUrl) {
      email.unsubscribeUrl = this.generateUnsubscribeLink(email.recipientId);
    }
    
    // Validate subject line
    if (this.isMisleadingSubject(email.subject)) {
      throw new Error('Subject line may be misleading');
    }
    
    // Set accurate From address
    email.from = org.emailFrom || 'noreply@' = this.getDomain(organizationId);
    email.replyTo = org.replyToEmail || email.from;
    
    return email;
  }
  
  /**
   * Generate unsubscribe link with token
   */
  private generateUnsubscribeLink(customerId: string): string {
    const token = generateUnsubscribeToken(customerId);
    return `${process.env.NEXT_PUBLIC_APP_URL}/unsubscribe/${customerId}/${token}`;
  }
  
  /**
   * Process unsubscribe request
   */
  async handleUnsubscribe(customerId: string): Promise<void> {
    await db.update(communicationPreferences)
      .set({ emailEnabled: false })
      .where(eq(communicationPreferences.customerId, customerId));
    
    // Record in audit log
    await logUnsubscribe(customerId);
  }
}
```

### Message Quality Monitoring

**Quality Checks:**

```typescript
// src/lib/communication/quality.ts

export class MessageQuality {
  /**
   * Validate message before sending
   */
  async validate(message: RenderedMessage): Promise<QualityReport> {
    const issues: QualityIssue[] = [];
    
    // 1. Length checks
    if (message.channel === 'sms' && message.body.length > 160) {
      issues.push({
        level: 'warning',
        code: 'SMS_LENGTH',
        message: 'SMS exceeds 160 characters (will be segmented)',
        details: { length: message.body.length, segments: Math.ceil(message.body.length / 160) },
      });
    }
    
    // 2. Personalization checks
    const missingVars = this.findUnsubstitutedVariables(message.body);
    if (missingVars.length > 0) {
      issues.push({
        level: 'error',
        code: 'UNSUBSTITUTED_VARIABLES',
        message: 'Template variables not substituted',
        details: { variables: missingVars },
      });
    }
    
    // 3. Link validation
    const brokenLinks = await this.validateLinks(message);
    if (brokenLinks.length > 0) {
      issues.push({
        level: 'error',
        code: 'BROKEN_LINKS',
        message: 'Links are not accessible',
        details: { links: brokenLinks },
      });
    }
    
    // 4. Grammar/spell check
    const grammarIssues = await this.checkGrammar(message.body);
    for (const issue of grammarIssues) {
      issues.push({
        level: 'warning',
        code: 'GRAMMAR',
        message: 'Potential grammar issue',
        details: issue,
      });
    }
    
    // 5. Compliance checks
    const compliance = await this.checkCompliance(message);
    if (!compliance.passed) {
      issues.push({
        level: 'error',
        code: 'COMPLIANCE',
        message: 'Compliance check failed',
        details: compliance.issues,
      });
    }
    
    return {
      passed: !issues.some(i => i.level === 'error'),
      issues,
    };
  }
  
  /**
   * Find unreplaced {{variable}} patterns
   */
  private findUnsubstitutedVariables(text: string): string[] {
    const matches = text.match(/\{\{[^}]+\}\}/g) || [];
    return matches.map(m => m.slice(2, -2));
  }
}
```

---

## Escalation & Human Handoff

### Escalation Creation

```typescript
// src/lib/communication/escalation.ts

export async function createEscalation(
  context: {
    organizationId: string;
    customerId?: string;
    serviceRequestId?: string;
    communicationJobId?: string;
  },
  reason: EscalationReason,
  priority: Priority = 'normal'
): Promise<string> {
  // Build escalation package
  const pkg = await buildEscalationPackage(context);
  
  // Determine due date based on priority
  const dueAt = calculateDueDate(priority);
  
  // Insert escalation task
  const [task] = await db.insert(escalationTasks).values({
    organizationId: context.organizationId,
    customerId: context.customerId,
    serviceRequestId: context.serviceRequestId,
    communicationJobId: context.communicationJobId,
    triggerReason: reason,
    priority,
    status: 'pending',
    dueAt,
    contextNotes: this.buildContextNotes(pkg, reason),
    communicationHistory: pkg.communicationHistory,
  }).returning();
  
  // Find available staff member
  const assignee = await findAvailableAssignee(context.organizationId, priority);
  
  if (assignee) {
    await assignEscalation(task.id, assignee.id);
  }
  
  // Notify assignee (if found) or admins
  await notifyEscalationCreated(task);
  
  return task.id;
}

interface EscalationPackage {
  escalationId: string;
  triggerReason: EscalationReason;
  customerInfo: CustomerSummary;
  context: {
    originalSessionId?: string;
    serviceRequestId?: string;
    communicationHistory: CommunicationSummary[];
    lastInteraction: Date;
  };
  priority: Priority;
}

async function buildEscalationPackage(
  context: EscalationContext
): Promise<EscalationPackage> {
  const [customer, serviceRequest, recentMessages] = await Promise.all([
    context.customerId ? getCustomer(context.customerId) : null,
    context.serviceRequestId ? getServiceRequest(context.serviceRequestId) : null,
    context.serviceRequestId 
      ? getRecentCommunicationForRequest(context.serviceRequestId, 10)
      : [],
  ]);
  
  return {
    escalationId: generateId(),
    triggerReason: context.reason,
    customerInfo: customer ? {
      id: customer.id,
      firstName: decrypt(customer.nameEncrypted).split(' ')[0],
      lastName: decrypt(customer.nameEncrypted).split(' ').slice(1).join(' '),
      phone: formatPhone(decrypt(customer.phoneEncrypted)),
      email: decrypt(customer.emailEncrypted),
    } : null,
    context: {
      serviceRequestId: context.serviceRequestId,
      communicationHistory: recentMessages,
      lastInteraction: recentMessages[0]?.timestamp || new Date(),
    },
    priority: context.priority || 'normal',
  };
}

async function notifyEscalationCreated(task: EscalationTask): Promise<void> {
  const recipients = await getEscalationRecipients(task.organizationId, task.priority);
  
  for (const recipient of recipients) {
    await queueNotification({
      type: 'escalation_created',
      recipientId: recipient.id,
      channel: 'email',
      template: 'escalation_created_email',
      context: {
        task: {
          id: task.id,
          reason: task.triggerReason,
          priority: task.priority,
          customerName: task.contextNotes?.customerName,
          dueAt: task.dueAt,
        },
        links: {
          viewTask: `${process.env.NEXT_PUBLIC_APP_URL}/admin/escalations/${task.id}`,
          claimTask: `${process.env.NEXT_PUBLIC_APP_URL}/admin/escalations/${task.id}/claim`,
        },
      },
    });
  }
}
```

### Escalation Assignment

```typescript
// src/lib/communication/escalation-assignment.ts

export async function assignEscalation(
  escalationId: string,
  assigneeId: string
): Promise<void> {
  await db.update(escalationTasks)
    .set({
      assignedTo: assigneeId,
      assignedAt: new Date(),
      status: 'assigned',
    })
    .where(eq(escalationTasks.id, escalationId));
  
  await notifyAssignee(escalationId, assigneeId);
}

async function findAvailableAssignee(
  organizationId: string,
  priority: Priority
): Promise<User | null> {
  // Get active admins/technicians
  const staff = await getActiveStaff(organizationId);
  
  // Filter by role permissions
  const eligible = staff.filter(s => 
    s.role === 'admin' || (s.role === 'technician' && priority !== 'high')
  );
  
  // Get current workload
  const workloads = await Promise.all(
    eligible.map(async (s) => ({
      staff: s,
      pendingEscalations: await countPendingEscalations(s.id),
    }))
  );
  
  // Sort by workload (least busy first)
  workloads.sort((a, b) => a.pendingEscalations - b.pendingEscalations);
  
  return workloads[0]?.staff || null;
}
```

### Escalation Response

```typescript
// src/lib/communication/escalation-response.ts

export async function resolveEscalation(
  escalationId: string,
  response: EscalationResponse,
  resolvedBy: string
): Promise<void> {
  await db.update(escalationTasks)
    .set({
      status: 'resolved',
      response: response.notes,
      resolvedAt: new Date(),
      resolvedBy,
    })
    .where(eq(escalationTasks.id, escalationId));
  
  // If resolution required customer notification
  if (response.notifyCustomer) {
    await sendEscalationResolutionNotification(escalationId, response);
  }
  
  // Log resolution
  await logEscalationResolution(escalationId, response, resolvedBy);
}

export interface EscalationResponse {
  resolution: EscalationResolution;
  notes: string;
  notifyCustomer: boolean;
  customerMessage?: string;
  followUpRequired: boolean;
  followUpDate?: Date;
}

export type EscalationResolution = 
  | 'rescheduled'
  | 'cancelled'
  | 'contacted'
  | 'no_response'
  | 'resolved_manually'
  | 'deferred';
```

---

## API Endpoints

### Communication Admin APIs

**List Communication Jobs:**
```http
GET /api/admin/communication/jobs
Query: ?status=pending&limit=50
Response: {
  jobs: [{
    id, jobType, channel, status, scheduledFor,
    customerName, serviceRequestReference,
    deliveryAttempts, lastError
  }],
  total, page, limit
}
```

**Create Manual Message:**
```http
POST /api/admin/communication/jobs
Body: {
  customerId: string,
  channel: 'sms' | 'email',
  templateKey: string,
  context: Record<string, unknown>,
  scheduledFor?: Date // default: now
}
Response: { jobId }
```

**List Escalations:**
```http
GET /api/admin/escalations
Query: ?status=pending&priority=high
Response: {
  escalations: [{
    id, triggerReason, priority, status,
    customerName, serviceRequestReference,
    dueAt, assignedTo, createdAt
  }],
  total
}
```

**Claim/Assign Escalation:**
```http
POST /api/admin/escalations/:id/claim
Response: { escalation: {...} }
```

**Resolve Escalation:**
```http
POST /api/admin/escalations/:id/resolve
Body: {
  resolution: 'rescheduled' | 'cancelled' | 'contacted' | ...,
  notes: string,
  notifyCustomer: boolean,
  customerMessage?: string
}
Response: { success: true }
```

**View Communication History:**
```http
GET /api/admin/communication/history/:customerId
Response: {
  messages: [{
    id, jobType, channel, sentAt, deliveredAt,
    status, subject, bodyPreview
  }]
}
```

### Customer Action APIs

**Reschedule Action:**
```http
GET /a/reschedule/:jobId/:token
Response: HTML page with slot options
```

**Confirm Appointment:**
```http
POST /a/confirm/:jobId/:token
Body: { confirmed: true }
Response: { success: true, newAppointmentDetails }
```

**Unsubscribe:**
```http
GET /unsubscribe/:customerId/:token
Response: HTML confirmation page
POST /unsubscribe/:customerId/:token
Response: { success: true }
```

### Webhook Endpoints

**Twilio SMS Webhook:**
```http
POST /api/webhooks/twilio/sms
- Handles delivery status updates
- Handles customer replies (opt-outs, responses)
- Updates communication_jobs and conversation_states
```

**Resend Email Webhook:**
```http
POST /api/webhooks/resend
- Handles delivery status
- Tracks opens and clicks
- Handles bounces and unsubscribes
```

---

## Implementation Phases

### Phase 1: Foundation (Week 1-2)

**Database & Core Types:**
- [ ] Create migration for new tables (communication_jobs, communication_templates, etc.)
- [ ] Define TypeScript types for communication system
- [ ] Add enums to schema.ts

**Template Engine:**
- [ ] Implement Handlebars-based SMS template renderer
- [ ] Implement React Email template renderer
- [ ] Create seed data for default templates
- [ ] Template validation and preview endpoints

**Job Queue (In-Memory):**
- [ ] Implement CommunicationJobQueue class
- [ ] Job scheduling and execution logic
- [ ] Error handling and retry logic

**Testing:**
- [ ] Unit tests for template rendering
- [ ] Unit tests for job queue
- [ ] Integration tests for database operations

---

### Phase 2: SMS Channel (Week 3-4)

**Twilio Integration:**
- [ ] Implement TwilioSMSAdapter
- [ ] SMS webhook handler for delivery status
- [ ] SMS webhook handler for inbound replies
- [ ] Response parser for SMS replies

**Confirmation Flow:**
- [ ] Trigger on service request scheduled
- [ ] Send appointment confirmation
- [ ] Handle confirm response
- [ ] Handle reschedule request

**Reminder System:**
- [ ] 24-hour reminder cron job
- [ ] 2-hour reminder cron job
- [ ] Template variants for reminders

**Testing:**
- [ ] E2E test for confirmation flow
- [ ] E2E test for reminder timing
- [ ] Webhook verification tests

---

### Phase 3: Email Channel (Week 5-6)

**Resend Integration:**
- [ ] Implement ResendEmailAdapter
- [ ] Email webhook handler
- [ ] HTML email templates (React Email)

**Email Flows:**
- [ ] Email confirmations
- [ ] Email reminders
- [ ] Review request emails
- [ ] Unsubscribe handling

**CAN-SPAM Compliance:**
- [ ] Physical address footer
- [ ] Unsubscribe mechanism
- [ ] Subject line validation

**Testing:**
- [ ] Email delivery verification
- [ ] Unsubscribe flow test
- [ ] CAN-SPAM compliance test

---

### Phase 4: Rescheduling System (Week 7-8)

**Slot Finding:**
- [ ] Integrate with availability queries
- [ ] Conflict detection
- [ ] Next-3-slots algorithm
- [ ] Timezone handling

**Rescheduling Conversation:**
- [ ] Conversation state machine
- [ ] Options presentation
- [ ] Selection parsing
- [ ] Confirmation flow

**Escalation:**
- [ ] No-slots escalation
- [ ] Failed reschedule escalation
- [ ] Admin notification

**Testing:**
- [ ] Rescheduling E2E test
- [ ] Escalation trigger test
- [ ] Slot finding accuracy test

---

### Phase 5: Review System (Week 9-10)

**Review Request Flow:**
- [ ] Completion trigger detection
- [ ] Delayed review request job
- [ ] Review reminder job
- [ ] Link generation and tracking

**Platform Integration:**
- [ ] Google Reviews link
- [ ] Facebook Reviews link
- [ ] Yelp Reviews link
- [ ] Review tracking

**Testing:**
- [ ] Review request timing test
- [ ] Link validity test
- [ ] Response tracking test

---

### Phase 6: Escalation System (Week 11-12)

**Escalation Creation:**
- [ ] Escalation task creation
- [ ] Assignment logic
- [ ] Notification system
- [ ] Admin queue UI endpoints

**Escalation Management:**
- [ ] Claim/assign workflow
- [ ] Resolution handling
- [ ] Customer notification
- [ ] Follow-up tracking

**Escalation Dashboard:**
- [ ] List/filter escalations
- [ ] Priority sorting
- [ ] SLA tracking
- [ ] Resolution metrics

**Testing:**
- [ ] Escalation creation test
- [ ] Assignment algorithm test
- [ ] Notification delivery test

---

### Phase 7: Compliance & Quality (Week 13-14)

**TCPA Compliance:**
- [ ] Consent tracking
- [ ] Opt-out handling
- [ ] Hours restriction
- [ ] Disclaimer injection

**CAN-SPAM Compliance:**
- [ ] Address footer
- [ ] Unsubscribe system
- [ ] Header validation

**Quality Monitoring:**
- [ ] Message validation
- [ ] Grammar checking
- [ ] Link validation
- [ ] Quality dashboard

**Testing:**
- [ ] Compliance validation tests
- [ ] Opt-out flow tests
- [ ] Quality check accuracy tests

---

### Phase 8: Admin Dashboard (Week 15-16)

**Communication Management UI:**
- [ ] Jobs list with filters
- [ ] Template editor
- [ ] Manual message composer
- [ ] Delivery metrics

**Escalation Queue UI:**
- [ ] Pending escalations list
- [ ] Claim/resolve interface
- [ ] Customer context panel
- [ ] Response templates

**Analytics & Reporting:**
- [ ] Delivery rate metrics
- [ ] Response rate metrics
- [ ] Escalation frequency
- [ ] Channel performance

**Testing:**
- [ ] UI component tests
- [ ] Admin permission tests
- [ ] E2E dashboard tests

---

### Phase 9: Repeat Business Automation (Week 17-18)

**Maintenance Reminders:**
- [ ] Equipment-based triggers
- [ ] Interval calculation
- [ ] Batch scheduling
- [ ] Throttling

**Seasonal Campaigns:**
- [ ] Pre-season AC check
- [ ] Pre-season furnace check
- [ ] Customer segmentation
- [ ] Campaign management UI

**Win-Back Campaign:**
- [ ] Inactivity detection
- [ ] Campaign templates
- [ ] Offer integration
- [ ] Response tracking

**Testing:**
- [ ] Maintenance reminder timing test
- [ ] Campaign segmentation test
- [ ] Batch throttling test

---

### Phase 10: Hardening & Polish (Week 19-20)

**Performance:**
- [ ] Database query optimization
- [ ] Job queue throughput
- [ ] Template caching
- [ ] Webhook handling capacity

**Reliability:**
- [ ] Retry logic refinement
- [ ] Dead letter queue
- [ ] Circuit breakers
- [ ] Graceful degradation

**Monitoring:**
- [ ] OpenTelemetry instrumentation
- [ ] Alert configuration
- [ ] Dashboard metrics
- [ ] Error tracking

**Documentation:**
- [ ] API documentation
- [ ] Admin guide
- [ ] Integration guide
- [ ] Troubleshooting guide

**Final Testing:**
- [ ] Load testing
- [ ] Security audit
- [ ] Compliance audit
- [ ] E2E scenario tests

---

## Success Criteria

**Functional Requirements:**
- [ ] 95%+ delivery rate for SMS confirmations
- [ ] 90%+ delivery rate for email confirmations
- [ ] <5 minutes average time from appointment scheduling to confirmation sent
- [ ] <1 hour average resolution time for escalated issues
- [ ] 0 TCPA/CAN-SPAM compliance violations
- [ ] 100% of opt-outs processed within 24 hours

**Business Metrics:**
- [ ] 30%+ reduction in no-shows (from reminders)
- [ ] 20%+ increase in review collection rate
- [ ] 15%+ increase in repeat business (from campaigns)
- [ ] <10% escalation rate for automated conversations
- [ ] 80%+ resolution rate for escalated issues within SLA

**Technical Metrics:**
- [ ] <500ms average job execution time
- [ ] 99.9% webhook processing success rate
- [ ] <5 second processing time for cron jobs
- [ ] Zero data loss (all communications persisted)
- [ ] 100% audit trail coverage

---

## Appendix A: Template Variable Reference

**Organization Variables:**
- `{{organization.name}}` - Company name
- `{{organization.phone}}` - Business phone
- `{{organization.logoUrl}}` - Logo URL (email)

**Customer Variables:**
- `{{customer.firstName}}` - First name
- `{{customer.lastName}}` - Last name
- `{{customer.fullName}}` - Full name

**Appointment Variables:**
- `{{appointment.referenceNumber}}` - Service request ID
- `{{appointment.date}}` - Formatted date
- `{{appointment.timeWindow}}` - Time range
- `{{appointment.serviceType}}` - Issue type
- `{{appointment.address}}` - Service address
- `{{appointment.technicianName}}` - Assigned tech
- `{{appointment.isAfterHours}}` - Boolean flag

**Link Variables:**
- `{{links.confirm}}` - Confirm action URL
- `{{links.reschedule}}` - Reschedule URL
- `{{links.cancel}}` - Cancel URL
- `{{links.calendar}}` - Calendar view URL
- `{{links.reviewGoogle}}` - Google Review URL
- `{{links.reviewFacebook}}` - Facebook Review URL
- `{{links.reviewYelp}}` - Yelp Review URL

**Business Variables:**
- `{{business.address}}` - Business address
- `{{business.phone}}` - Business phone
- `{{business.hours}}` - Business hours
- `{{business.serviceArea}}` - Service area

---

## Appendix B: Error Handling Reference

**Error Categories:**

**E1: Template Errors**
- `TEMPLATE_NOT_FOUND` - Template key doesn't exist
- `TEMPLATE_RENDER_FAILED` - Handlebars/React rendering error
- `MISSING_VARIABLE` - Required variable not provided
- `VARIABLE_TYPE_ERROR` - Variable type mismatch

**E2: Delivery Errors**
- `CHANNEL_NOT_AVAILABLE` - No working channel for customer
- `RECIPIENT_INVALID` - Phone/email format invalid
- `CONSENT_DENIED` - No consent for communication
- `HOURS_RESTRICTION` - Outside allowed hours
- `OPTED_OUT` - Customer has opted out
- `PROVIDER_ERROR` - Twilio/Resend API error
- `RATE_LIMITED` - Provider rate limit exceeded

**E3: State Errors**
- `CONFLICTED_RESERVATION` - Slot no longer available
- `CANCELLED_APPOINTMENT` - Appointment was cancelled
- `DUPLICATE_JOB` - Job already exists
- `STATE_TRANSITION_INVALID` - Illegal state change

**Error Handling Strategy:**

```typescript
// src/lib/communication/errors.ts

export class CommunicationError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CommunicationError';
  }
}

export async function handleCommunicationError(
  error: CommunicationError,
  job: CommunicationJob
): Promise<ErrorResolution> {
  // Log error
  logger.error({ error, jobId: job.id }, 'Communication job failed');
  
  // Update job record
  await db.update(communicationJobs)
    .set({
      status: 'failed',
      lastError: `${error.code}: ${error.message}`,
      deliveryAttempts: job.deliveryAttempts + 1,
    })
    .where(eq(communicationJobs.id, job.id));
  
  // Determine resolution based on error code
  switch (error.code) {
    case 'CONSENT_DENIED':
    case 'OPTED_OUT':
      // Permanent failure - don't retry
      return { action: 'permanent_failure' };
    
    case 'HOURS_RESTRICTION':
      // Reschedule for appropriate time
      return await rescheduleForAllowedHours(job);
    
    case 'TEMPLATE_NOT_FOUND':
    case 'MISSING_VARIABLE':
      // Use fallback template
      return await useFallbackTemplate(job);
    
    case 'CHANNEL_NOT_AVAILABLE':
    case 'PROVIDER_ERROR':
    case 'RATE_LIMITED':
      // Retry with exponential backoff
      return await scheduleRetry(job);
    
    default:
      // Create escalation for manual review
      return await createEscalation(job, 'delivery_failure');
  }
}
```

---

## Appendix C: Security Considerations

**PII Handling:**
- All customer PII encrypted at rest
- Template context never contains full PII
- Logs sanitize phone numbers, emails, addresses
- Webhook payloads validated and sanitized

**Action Links:**
- Short-lived tokens (expire in 7 days)
- Single-use tokens
- IP rate limiting on action endpoints
- CSRF protection on all action forms

**Webhook Security:**
- Verify Twilio signature on SMS webhooks
- Verify Resend signature on email webhooks
- Rate limit webhook endpoints
- Validate all incoming data

**API Security:**
- Admin endpoints require authentication
- Organization-scoped access control
- Audit logging for all mutations
- Rate limiting on all endpoints

**Template Security:**
- Admin-only template editing
- Template approval workflow
- No arbitrary code execution
- XSS prevention in email HTML

---

## Appendix D: Monitoring & Alerting

**Key Metrics:**

**Delivery Metrics:**
- SMS delivery rate (target: >95%)
- Email delivery rate (target: >90%)
- Message latency (p50, p95, p99)
- Delivery failure rate by error type

**Engagement Metrics:**
- Confirmation response rate
- Reschedule completion rate
- Review request click-through rate
- Review submission rate
- Opt-out rate

**Escalation Metrics:**
- Escalation creation rate
- Escalation resolution time
- Escalation by reason category
- Resolution rate by priority

**System Health:**
- Job queue depth
- Job execution latency
- Webhook processing lag
- Template cache hit rate
- Database query performance

**Alerts:**

**Critical (Page immediately):**
- Delivery rate <80% for 5 minutes
- Job queue depth >1000
- Webhook processing failure rate >10%
- Database connection failures

**Warning (Investigate within 1 hour):**
- Escalation rate spike (>2x baseline)
- Template rendering errors
- Opt-out rate spike
- Provider rate limit hit

**Info (Review daily):**
- Delivery metrics trends
- New compliance issues
- Template performance
- Channel preference shifts

---

**End of Specification**

This specification provides the complete technical foundation for implementing Stage C: Communication Automation. Use this document as the basis for creating detailed implementation plans with the `superpowers:writing-plans` skill.
