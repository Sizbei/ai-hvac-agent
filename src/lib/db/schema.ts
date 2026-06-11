import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  pgEnum,
  index,
  uniqueIndex,
  varchar,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Enums
export const sessionStatusEnum = pgEnum("session_status", [
  "chatting",
  "extracting",
  "confirmed",
  "submitted",
  "escalated",
  "abandoned",
]);

export const messageRoleEnum = pgEnum("message_role", [
  "user",
  "assistant",
  "system",
]);

export const urgencyEnum = pgEnum("urgency", [
  "low",
  "medium",
  "high",
  "emergency",
]);

export const requestStatusEnum = pgEnum("request_status", [
  "pending",
  "assigned",
  // Booked with an arrival window, before/independent of a tech actively
  // working it (ServiceTitan "Scheduled").
  "scheduled",
  "in_progress",
  // Paused — waiting on parts, a customer callback, access, etc. Resumable.
  "on_hold",
  "completed",
  "cancelled",
]);

// The medium a conversation came in over. "web" = the embeddable chat widget
// (the default for every pre-existing session); "phone" = a voice call and
// "sms" = an inbound text message, both handled by the telephone sub-agent
// (Twilio). Drives the admin channel badge/filter and which system-prompt
// persona the agent uses.
export const sessionChannelEnum = pgEnum("session_channel", ["web", "phone", "sms"]);

// ── ServiceTitan-style intake enums (comprehensive intake overhaul) ──
// Work classification, distinct from the customer-language `issueType` symptom.
// Mirrors ServiceTitan's HVAC job-type taxonomy.
export const jobTypeEnum = pgEnum("job_type", [
  "service_call",
  "no_heat",
  "no_cool",
  "maintenance",
  "install",
  "estimate",
  "warranty",
  "diagnostic",
  "inspection",
]);

// Customer class — drives priority, pricing language, and assistant persona.
export const customerTypeEnum = pgEnum("customer_type", [
  "residential",
  "commercial",
]);

// Membership / service-agreement status (ServiceTitan memberships model).
export const membershipStatusEnum = pgEnum("membership_status", [
  "none",
  "active",
  "suspended",
  "expired",
  "cancelled",
]);

// Marketing attribution — the one lead field an owner actually reads.
export const leadSourceEnum = pgEnum("lead_source", [
  "google",
  "facebook",
  "yelp",
  "referral",
  "repeat_customer",
  "website",
  "direct_mail",
  "other",
]);

// The HVAC system the issue concerns — routing + parts prep.
export const systemTypeEnum = pgEnum("system_type", [
  "central_ac",
  "furnace",
  "heat_pump",
  "mini_split",
  "boiler",
  "packaged_unit",
  "other",
]);

// Property class for the service location.
export const propertyTypeEnum = pgEnum("property_type", [
  "residential",
  "commercial",
]);

// Coarse equipment-age band — drives repair-vs-replace routing without
// requiring an exact install date the customer rarely knows.
export const equipmentAgeBandEnum = pgEnum("equipment_age_band", [
  "under_5",
  "5_to_10",
  "10_to_15",
  "over_15",
  "unknown",
]);

// Whether the system is completely down or partly working — triage signal.
export const systemDownStatusEnum = pgEnum("system_down_status", [
  "fully_down",
  "partially_working",
  "unknown",
]);

// Owner-occupant vs renter — payment authority (renters may need landlord ok).
export const ownerOccupantEnum = pgEnum("owner_occupant", [
  "owner",
  "renter",
  "unknown",
]);

// Tri-state for yes/no fields the customer may not know.
export const triStateEnum = pgEnum("tri_state", ["yes", "no", "unknown"]);

// Preferred arrival window (we capture intent; dispatch confirms the exact time).
export const preferredWindowEnum = pgEnum("preferred_window", [
  "morning",
  "afternoon",
  "evening",
  "asap",
]);

// Preferred contact channel for confirmation/follow-up.
export const contactPreferenceEnum = pgEnum("contact_preference", [
  "call",
  "text",
]);

// Why a request is on hold (ServiceTitan hold/cancel reason codes). Set when a
// dispatcher pauses a job so the queue shows what it's waiting on.
export const holdReasonEnum = pgEnum("hold_reason", [
  "awaiting_parts",
  "awaiting_customer",
  "awaiting_access",
  "weather",
  "other",
]);

// Invoice / payment status synced from Housecall Pro invoice.* webhooks.
// 'none' until HCP sends the first invoice event for the job's request; then
// 'sent' (invoice.sent), 'paid' (invoice.paid), or 'void' (invoice.voided).
// (Stage 4 of the HCP integration.)
export const invoiceStatusEnum = pgEnum("invoice_status", [
  "none",
  "sent",
  "paid",
  "void",
]);

