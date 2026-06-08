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
// (the default for every pre-existing session); "phone" = a voice call handled
// by the telephone sub-agent (Twilio). Drives the admin channel badge/filter
// and which system-prompt persona the agent uses.
export const sessionChannelEnum = pgEnum("session_channel", ["web", "phone"]);

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
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["admin", "technician"] })
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
    // Communication.
    contactPreference: contactPreferenceEnum("contact_preference"),
    smsConsent: boolean("sms_consent"),
    // Marketing attribution.
    leadSource: leadSourceEnum("lead_source"),
    customerNameEncrypted: text("customer_name_encrypted"),
    customerPhoneEncrypted: text("customer_phone_encrypted"),
    customerEmailEncrypted: text("customer_email_encrypted"),
    addressEncrypted: text("address_encrypted"),
    referenceNumber: varchar("reference_number", { length: 20 })
      .notNull()
      .unique(),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