// 1. organizations
export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// 2. users (admin staff / technicians)
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    email: text("email").notNull(),
    name: text("name").notNull(),
    // Nullable: a Google-only (OIDC) user has no password. A NULL hash means
    // password login is IMPOSSIBLE for this user — the login route must treat it
    // as ineligible and never pass NULL to bcrypt.compare as the stored hash.
    passwordHash: text("password_hash"),
    // Set when an admin links "Sign in with Google". Unique so one Google
    // account maps to at most one user row.
    googleId: text("google_id"),
    role: text("role", { enum: ["super_admin", "admin", "technician"] })
      .notNull()
      .default("technician"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("users_org_id_idx").on(table.organizationId),
    index("users_email_idx").on(table.email),
    // Email is unique PER ORGANIZATION. This is the authoritative guard behind
    // createStaff's read-then-insert pre-check (which races under concurrency)
    // and it makes the email→row mapping unambiguous within an org, which the
    // password-login and Google-OIDC lookups rely on. NOT globally unique: the
    // same email may legitimately exist in two different tenants.
    uniqueIndex("users_org_email_unique").on(
      table.organizationId,
      table.email,
    ),
    // One Google account ↔ one user. Partial (WHERE google_id IS NOT NULL) so
    // the many password-only rows (NULL google_id) never collide.
    uniqueIndex("users_google_id_unique")
      .on(table.googleId)
      .where(sql`${table.googleId} IS NOT NULL`),
  ],
);

// 2b. staff_invites — tokenized invitations to join an organization as staff.
// An admin creates an invite for an email + role; the recipient opens a
// one-time link, sets a name + password, and a user row is created. The token
// is stored HASHED (SHA-256) at rest — the plaintext is embedded in the link
// ONCE at creation and is unrecoverable afterward (mirrors widget_keys). An
// invite can never grant `super_admin` (only admin/technician). Single-use
// (accepted_at), expiring (72h), and revocable (revoked_at).
export const staffInvites = pgTable(
  "staff_invites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    // Normalized (trim + lowercase) at creation so it matches how users.email
    // is stored and how the accept flow's collision check resolves.
    email: text("email").notNull(),
    // Only admin/technician — super_admin is NEVER invitable. The accept flow
    // takes the new user's role from THIS column, never from request input.
    role: text("role", { enum: ["admin", "technician"] }).notNull(),
    // SHA-256 hex of the full invite token. Unique so a presented token maps to
    // exactly one row. The plaintext token is shown once and never stored.
    tokenHash: text("token_hash").notNull().unique(),
    invitedByUserId: uuid("invited_by_user_id")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Set when the invite is consumed → single-use. NULL while pending.
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    // Set when an admin revokes the invite. NULL while live.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("staff_invites_org_id_idx").on(table.organizationId),
    index("staff_invites_token_hash_idx").on(table.tokenHash),
    // At most ONE live (un-accepted, un-revoked) invite per org+email, so an
    // admin can't pile up duplicate pending invites and a double-accept can't
    // create two users. Expiry is time-based and intentionally NOT in this
    // partial predicate — an expired-but-not-revoked invite is treated as
    // re-invitable by the query layer (it filters expiry at read time).
    uniqueIndex("staff_invites_live_unique")
      .on(table.organizationId, table.email)
      .where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`),
  ],
);

// 3. customer_sessions
export const customerSessions = pgTable(
  "customer_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    token: text("token").notNull().unique(),
    status: sessionStatusEnum("status").notNull().default("chatting"),
    tokensUsed: integer("tokens_used").notNull().default(0),
    tokenBudget: integer("token_budget").notNull().default(10000),
    turnCount: integer("turn_count").notNull().default(0),
    // Max conversation turns before the bot wraps up. Stamped from the org's
    // chatMaxTurns config at creation (or the system default). Per-session so
    // the chat hot path reads it off the loaded row, not a config lookup.
    maxTurns: integer("max_turns").notNull().default(15),
    // The medium this conversation arrived over (see sessionChannelEnum).
    // Defaults to "web" so every existing row reads as a widget chat.
    channel: sessionChannelEnum("channel").notNull().default("web"),
    metadata: text("metadata"),
    // Rolling summary of turns that have aged out of the model's sliding
    // window. Lets a long conversation stay coherent without re-sending the
    // full transcript every turn. NULL until the conversation first exceeds the
    // window. Written by the background compaction task.
    runningSummary: text("running_summary"),
    // The repeat customer this session resolved to, once a contact slot (email
    // or phone) matches an existing customer via blind-index lookup. NULL for
    // anonymous sessions and for sessions that never link to a known customer.
    // Forward reference to `customers` (declared later in this file) — same
    // thunk-FK pattern as serviceRequests.customerId.
    customerId: uuid("customer_id").references(() => customers.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    index("sessions_org_id_idx").on(table.organizationId),
    index("sessions_token_idx").on(table.token),
    index("sessions_status_idx").on(table.status),
    index("sessions_org_created_idx").on(table.organizationId, table.createdAt),
    // The admin Conversations view filters by channel within an org.
    index("sessions_org_channel_idx").on(table.organizationId, table.channel),
    // Look up a customer's prior sessions, and back the load-time
    // do-not-service / returning-customer checks off the resolved link.
    index("sessions_customer_id_idx").on(table.customerId),
  ],
);

// 4. messages
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => customerSessions.id),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    tokensUsed: integer("tokens_used"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("messages_org_id_idx").on(table.organizationId),
    index("messages_session_id_idx").on(table.sessionId),
    index("messages_session_created_idx").on(table.sessionId, table.createdAt),
  ],
);

// 5. service_requests
export const serviceRequests = pgTable(
  "service_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => customerSessions.id),
    customerId: uuid("customer_id").references(() => customers.id),
    assignedTo: uuid("assigned_to").references(() => users.id),
    status: requestStatusEnum("status").notNull().default("pending"),
    issueType: text("issue_type").notNull(),
    urgency: urgencyEnum("urgency").notNull(),
    description: text("description").notNull(),
    // ── ServiceTitan-style intake fields (all nullable; intake fills when known) ──
    // Work classification, distinct from the customer-language issueType symptom.
    jobType: jobTypeEnum("job_type"),
    // The HVAC system the issue concerns.
    systemType: systemTypeEnum("system_type"),
    equipmentBrand: text("equipment_brand"),
    equipmentAgeBand: equipmentAgeBandEnum("equipment_age_band"),
    propertyType: propertyTypeEnum("property_type"),
    ownerOccupant: ownerOccupantEnum("owner_occupant"),
    underWarranty: triStateEnum("under_warranty"),
    // Free-text access notes — gate code, pets, parking, unit location.
    accessNotes: text("access_notes"),
    // Triage signals.
    systemDownStatus: systemDownStatusEnum("system_down_status"),
    problemDuration: text("problem_duration"),
    vulnerableOccupants: boolean("vulnerable_occupants"),
    // Scheduling: a preferred window (dispatch confirms the exact time). The
    // resolved window start/end are set by dispatch; preferredWindow is the
    // customer's stated preference captured at intake.
    preferredWindow: preferredWindowEnum("preferred_window"),
    arrivalWindowStart: timestamp("arrival_window_start", { withTimezone: true }),
    arrivalWindowEnd: timestamp("arrival_window_end", { withTimezone: true }),
    // Why a job is paused + when to revisit (set on an on_hold transition).
    holdReason: holdReasonEnum("hold_reason"),
    followUpDate: timestamp("follow_up_date", { withTimezone: true }),
    // Communication.
    contactPreference: contactPreferenceEnum("contact_preference"),
    smsConsent: boolean("sms_consent"),
    // Marketing attribution.
    leadSource: leadSourceEnum("lead_source"),
    // After-hours: whether the request arrived outside business hours (per the
    // org's configured window). Flagged once at confirm time so dispatch and the
    // dashboard read it off the row. There is NO stored dollar surcharge — the
    // business charges based on the actual work done, not a fixed fee.
    isAfterHours: boolean("is_after_hours").notNull().default(false),
    customerNameEncrypted: text("customer_name_encrypted"),
    customerPhoneEncrypted: text("customer_phone_encrypted"),
    customerEmailEncrypted: text("customer_email_encrypted"),
    addressEncrypted: text("address_encrypted"),
    referenceNumber: varchar("reference_number", { length: 20 })
      .notNull()
      .unique(),
    // Housecall Pro job id this request maps to, once pushed. NULL until the org
    // is HCP-connected and a successful create-job has mirrored the booking to
    // HCP. Set once and treated idempotently: a re-push of an already-mapped
    // request UPDATEs the existing HCP job (reschedule/reassign) instead of
    // creating a duplicate; on cancel the HCP job is deleted but the id is left
    // for the audit trail. Plaintext (HCP's public resource id, not a secret).
    // (Stage 3 of the HCP integration.)
    hcpJobId: text("hcp_job_id"),
    // Invoice / payment status mirrored from HCP invoice.* webhooks, linked to
    // this request via hcpJobId. Defaults to 'none' (no invoice activity yet);
    // an invoice.sent/paid/voided event updates it so admins can see whether a
    // completed job has been invoiced/paid. (Stage 4 of the HCP integration.)
    invoiceStatus: invoiceStatusEnum("invoice_status").notNull().default("none"),
    scheduledDate: timestamp("scheduled_date", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("requests_org_id_idx").on(table.organizationId),
    index("requests_session_id_idx").on(table.sessionId),
    index("requests_status_idx").on(table.status),
    index("requests_ref_idx").on(table.referenceNumber),
    // The CRM joins service requests by customerId (request counts, last
    // service date, and cascade on customer delete) — index it to avoid a
    // full scan as the table grows.
    index("requests_customer_id_idx").on(table.customerId),
  ],
);

// 5b. request_notes — internal dispatcher notes on a service request.
// Distinct from `messages` (the customer-facing chat transcript): these are
// staff-only, never shown to the customer. Threaded/timestamped per author so
// the request carries its own audit of internal commentary.
export const requestNotes = pgTable(
  "request_notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => serviceRequests.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    authorId: uuid("author_id").references(() => users.id),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("request_notes_request_id_idx").on(table.requestId),
    index("request_notes_org_id_idx").on(table.organizationId),
  ],
);

// 6. customers (CRM)
export const equipmentTypeEnum = pgEnum("equipment_type", [
  "ac",
  "furnace",
  "heat_pump",
  "boiler",
  "mini_split",
  "thermostat",
  "other",
]);

export const noteTypeEnum = pgEnum("note_type", [
  "general",
  "follow_up",
  "complaint",
  "compliment",
]);

export const followUpStatusEnum = pgEnum("follow_up_status", [
  "pending",
  "completed",
  "overdue",
  "cancelled",
]);

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    nameEncrypted: text("name_encrypted").notNull(),
    phoneEncrypted: text("phone_encrypted"),
    emailEncrypted: text("email_encrypted"),
    addressEncrypted: text("address_encrypted"),
    // Keyed blind indexes (HMAC) over the NORMALIZED email/phone. The encrypted
    // columns above use a random IV per write and so can't be searched or
    // deduped; these deterministic hashes can. They back the unique indexes
    // below, which make customer dedupe atomic at the DB layer (concurrent
    // submits for the same contact collide instead of both inserting).
    emailHash: text("email_hash"),
    phoneHash: text("phone_hash"),
    propertyType: text("property_type"),
    propertySqft: integer("property_sqft"),
    notes: text("notes"),
    // ── ServiceTitan-style customer fields ──
    // Customer class (payer): residential vs commercial. Drives priority/persona.
    customerType: customerTypeEnum("customer_type").notNull().default("residential"),
    // Membership / service-agreement status; member-aware greeting + priority.
    membershipStatus: membershipStatusEnum("membership_status")
      .notNull()
      .default("none"),
    // When true the bot must refuse to book / warn (ServiceTitan "Do Not Service").
    doNotService: boolean("do_not_service").notNull().default(false),
    // Housecall Pro customer id this row maps to, once synced. NULL until the
    // org is HCP-connected and a successful find-or-create has mirrored the
    // customer to HCP. Set once and treated as idempotent: a re-sync of an
    // already-mapped customer is a no-op. (Stage 2 of the HCP integration.)
    hcpCustomerId: text("hcp_customer_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Soft-delete: when set, the customer is archived — hidden from the default
    // admin list but fully retained (reversible), as opposed to the permanent
    // DELETE. NULL = active.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    index("customers_org_id_idx").on(table.organizationId),
    // Unique per org: one customer row per email / per phone within a tenant.
    // Partial (WHERE ... IS NOT NULL) so the many rows lacking an email or
    // phone don't all collide on NULL.
    uniqueIndex("customers_org_email_hash_unique")
      .on(table.organizationId, table.emailHash)
      .where(sql`${table.emailHash} IS NOT NULL`),
    uniqueIndex("customers_org_phone_hash_unique")
      .on(table.organizationId, table.phoneHash)
      .where(sql`${table.phoneHash} IS NOT NULL`),
  ],
);

// 7. customer_equipment
export const customerEquipment = pgTable(
  "customer_equipment",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    equipmentType: equipmentTypeEnum("equipment_type").notNull(),
    make: text("make"),
    model: text("model"),
    serialNumber: text("serial_number"),
    installDate: timestamp("install_date", { withTimezone: true }),
    warrantyExpiration: timestamp("warranty_expiration", { withTimezone: true }),
    // ServiceTitan splits parts warranty (warrantyExpiration) from labor warranty.
    laborWarrantyExpiration: timestamp("labor_warranty_expiration", {
      withTimezone: true,
    }),
    locationInHome: text("location_in_home"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("equipment_customer_id_idx").on(table.customerId),
    index("equipment_org_id_idx").on(table.organizationId),
  ],
);

// 8. customer_notes
export const customerNotes = pgTable(
  "customer_notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    authorId: uuid("author_id").references(() => users.id),
    content: text("content").notNull(),
    noteType: noteTypeEnum("note_type").notNull().default("general"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("notes_customer_id_idx").on(table.customerId),
    index("notes_org_id_idx").on(table.organizationId),
  ],
);

// 9. follow_ups
export const followUps = pgTable(
  "follow_ups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    assignedTo: uuid("assigned_to").references(() => users.id),
    reason: text("reason").notNull(),
    dueDate: timestamp("due_date", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    status: followUpStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("followups_customer_id_idx").on(table.customerId),
    index("followups_org_id_idx").on(table.organizationId),
    index("followups_due_date_idx").on(table.dueDate),
    index("followups_status_idx").on(table.status),
  ],
);

// 10. service_history
export const serviceHistory = pgTable(
  "service_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    serviceRequestId: uuid("service_request_id").references(
      () => serviceRequests.id,
    ),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    workPerformed: text("work_performed"),
    partsUsed: text("parts_used"),
    cost: integer("cost"),
    technicianNotes: text("technician_notes"),
    followUpNeeded: boolean("follow_up_needed").notNull().default(false),
    followUpDate: timestamp("follow_up_date", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("history_customer_id_idx").on(table.customerId),
    index("history_org_id_idx").on(table.organizationId),
  ],
);

// 11. audit_log
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id").references(() => users.id),
    sessionId: uuid("session_id").references(() => customerSessions.id),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: uuid("entity_id"),
    details: text("details"),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("audit_org_id_idx").on(table.organizationId),
    index("audit_action_idx").on(table.action),
    index("audit_created_idx").on(table.createdAt),
  ],
);

// 12. organization_settings — per-org chatbot configuration (1:1 with org).
// One row per organization. Drives the customer-facing widget's branding, which
// services the bot will take, and the business-info answers used by canned FAQ
// responses. JSON columns keep the shape flexible without a migration per field.
export const organizationSettings = pgTable("organization_settings", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id),

  // ── Branding (widget look) ──
  companyName: text("company_name"),
  logoUrl: text("logo_url"),
  // Hex color (e.g. "#2563eb"), validated at the API boundary.
  primaryColor: varchar("primary_color", { length: 9 }),
  welcomeMessage: text("welcome_message"),
  launcherPosition: text("launcher_position"), // "bottom-right" | "bottom-left"

  // ── Widget security ──
  // Origins allowed to embed this org's widget (e.g. "https://acme.com",
  // "*.acme.com"). The public widget/session endpoints reflect CORS and accept
  // requests only from an origin matching this list. Empty = not yet locked
  // down (resolution then relies on the publishable key alone).
  allowedOrigins: jsonb("allowed_origins")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),

  // ── Services offered ──
  // issueType values the org does NOT handle (e.g. "installation"); the bot
  // declines/redirects instead of promising them. Stored as a JSON string array.
  disabledIssueTypes: jsonb("disabled_issue_types")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  // Knowledge-base intent categories the org does NOT offer (e.g. "boiler",
  // "commercial", "water_heater"); matching intents are suppressed/redirected.
  disabledServiceTags: jsonb("disabled_service_tags")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),

  // ── Business info (fills the per-tenant FAQ answers) ──
  // Flexible bag: serviceArea, businessHours, phone, licensedInsured,
  // financingAvailable, etc. Read by the router to personalize canned replies.
  businessInfo: jsonb("business_info")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),

  // ── Conversation limits (operational levers) ──
  // Per-org overrides for the AI token budget and max conversation turns,
  // stamped onto each new session at creation. NULL = use the system default
  // (DEFAULT_TOKEN_BUDGET / DEFAULT_MAX_TURNS). Bounded at the API layer.
  chatTokenBudget: integer("chat_token_budget"),
  chatMaxTurns: integer("chat_max_turns"),

  // ── After-hours window (ServiceTitan-style emergency/after-hours flagging) ──
  // Per-org detection window: { enabled, startHour, endHour,
  // weekendsAreAfterHours, timezone }. NULL = use the system default
  // (DEFAULT_AFTER_HOURS_CONFIG). Validated by afterHoursConfigSchema. No dollar
  // fee is stored — the charge depends on the actual work performed.
  afterHoursConfig: jsonb("after_hours_config").$type<Record<string, unknown>>(),

  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// 13. custom_faqs — admin-authored question→answer pairs (1:many per org).
// Augments the built-in deterministic catalog with company-specific answers.
export const customFaqs = pgTable(
  "custom_faqs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    // Lowercased trigger phrases the matcher checks (comma/JSON array). Kept
    // separate from `question` so admins can list multiple phrasings.
    triggers: jsonb("triggers")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("custom_faqs_org_id_idx").on(table.organizationId),
    index("custom_faqs_org_active_idx").on(
      table.organizationId,
      table.isActive,
    ),
  ],
);

// 15. technician_availability — recurring weekly working hours per technician.
// One row per technician per weekday SHIFT. `dayOfWeek` is 0=Sunday … 6=Saturday;
// `startMinute`/`endMinute` are minutes-from-midnight in the BUSINESS timezone
// (America/New_York), describing a recurring [start, end) wall-clock span — NOT
// UTC, because these are a weekly pattern ("Mon 8am–5pm") that the calendar
// layer resolves against a concrete date (handling DST) when it needs UTC.
// Multiple rows per tech/day are allowed, so a split shift is simply two rows.
//
// This is the NATIVE availability source today; an HCP-backed source can drop in
// later behind the scheduling-source seam (see lib/admin/scheduling-source.ts).
export const technicianAvailability = pgTable(
  "technician_availability",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => users.id),
    // 0=Sunday … 6=Saturday (JS Date.getDay() convention).
    dayOfWeek: integer("day_of_week").notNull(),
    // Minutes from midnight in the business timezone; [startMinute, endMinute).
    startMinute: integer("start_minute").notNull(),
    endMinute: integer("end_minute").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("tech_availability_org_id_idx").on(table.organizationId),
    index("tech_availability_org_tech_idx").on(
      table.organizationId,
      table.technicianId,
    ),
    index("tech_availability_org_tech_day_idx").on(
      table.organizationId,
      table.technicianId,
      table.dayOfWeek,
    ),
    // One row per (org, tech, weekday, shift START). setTechnicianAvailability
    // does a delete-then-insert REPLACE inside a db.batch; this unique index is
    // the DB-level guarantee that two slots can't collide on the same start (a
    // split shift differs by start, so it's still allowed) — making the swap
    // safe and rejecting an accidental duplicate insert.
    uniqueIndex("tech_availability_org_tech_day_start_unique").on(
      table.organizationId,
      table.technicianId,
      table.dayOfWeek,
      table.startMinute,
    ),
  ],
);

// 15. google_calendar_connections — per-org Google Calendar OAuth link.
// One row per organization (unique). The long-lived refresh token is stored
// ENCRYPTED (AES-256-GCM via @/lib/crypto); the short-lived access token + its
// expiry are a plaintext cache the client refreshes. `connected` lets an org
// disconnect (revoke) without deleting the row's history. Tokens are NEVER
// logged. `calendarId` is the target calendar ("primary" by default).
export const googleCalendarConnections = pgTable(
  "google_calendar_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    // Target calendar — "primary" or a specific calendar id.
    calendarId: text("calendar_id").notNull().default("primary"),
    // AES-256-GCM ciphertext of the OAuth refresh token. Never null while
    // connected; cleared (and connected=false) on disconnect.
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    // Short-lived access-token cache (plaintext, low-value, expires fast).
    accessToken: text("access_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    connected: boolean("connected").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("gcal_connections_org_id_idx").on(table.organizationId),
    // One Google Calendar connection per organization.
    uniqueIndex("gcal_connections_org_unique").on(table.organizationId),
  ],
);

// 16. housecall_pro_connections — per-org Housecall Pro (HCP) API link.
// One row per organization (unique). An HCP API key grants FULL account access,
// so it is stored ENCRYPTED (AES-256-GCM via @/lib/crypto), NEVER plaintext,
// NEVER logged. `accountInfo` caches non-secret metadata (company name, account
// id) for the settings panel only. `connected` lets an org disconnect (clear
// the key) without deleting the row's history.
export const housecallProConnections = pgTable(
  "housecall_pro_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    // AES-256-GCM ciphertext of the HCP API key. Never null while connected;
    // cleared (and connected=false) on disconnect.
    apiKeyEncrypted: text("api_key_encrypted"),
    // AES-256-GCM ciphertext of the per-org HCP WEBHOOK signing secret (the
    // value HCP shows when a webhook is configured for this account). Used to
    // verify inbound job-status webhooks (Stage 5). Optional: when null the
    // env-level HOUSECALL_WEBHOOK_SECRET is used instead, and when neither is
    // present the webhook endpoint rejects everything (fail closed). Never
    // logged. (Stage 5 of the HCP integration.)
    webhookSecretEncrypted: text("webhook_secret_encrypted"),
    // Non-secret account metadata cache (company name, account id) — display only.
    accountInfo: jsonb("account_info"),
    connected: boolean("connected").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("hcp_connections_org_id_idx").on(table.organizationId),
    // One Housecall Pro connection per organization.
    uniqueIndex("hcp_connections_org_unique").on(table.organizationId),
  ],
);

// 16b. hcp_webhook_events — IDEMPOTENCY ledger for inbound HCP webhooks.
// HCP retries webhook delivery, so the same event id can arrive more than once.
// We record each processed event id; the unique (org, event_id) index lets the
// handler insert-on-conflict-do-nothing and treat a zero-row insert as "already
// processed" — so a redelivery never applies a second status update. We persist
// only NON-secret metadata (the HCP event id + event type + the job id it
// referenced); never the raw payload or any secret. (Stage 5.)
export const hcpWebhookEvents = pgTable(
  "hcp_webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    // HCP's event id (the `id` field on the webhook envelope). Deduped per org.
    eventId: text("event_id").notNull(),
    // HCP event type, e.g. "job.completed" — stored for the audit trail only.
    eventType: text("event_type").notNull(),
    // The HCP job id the event referenced (may be null for non-job events we
    // still record as seen). Plaintext — HCP's public resource id, not a secret.
    hcpJobId: text("hcp_job_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("hcp_webhook_events_org_id_idx").on(table.organizationId),
    // One ledger row per (org, event id): the dedupe key the handler races on.
    uniqueIndex("hcp_webhook_events_org_event_unique").on(
      table.organizationId,
      table.eventId,
    ),
  ],
);

// 14. widget_keys — publishable/secret API keys for the embeddable widget.
// Keys are stored HASHED (SHA-256); the plaintext is shown once at creation.
// A publishable key resolves which org an embedded widget belongs to.
export const widgetKeys = pgTable(
  "widget_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    // SHA-256 hex of the full key. Unique so a presented key maps to one row.
    keyHash: text("key_hash").notNull().unique(),
    // Cleartext leading chars for display, e.g. "pk_live_a1b2c3d4".
    keyPrefix: text("key_prefix").notNull(),
    keyType: text("key_type", { enum: ["publishable", "secret"] }).notNull(),
    // Granted scopes (e.g. ["sessions:create","sessions:read"]).
    scopes: jsonb("scopes")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Optional admin label so a key can be recognized ("Production site").
    label: text("label"),
    isActive: boolean("is_active").notNull().default(true),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("widget_keys_org_id_idx").on(table.organizationId),
    index("widget_keys_hash_idx").on(table.keyHash),
  ],
);

// 17. attachments — file attachments (photos, documents) uploaded by customers.
// Display-only: customers upload once, attachments are shown in the chat transcript
// and admin view. No versioning or editing. Multi-tenant scoped by organizationId
// and linked to a session/message. The actual file is stored in R2/S3; this table
// stores only metadata.
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => customerSessions.id),
    messageId: uuid("message_id").references(() => messages.id),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(), // File size in bytes
    storageKey: text("storage_key").notNull(), // R2/S3 path key
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("attachments_org_id_idx").on(table.organizationId),
    index("attachments_session_id_idx").on(table.sessionId),
    index("attachments_message_id_idx").on(table.messageId),
  ],
);

// ── Custom Fields CRM System ──

// Entity types that can have custom fields
export const customFieldEntityTypeEnum = pgEnum("custom_field_entity_type", [
  "customer",
  "service_request",
  "both",
]);

// Field data types for custom fields
export const customFieldTypeEnum = pgEnum("custom_field_type", [
  "text",
  "textarea",
  "select",
  "multiselect",
  "number",
  "currency",
  "date",
  "checkbox",
]);

// 18. custom_field_definitions — organization-defined field schemas
// One organization can define any number of custom fields to store beyond
// the built-in HVAC-specific fields. Each definition includes the field type,
// validation rules, and whether it applies to customers, service requests, or both.
export const customFieldDefinitions = pgTable(
  "custom_field_definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Machine-readable identifier (snake_case, matches regex ^[a-z][a-z0-9_]*$)
    key: varchar("key", { length: 100 }).notNull(),
    // Human-readable display name
    label: varchar("label", { length: 255 }).notNull(),
    description: text("description"),
    // Which entity type this field applies to
    entityType: customFieldEntityTypeEnum("entity_type").notNull(),
    // Data type of the field
    fieldType: customFieldTypeEnum("field_type").notNull(),
    // Allowed values for select/multiselect types
    options: jsonb("options")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    required: boolean("required").notNull().default(false),
    placeholder: text("placeholder"),
    defaultValue: jsonb("default_value"),
    // Validation rules (min/max/length/pattern) encoded as JSON
    validation: jsonb("validation").$type<Record<string, unknown>>(),
    displayOrder: integer("display_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("custom_field_defs_org_id_idx").on(table.organizationId),
    // Active fields per org + entity type — the primary lookup for form rendering
    index("custom_field_defs_org_entity_active_idx").on(
      table.organizationId,
      table.entityType,
      table.isActive,
    ),
    // Unique key per org (only among active fields; archived fields can collide)
    uniqueIndex("custom_field_defs_org_key_unique")
      .on(table.organizationId, table.key)
      .where(sql`${table.isActive} = true`),
  ],
);

// 19. custom_field_values — actual field values per entity
// Stores the value of each custom field for each customer/service request.
// One row per (field_definition, entity_type, entity_id).
export const customFieldValues = pgTable(
  "custom_field_values",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fieldDefinitionId: uuid("field_definition_id")
      .notNull()
      .references(() => customFieldDefinitions.id, { onDelete: "cascade" }),
    entityType: customFieldEntityTypeEnum("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    // The actual value, typed according to the field definition
    value: jsonb("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("custom_field_values_org_id_idx").on(table.organizationId),
    index("custom_field_values_field_def_idx").on(table.fieldDefinitionId),
    // Lookup all values for a specific entity (customer or service request)
    index("custom_field_values_entity_idx").on(
      table.entityType,
      table.entityId,
    ),
    // One value per field per entity — prevents duplicates
    uniqueIndex("custom_field_values_field_entity_unique").on(
      table.fieldDefinitionId,
      table.entityType,
      table.entityId,
    ),
  ],
);

// ── Ghost CSR: Communication Automation Foundation ──

// Communication channel types
export const communicationChannelEnum = pgEnum("communication_channel", [
  "sms",
  "email",
  "voice",
]);

// Message/trigger types (events that can initiate a communication)
export const communicationTriggerTypeEnum = pgEnum("communication_trigger_type", [
  "appointment_scheduled",
  "appointment_reminder_24h",
  "appointment_reminder_2h",
  "appointment_rescheduled",
  "appointment_cancelled",
  "technician_enroute",
  "technician_arrived",
  "job_completed",
  "review_request",
  "follow_up",
  "escalation",
]);

// Job execution status
export const communicationJobStatusEnum = pgEnum("communication_job_status", [
  "pending",
  "processing",
  "sent",
  "failed",
  "cancelled",
]);

// Template types (determines rendering engine)
export const communicationTemplateTypeEnum = pgEnum("communication_template_type", [
  "sms",
  "email_html",
  "email_text",
]);

// 20. communication_templates — reusable message templates for automated customer communications
// Per-organization templates for each communication trigger type
export const communicationTemplates = pgTable(
  "communication_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 100 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    triggerType: communicationTriggerTypeEnum("trigger_type").notNull(),
    templateType: communicationTemplateTypeEnum("template_type").notNull(),
    // For email templates only
    subjectTemplate: text("subject_template"),
    // The message body (Handlebars for SMS, React Email for HTML)
    bodyTemplate: text("body_template").notNull(),
    // Available variables for template rendering
    variables: jsonb("variables")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    isActive: boolean("is_active").notNull().default(true),
    // Lower = higher priority (0-100, default 50)
    priority: integer("priority").notNull().default(50),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("communication_templates_org_id_idx").on(table.organizationId),
    index("communication_templates_org_trigger_active_idx").on(
      table.organizationId,
      table.triggerType,
      table.isActive,
    ),
    uniqueIndex("communication_templates_org_key_unique").on(
      table.organizationId,
      table.key,
    ),
  ],
);

// 21. communication_jobs — queue of pending/completed communication jobs
// Each job represents a single communication to be sent or already sent
export const communicationJobs = pgTable(
  "communication_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    templateId: uuid("template_id")
      .notNull()
      .references(() => communicationTemplates.id, { onDelete: "cascade" }),
    triggerType: communicationTriggerTypeEnum("trigger_type").notNull(),
    channel: communicationChannelEnum("channel").notNull(),
    status: communicationJobStatusEnum("status").notNull().default("pending"),
    // Lower = higher priority (0-100, default 50)
    priority: integer("priority").notNull().default(50),

    // Recipient information
    recipientPhone: varchar("recipient_phone", { length: 20 }),
    recipientEmail: text("recipient_email"),

    // Context data for template rendering
    templateVariables: jsonb("template_variables")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    // Execution tracking
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    errorMessage: text("error_message"),

    // External IDs (provider message IDs)
    externalId: varchar("external_id", { length: 255 }),

    // Related entities (optional, for tracking/queries)
    customerId: uuid("customer_id"),
    serviceRequestId: uuid("service_request_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("communication_jobs_org_id_idx").on(table.organizationId),
    // Index for job processor: pending/failed jobs ordered by scheduled time
    index("communication_jobs_status_scheduled_idx").on(
      table.status,
      table.scheduledFor,
    ).where(sql`${table.status} IN ('pending', 'failed')`),
    // Indexes for related entity lookups
    index("communication_jobs_service_request_idx").on(table.serviceRequestId),
    index("communication_jobs_customer_idx").on(table.customerId),
    // Index for webhook correlation (Twilio message SID, etc.)
    index("communication_jobs_external_id_idx").on(table.externalId),
  ],
);

// 22. communication_preferences — per-customer communication preferences
// One row per customer per organization (customers can exist across multiple orgs)
export const communicationPreferences = pgTable(
  "communication_preferences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").notNull(),

    // Channel preferences
    smsEnabled: boolean("sms_enabled").notNull().default(true),
    emailEnabled: boolean("email_enabled").notNull().default(true),
    voiceEnabled: boolean("voice_enabled").notNull().default(false),

    // Specific communication type preferences
    appointmentReminders: boolean("appointment_reminders").notNull().default(true),
    automatedConfirmations: boolean("automated_confirmations")
      .notNull()
      .default(true),
    reviewRequests: boolean("review_requests").notNull().default(true),
    marketingMessages: boolean("marketing_messages").notNull().default(false),

    // Timezone for scheduling (defaults to Eastern time)
    timezone: varchar("timezone", { length: 50 }).default("America/New_York"),

    // Global opt-out flag
    doNotContact: boolean("do_not_contact").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("communication_prefs_org_id_idx").on(table.organizationId),
    // One preference record per customer per organization
    uniqueIndex("communication_prefs_org_customer_unique").on(
      table.organizationId,
      table.customerId,
    ),
  ],
);
