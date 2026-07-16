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
  doublePrecision,
  date,
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

// AI-classified outcome of a conversation (Stage 3). Distinct from session
// `status` (the live state machine) — this is the post-hoc "what happened".
export const sessionOutcomeEnum = pgEnum("session_outcome", [
  "booked",
  "escalated",
  "info_provided",
  "abandoned",
  "unresolved",
]);

// Who is driving a conversation (Stage 4). "human" suppresses the AI auto-reply
// in the inbound webhook so a CSR can take over a thread.
export const sessionModeEnum = pgEnum("session_mode", ["ai", "human"]);

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

// Availability sync status from Fieldpulse FSM.
// Tracks the state of the background job that syncs technician availability.
export const availabilitySyncStatusEnum = pgEnum("availability_sync_status", [
  "pending",
  "in_progress",
  "completed",
  "failed",
]);

// Lifecycle state of a tenant org. "active" is the default. The other states
// drive Stage 10 SaaS-billing/entitlement gating:
//   - "trial":     pre-payment grace period (treated as active by isOrgActive).
//   - "past_due":  a subscription payment failed; the org is in dunning and is
//                  treated as NOT active (banner shown, seat gate enforced).
//   - "suspended": the subscription was cancelled/deleted; NOT active.
// Provisioning always creates an org as "active".
export const orgStatusEnum = pgEnum("org_status", [
  "active",
  "suspended",
  "trial",
  "past_due",
]);

// 1. organizations
export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  // Tenant lifecycle state. Defaults to "active" so every existing row
  // (and the demo org) is active without a backfill.
  status: orgStatusEnum("status").notNull().default("active"),
  // The user id of the PLATFORM admin who provisioned this org (null for the
  // seeded demo org and any org created before provisioning existed). Not a FK:
  // the creator is a cross-org actor that need not live in this org's user set.
  createdBy: uuid("created_by"),
  // The intended first owner's email, captured at provisioning so we know who
  // the org belongs to even before they accept their invite. Normalized
  // (trim+lowercase). PII — never emitted in audit details.
  ownerEmail: text("owner_email"),
  // --- Stage 10: SaaS billing (platform subscription) ---
  // The billing plan tier id (see src/lib/billing/plans.ts). NULL means the org
  // is on the default/free tier — every existing row stays free without a
  // backfill. Not an enum: plans are version-controlled config, not a DB enum,
  // so new tiers ship without a migration.
  plan: text("plan"),
  // The billing provider's customer id (Stripe customer). NULL until the org
  // first opens checkout. Not a secret (a provider-side opaque handle).
  stripeCustomerId: text("stripe_customer_id"),
  // The billing provider's subscription id. NULL until a subscription exists.
  subscriptionId: text("subscription_id"),
  // End of the current paid period (provider-reported). NULL when there is no
  // active subscription. Used to show "renews/ends on" and to reason about
  // grace; enforcement keys off `status`, not this timestamp.
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
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
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    // Nullable: a Google-only (OIDC) user has no password. A NULL hash means
    // password login is IMPOSSIBLE for this user — the login route must treat it
    // as ineligible and never pass NULL to bcrypt.compare as the stored hash.
    passwordHash: text("password_hash"),
    // Set when an admin links "Sign in with Google". Unique so one Google
    // account maps to at most one user row.
    googleId: text("google_id"),
    // The Fieldpulse user/technician id for rows synced from Fieldpulse. Stored
    // in its OWN column (not reusing google_id, whose unique index is GLOBAL —
    // Fieldpulse's small sequential ids collide across tenants). Uniqueness is
    // scoped per-org below.
    fieldpulseUserId: text("fieldpulse_user_id"),
    // Housecall Pro employee id for a synced technician. Same rationale as
    // fieldpulseUserId: HCP's opaque ids aren't globally unique, so uniqueness is
    // scoped per-org below (NOT global like google_id).
    housecallProUserId: text("housecall_pro_user_id"),
    role: text("role", { enum: ["super_admin", "admin", "technician"] })
      .notNull()
      .default("technician"),
    isActive: boolean("is_active").notNull().default(true),
    // A technician's hourly labor rate in integer cents/hour. Snapshotted onto a
    // time entry at clock-out so historical job-cost is immune to later rate
    // changes. NULL means "no rate set" — clock-out treats it as 0 (the entry's
    // laborCostCents is 0 until a rate exists).
    laborRateCents: integer("labor_rate_cents"),
    // ── Field location (autodispatch + live tracking) ──
    // The tech's home/start anchor for travel-aware autodispatch (NULL = fall
    // back to the business base). Plain coords — not blind-indexed; a tech's base
    // is not the same PII shape as a customer address.
    homeBaseLat: doublePrecision("home_base_lat"),
    homeBaseLng: doublePrecision("home_base_lng"),
    // Opt-in consent for live location sharing while on the clock. Capture is
    // refused server-side unless this is true; turning it off revokes (and the
    // ingest route stops accepting fixes).
    locationSharingEnabled: boolean("location_sharing_enabled")
      .notNull()
      .default(false),
    locationConsentUpdatedAt: timestamp("location_consent_updated_at", {
      withTimezone: true,
    }),
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
    // Email is also unique GLOBALLY (across all orgs). The app already treats
    // email as a single principal — both resolveGoogleLogin and the provisioning
    // paths look the email up cross-org with no org filter — so two concurrent
    // same-email signups (different Google subs) must not both provision. This
    // index makes that race a caught 23505, not a silent double-provision. The
    // per-org index above is kept (it's the indexed lookup the per-org email
    // checks rely on); this global index is the additional cross-org guard.
    uniqueIndex("users_email_global_unique").on(table.email),
    // One Google account ↔ one user. Partial (WHERE google_id IS NOT NULL) so
    // the many password-only rows (NULL google_id) never collide.
    uniqueIndex("users_google_id_unique")
      .on(table.googleId)
      .where(sql`${table.googleId} IS NOT NULL`),
    // Fieldpulse user id is unique PER ORG (not globally) — Fieldpulse assigns
    // small sequential ids that legitimately repeat across tenants.
    uniqueIndex("users_org_fieldpulse_user_id_unique")
      .on(table.organizationId, table.fieldpulseUserId)
      .where(sql`${table.fieldpulseUserId} IS NOT NULL`),
    // Housecall Pro employee id is unique PER ORG (not globally), same as the
    // Fieldpulse id — HCP ids are opaque and may repeat across tenants.
    uniqueIndex("users_org_hcp_user_id_unique")
      .on(table.organizationId, table.housecallProUserId)
      .where(sql`${table.housecallProUserId} IS NOT NULL`),
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
      .references(() => organizations.id, { onDelete: "cascade" }),
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
      .references(() => organizations.id, { onDelete: "cascade" }),
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
    // Stage 3: AI post-hoc recap + classified outcome + suggested next steps,
    // written by an after() LLM pass when the conversation closes. `summary` is
    // human-facing (distinct from runningSummary, the compaction working memory).
    summary: text("summary"),
    outcome: sessionOutcomeEnum("outcome"),
    nextSteps: jsonb("next_steps").$type<string[]>(),
    // Stage 4: ai = the bot auto-replies; human = a CSR has taken over the thread
    // and the inbound webhook must NOT auto-reply.
    mode: sessionModeEnum("mode").notNull().default("ai"),
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
      .references(() => organizations.id, { onDelete: "cascade" }),
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
      .references(() => organizations.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => customerSessions.id),
    customerId: uuid("customer_id").references(() => customers.id),
    // Stage 5: the physical service location for this job (one billing customer
    // can have many sites). Nullable, populated lazily.
    locationId: uuid("location_id"),
    assignedTo: uuid("assigned_to").references(() => users.id),
    status: requestStatusEnum("status").notNull().default("pending"),
    // True when the system (not a human dispatcher) assigned this request — set
    // by autoAssignBookedRequest on a successful auto-assign. Drives the board's
    // "Auto" badge. Default false: human/drag assignments stay unflagged.
    autoAssigned: boolean("auto_assigned").notNull().default(false),
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
    // ── Duration-based scheduling / autodispatch ──
    // Estimated on-site duration in minutes (deterministic base table, optionally
    // LLM-refined). NULL until computed at booking.
    estimatedDurationMinutes: integer("estimated_duration_minutes"),
    // Provenance of the estimate: 'default' | 'llm' | 'actual' | 'manual'.
    estimatedDurationSource: text("estimated_duration_source")
      .notNull()
      .default("default"),
    // Outcome of the confidence-gated autodispatch pass at booking time.
    // ('queued_needs_review' = held back by the pre-assign booking-quality gate.)
    // Plain text column, so adding a value needs no migration.
    autoDispatchOutcome: text("auto_dispatch_outcome", {
      enum: [
        "committed",
        "queued_ambiguous",
        "queued_no_fit",
        "queued_needs_review",
      ],
    }),
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
    // The arrival window a "running behind" dispatcher SMS was last sent for.
    // The delay-sweep cron dedupes on this so it doesn't re-alert the same late
    // job every run; it resets naturally when the window is rescheduled (a new
    // arrivalWindowEnd no longer matches this marker).
    delayAlertedWindowEnd: timestamp("delay_alerted_window_end", {
      withTimezone: true,
    }),
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
    // Fieldpulse job id this request maps to, once pushed. NULL until the org is
    // Fieldpulse-connected and a successful create-job has mirrored the booking to
    // Fieldpulse. Set once and treated idempotently: a re-push of an already-mapped
    // request UPDATEs the existing Fieldpulse job (reschedule/reassign) instead of
    // creating a duplicate. Plaintext (Fieldpulse's public resource id, not a secret).
    fieldpulseJobId: text("fieldpulse_job_id"),
    // Invoice / payment status mirrored from HCP invoice.* webhooks, linked to
    // this request via hcpJobId. Defaults to 'none' (no invoice activity yet);
    // an invoice.sent/paid/voided event updates it so admins can see whether a
    // completed job has been invoiced/paid. (Stage 4 of the HCP integration.)
    invoiceStatus: invoiceStatusEnum("invoice_status").notNull().default("none"),
    scheduledDate: timestamp("scheduled_date", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // On-site customer e-signature captured by the assigned tech at job sign-off.
    // signatureUrl points at the R2-stored PNG (admin/server retrieval only for
    // v1). signatureName is the customer's printed name — PII-ish but stored
    // plaintext like estimates.signatureName (the customer's own sign-off).
    signatureUrl: text("signature_url"),
    signatureName: text("signature_name"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    // Operational metrics pulled from FieldPulse per-job GET /jobs/{id}.
    // Populated by the "job-metrics" import phase (idempotent overwrite).
    // Shape: { statusLogSeconds: { pending, on_the_way, in_progress, completed },
    //          totalPriceCents, mapCoords }
    // Null when the phase hasn't run or the job has no metrics.
    fieldpulseMetrics: jsonb("fieldpulse_metrics").$type<{
      statusLogSeconds: {
        pending: number | null;
        on_the_way: number | null;
        in_progress: number | null;
        completed: number | null;
      };
      totalPriceCents: number | null;
      mapCoords: unknown | null;
    }>(),
    // fieldpulse_data: spillover jsonb for FP job fields not promoted to typed columns.
    // Only non-PII safe fields (tags, is_multiday_job). NULL on native rows.
    fieldpulseData: jsonb("fieldpulse_data"),
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
    // Inbound HCP/Fieldpulse webhooks resolve the request by external job id on
    // every delivery — index both so the lookup isn't a full table scan. The
    // Fieldpulse one is UNIQUE PER ORG so a cross-tenant job-id collision can't
    // resolve to the wrong tenant's request (pairs with the org-scoped query in
    // invoice-sync). Partial: most rows have NULL job ids.
    index("requests_hcp_job_id_idx")
      .on(table.hcpJobId)
      .where(sql`${table.hcpJobId} IS NOT NULL`),
    uniqueIndex("requests_org_fieldpulse_job_id_unique")
      .on(table.organizationId, table.fieldpulseJobId)
      .where(sql`${table.fieldpulseJobId} IS NOT NULL`),
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
      .references(() => serviceRequests.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
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
      .references(() => organizations.id, { onDelete: "cascade" }),
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
    // Fieldpulse customer id this row maps to, once synced. NULL until the org is
    // Fieldpulse-connected and a successful find-or-create has mirrored the
    // customer to Fieldpulse. Set once and treated as idempotent: a re-sync of an
    // already-mapped customer is a no-op.
    fieldpulseCustomerId: text("fieldpulse_customer_id"),
    // Fieldpulse custom fields (including synthetic lead_source entry).
    // Nullable jsonb — null when the customer has no custom fields.
    fieldpulseCustomFields: jsonb("fieldpulse_custom_fields").$type<
      { name: string; value: string }[]
    >(),
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
    // Customer self-service portal: SHA-256 hash of a long-lived, customer-scoped
    // bearer token (the plaintext is returned to the admin exactly ONCE at
    // generation, never stored — same hashed-at-rest pattern as staff invites and
    // estimate approval tokens). NULL = no active portal link. Rotating the link
    // overwrites the hash (old links die). The token is the only authority for the
    // public /portal page — org + customer are derived from THIS row, never a param.
    portalTokenHash: text("portal_token_hash"),
    portalTokenCreatedAt: timestamp("portal_token_created_at", {
      withTimezone: true,
    }),
    // GDPR erasure marker: set when the customer's PII has been anonymized
    // (right-to-erasure). The row is RETAINED (de-identified) so financial
    // history stays intact, but every PII column is scrubbed and the blind
    // indexes nulled. NULL = the customer is a normal, identified record.
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
    // ── FieldPulse field-parity P1 promotions ──
    // is_tax_exempt: from FP `is_tax_exempt`. NULL on native rows.
    isTaxExempt: boolean("is_tax_exempt"),
    // billing_address_encrypted: encrypted billing address when different from service
    // address (FP `billing_address_1/2/city/state/zip`). NULL on native rows.
    // SECURITY: same encrypt() + sanitizeAddress pattern as addressEncrypted.
    billingAddressEncrypted: text("billing_address_encrypted"),
    // fieldpulse_data: spillover jsonb for safe non-PII FP fields not promoted to typed
    // columns. Subject to strict ALLOWLIST — PII fields can NEVER enter this column.
    // See buildFpSpillover docs for the enforced allowlist.
    fieldpulseData: jsonb("fieldpulse_data"),
  },
  (table) => [
    index("customers_org_id_idx").on(table.organizationId),
    // Composite index for the list-page query: WHERE org=$1 ORDER BY created_at DESC LIMIT.
    index("customers_org_created_idx").on(table.organizationId, table.createdAt),
    // Unique per org: one customer row per email / per phone within a tenant.
    // Partial (WHERE ... IS NOT NULL) so the many rows lacking an email or
    // phone don't all collide on NULL.
    uniqueIndex("customers_org_email_hash_unique")
      .on(table.organizationId, table.emailHash)
      .where(sql`${table.emailHash} IS NOT NULL`),
    uniqueIndex("customers_org_phone_hash_unique")
      .on(table.organizationId, table.phoneHash)
      .where(sql`${table.phoneHash} IS NOT NULL`),
    // Unique per org so the Fieldpulse invoice/customer pull resolves a customer
    // by its Fieldpulse id unambiguously (the id isn't globally unique). Partial
    // so the many rows without a Fieldpulse id don't collide on NULL.
    uniqueIndex("customers_org_fieldpulse_customer_id_unique")
      .on(table.organizationId, table.fieldpulseCustomerId)
      .where(sql`${table.fieldpulseCustomerId} IS NOT NULL`),
    // Same, for the Housecall Pro invoice/customer pull resolution.
    uniqueIndex("customers_org_hcp_customer_id_unique")
      .on(table.organizationId, table.hcpCustomerId)
      .where(sql`${table.hcpCustomerId} IS NOT NULL`),
    // Portal token lookups resolve a customer by hash on every public request —
    // unique (a token maps to exactly one customer) + partial (most rows have no
    // token). The global uniqueness is intentional: the hash is a 256-bit secret,
    // so cross-org collision is infeasible and the lookup needs no org param.
    uniqueIndex("customers_portal_token_hash_unique")
      .on(table.portalTokenHash)
      .where(sql`${table.portalTokenHash} IS NOT NULL`),
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
      .references(() => organizations.id, { onDelete: "cascade" }),
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
    // ── Warranty tracking + proactive-reminder fields (parity stage) ──
    // The kind of coverage ("manufacturer", "labor", "extended") and who
    // provides it ("Carrier", "Trane", a third-party plan). All nullable;
    // intake/admin fill when known. No price/cents ever stored here. The
    // warranty-expiring reminder sweep keys off the existing `warrantyExpiration`
    // column above.
    warrantyType: text("warranty_type"),
    warrantyProvider: text("warranty_provider"),
    locationInHome: text("location_in_home"),
    notes: text("notes"),
    // Stage 5: the physical site this unit is installed at (assets belong to a
    // LOCATION, not just a customer). Nullable, populated lazily.
    locationId: uuid("location_id"),
    // Stage 5: replacement chain — the unit that replaced this one, and when this
    // one was retired. App-linked (no self-FK to keep the migration simple).
    replacedByEquipmentId: uuid("replaced_by_equipment_id"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    fieldpulseAssetId: text("fieldpulse_asset_id"),
    // fieldpulse_data: spillover jsonb for FP asset fields not promoted to typed columns.
    fieldpulseData: jsonb("fieldpulse_data"),
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
    uniqueIndex("equipment_org_fieldpulse_asset_id_unique")
      .on(table.organizationId, table.fieldpulseAssetId)
      .where(sql`${table.fieldpulseAssetId} IS NOT NULL`),
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
      .references(() => organizations.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => users.id),
    content: text("content").notNull(),
    noteType: noteTypeEnum("note_type").notNull().default("general"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // FieldPulse import: idempotent key for comment-sourced notes.
    fieldpulseCommentId: text("fieldpulse_comment_id"),
  },
  (table) => [
    index("notes_customer_id_idx").on(table.customerId),
    index("notes_org_id_idx").on(table.organizationId),
    uniqueIndex("notes_org_fp_comment_id_unique")
      .on(table.organizationId, table.fieldpulseCommentId)
      .where(sql`${table.fieldpulseCommentId} IS NOT NULL`),
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
      .references(() => organizations.id, { onDelete: "cascade" }),
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
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Stage 5: the specific installed unit this visit serviced — enables a
    // per-asset repair timeline. Nullable (older history has no asset link).
    equipmentId: uuid("equipment_id").references(() => customerEquipment.id),
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
    // Per-asset timeline lookup (getEquipmentServiceHistory) filters by
    // equipment_id — index it (partial: most history rows have no asset link).
    index("history_equipment_id_idx")
      .on(table.equipmentId)
      .where(sql`${table.equipmentId} IS NOT NULL`),
  ],
);

// Who/what performed an audited action. "ai" marks autonomous agent actions
// (booking, recovery sends) so an AI-initiated mutation is distinguishable from a
// human dispatcher or a system/cron job — the audit trail for "autonomous AI".
export const actorTypeEnum = pgEnum("actor_type", ["human", "ai", "system"]);

// 11. audit_log
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id),
    sessionId: uuid("session_id").references(() => customerSessions.id),
    // human (a logged-in user) | ai (autonomous agent) | system (cron/webhook).
    actorType: actorTypeEnum("actor_type").notNull().default("human"),
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
    // Composite index for the list-page query: WHERE org=$1 ORDER BY created_at DESC LIMIT.
    index("audit_log_org_created_idx").on(table.organizationId, table.createdAt),
  ],
);

// 12. organization_settings — per-org chatbot configuration (1:1 with org).
// One row per organization. Drives the customer-facing widget's branding, which
// services the bot will take, and the business-info answers used by canned FAQ
// responses. JSON columns keep the shape flexible without a migration per field.
export const organizationSettings = pgTable("organization_settings", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),

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

  // ── Voice warm transfer (Stage 2) ──
  // E.164 number the voice agent <Dial>s when a call escalates to a human. NULL
  // = no human leg configured; an escalated call falls back to a spoken message
  // + async escalation (the prior hangup behavior).
  voiceTransferNumber: text("voice_transfer_number"),

  // ── AI model selection (super-admin model switcher) ──
  // Registry id (model-registry.ts) of the LLM this org's bot uses. NULL = use
  // the env-default model. An unknown id or a model whose API key env var is not
  // configured silently falls back to the env default — a mis-config never
  // breaks a customer turn. Holds an id only; the key/baseUrl live in env.
  aiModelId: text("ai_model_id"),

  // ── Onboarding checklist (self-serve signup) ──
  // Stores ONLY the non-derivable onboarding flags: { dismissed?, embedViewed? }.
  // All other checklist steps are derived from live data (see
  // src/lib/admin/onboarding-queries.ts). NULL = nothing dismissed/viewed yet.
  onboardingState: jsonb("onboarding_state").$type<{
    dismissed?: boolean;
    embedViewed?: boolean;
  }>(),

  // ── Auto-dispatch (Probook-style scored assignment) ──
  // OFF by default: when false, a freshly-booked request auto-assigns first-fit
  // (today's behavior). When true, autoAssignBookedRequest ranks technicians by
  // a deterministic skill/quality/load score and assigns the best one that fits.
  autoDispatchEnabled: boolean("auto_dispatch_enabled").notNull().default(false),
  // Source of truth for scheduling. 'external' SKIPS native autodispatch (an
  // external scheduler — FieldPulse/HCP — owns the calendar) to avoid double-
  // booking. Default 'native' preserves today's behavior.
  schedulingSource: text("scheduling_source", { enum: ["native", "external"] })
    .notNull()
    .default("native"),
  // Number that receives "technician running behind" dispatcher SMS alerts.
  // NULL = dispatcher delay alerts disabled.
  dispatchAlertPhone: text("dispatch_alert_phone"),

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
      .references(() => organizations.id, { onDelete: "cascade" }),
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
      .references(() => organizations.id, { onDelete: "cascade" }),
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

// capacity_reservations — race-safe confirm-time capacity holds.
//
// A booking's capacity is DERIVED live (availability.ts): capacity = techs whose
// hours cover a (day, band); consumed = assigned jobs + these reservations. A
// fresh booking is UNASSIGNED, so it wouldn't count toward "booked" — two
// concurrent confirms could both take the last opening and OVER-PROMISE a band.
// This table is the missing atomic claim: at confirm time we INSERT a row at the
// lowest free slot_ordinal in [0, ceiling) where ceiling = capacity − assigned.
// The UNIQUE(org, day, window, slot_ordinal) is the compare-and-swap primitive
// (neon-http has no interactive transactions / SELECT ... FOR UPDATE): a
// concurrent confirm racing for the same ordinal fails the insert and advances;
// when every ordinal is taken the band is genuinely full → soft booking.
//
// day is TEXT 'YYYY-MM-DD' (business-tz ISO), matching the availability day keys.
// service_request_id is a PLAIN uuid (NO FK): the reservation is written BEFORE
// the service_requests row exists in its atomic batch, so an FK would violate at
// insert time. Its lifecycle is managed explicitly (released on cancel /
// unschedule / assignment) rather than by cascade.
export const capacityReservations = pgTable(
  "capacity_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Business-tz ISO date (YYYY-MM-DD) the band falls on.
    day: text("day").notNull(),
    // Arrival band: "morning" | "afternoon" | "evening".
    window: text("window").notNull(),
    // Position in the band's capacity, [0, ceiling). The UNIQUE below makes it
    // the CAS token two concurrent confirms contend for.
    slotOrdinal: integer("slot_ordinal").notNull(),
    // The request this hold belongs to (plain uuid, no FK — see table comment).
    // Null only transiently; used to dedupe a reservation against its own placed
    // job and to release the hold on cancel/unschedule.
    serviceRequestId: uuid("service_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // The atomicity primitive: at most one reservation per (org, day, band,
    // ordinal). Two confirms racing for the same ordinal → exactly one wins.
    uniqueIndex("capacity_reservations_slot_unique").on(
      table.organizationId,
      table.day,
      table.window,
      table.slotOrdinal,
    ),
    // Availability counting reads all reservations for a (day, band).
    index("capacity_reservations_org_day_window_idx").on(
      table.organizationId,
      table.day,
      table.window,
    ),
    // Release-by-request (cancel / unschedule / assignment) looks up by request.
    index("capacity_reservations_request_idx").on(table.serviceRequestId),
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
      .references(() => organizations.id, { onDelete: "cascade" }),
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
      .references(() => organizations.id, { onDelete: "cascade" }),
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
// 16c. fieldpulse_connections — Per-org Fieldpulse API credentials.
// Mirrors housecall_pro_connections: stores the encrypted API key, webhook secret,
// and non-secret account metadata. One connection per organization.
export const fieldpulseConnections = pgTable(
  "fieldpulse_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // AES-256-GCM ciphertext of the Fieldpulse API key. Never null while connected;
    // cleared (and connected=false) on disconnect.
    apiKeyEncrypted: text("api_key_encrypted"),
    // AES-256-GCM ciphertext of the per-org Fieldpulse WEBHOOK signing secret (if
    // Fieldpulse supports webhook signing). Used to verify inbound job-status
    // webhooks. Optional: when null the env-level FIELDPULSE_WEBHOOK_SECRET is
    // used instead, and when neither is present the webhook endpoint rejects
    // everything (fail closed). Never logged.
    webhookSecretEncrypted: text("webhook_secret_encrypted"),
    // Non-secret account metadata cache (company name, account id) — display only.
    accountInfo: jsonb("account_info"),
    connected: boolean("connected").notNull().default(false),
    // Stage 9: Availability sync tracking. Timestamp of last successful sync
    // (null = never synced). Used for monitoring and troubleshooting.
    lastAvailabilitySyncAt: timestamp("last_availability_sync_at", {
      withTimezone: true,
    }),
    // Stage 9: Current availability sync status. Used for admin UI display
    // and to prevent concurrent syncs.
    availabilitySyncStatus: availabilitySyncStatusEnum(
      "availability_sync_status",
    ).notNull().default("pending"),
    // Stage 9: Error message from last failed sync. Null when last sync succeeded
    // or never ran. Used for troubleshooting in the admin UI.
    lastSyncError: text("last_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("fieldpulse_connections_org_id_idx").on(table.organizationId),
    // One Fieldpulse connection per organization.
    uniqueIndex("fieldpulse_connections_org_unique").on(table.organizationId),
    // Stage 9: Index for filtering active connections by sync status (admin UI).
    index("fieldpulse_connections_sync_status_idx").on(
      table.availabilitySyncStatus,
    ).where(sql`${table.connected} = true`),
  ],
);

// 16d. fieldpulse_webhook_events — IDEMPOTENCY ledger for inbound Fieldpulse webhooks.
// Fieldpulse retries webhook delivery, so the same event id can arrive more than once.
// We record each processed event id; the unique (org, event_id) index lets the
// handler insert-on-conflict-do-nothing and treat a zero-row insert as "already
// processed" — so a redelivery never applies a second status update. We persist
// only NON-secret metadata (the Fieldpulse event id + event type + the job id it
// referenced); never the raw payload or any secret.
export const fieldpulseWebhookEvents = pgTable(
  "fieldpulse_webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Fieldpulse's event id (the `id` field on the webhook envelope). Deduped per org.
    eventId: text("event_id").notNull(),
    // Fieldpulse event type, e.g. "job.status_updated" — stored for the audit trail only.
    eventType: text("event_type").notNull(),
    // The Fieldpulse job id the event referenced (may be null for non-job events we
    // still record as seen). Plaintext — Fieldpulse's public resource id, not a secret.
    fieldpulseJobId: text("fieldpulse_job_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("fieldpulse_webhook_events_org_id_idx").on(table.organizationId),
    // One event per org per Fieldpulse event id — idempotent.
    uniqueIndex("fieldpulse_webhook_events_org_event_unique").on(
      table.organizationId,
      table.eventId,
    ),
  ],
);

export const hcpWebhookEvents = pgTable(
  "hcp_webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
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

// 13b. saas_billing_events — IDEMPOTENCY ledger for inbound SaaS-billing
// (platform-subscription) webhooks. (Stage 10.)
//
// Unlike the per-org HCP/Fieldpulse ledgers, the SaaS-billing webhook is a
// PLATFORM endpoint: the provider's event id is globally unique, so dedupe is on
// `event_id` alone (a single global unique index). The handler does
// insert-on-conflict-do-nothing and treats a zero-row insert as "already
// processed", so a provider redelivery never re-applies a subscription change.
// We persist only NON-secret metadata (the provider event id + type + the org it
// targeted); never the raw payload or any secret.
export const saasBillingEvents = pgTable(
  "saas_billing_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The provider's event id (globally unique across all orgs). The dedupe key.
    eventId: text("event_id").notNull(),
    // The provider event type, e.g. "subscription.updated" — audit trail only.
    eventType: text("event_type").notNull(),
    // The org the event targeted (nullable: an event we record as seen but could
    // not map to an org). Not org-scoped on the unique index by design.
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // One ledger row per provider event id, globally — the dedupe key.
    uniqueIndex("saas_billing_events_event_id_unique").on(table.eventId),
    index("saas_billing_events_org_id_idx").on(table.organizationId),
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
      .references(() => organizations.id, { onDelete: "cascade" }),
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
      .references(() => organizations.id, { onDelete: "cascade" }),
    // NULLABLE as of Stage 7: chat uploads always carry a session, but
    // admin-uploaded documents/photos (linked directly to a job/equipment/
    // customer) have no chat session. Existing rows are unaffected.
    sessionId: uuid("session_id").references(() => customerSessions.id),
    messageId: uuid("message_id").references(() => messages.id),
    // Stage 7: link media to a job, a specific asset, and/or a customer
    // (verified missing — only sessionId/messageId existed). All NULLABLE:
    // existing rows (chat uploads) have none, and an admin-uploaded document
    // may target only one of the three. FKs are no-op-on-delete to match the
    // table's existing constraints.
    serviceRequestId: uuid("service_request_id").references(
      () => serviceRequests.id,
    ),
    equipmentId: uuid("equipment_id").references(() => customerEquipment.id),
    customerId: uuid("customer_id").references(() => customers.id),
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
    index("attachments_service_request_idx")
      .on(table.serviceRequestId)
      .where(sql`${table.serviceRequestId} IS NOT NULL`),
    index("attachments_equipment_idx")
      .on(table.equipmentId)
      .where(sql`${table.equipmentId} IS NOT NULL`),
    index("attachments_customer_idx")
      .on(table.customerId)
      .where(sql`${table.customerId} IS NOT NULL`),
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
  // Money-loop triggers (Stage: comms+memberships): estimate approval link on
  // send, payment receipt on a successful charge, and unpaid-invoice dunning.
  "estimate_sent",
  "payment_receipt",
  "invoice_overdue",
  // Lead-gen: a proactive nudge that an installed unit's warranty is expiring
  // soon, inviting the customer to schedule a check-up. Marketing-ish — quiet
  // hours apply, gated by the marketingMessages preference (see TRIGGER_RULES).
  "warranty_expiring",
]);

// Review-request lifecycle: created (pending) -> ask sent (sent) -> customer
// responded with a rating/feedback (responded).
export const reviewRequestStatusEnum = pgEnum("review_request_status", [
  "pending",
  "sent",
  "responded",
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

    // Recipient PII — AES-256-GCM ciphertext (encrypted at enqueue, decrypted
    // only in-memory at send time), matching the at-rest encryption used for all
    // other PII in this schema. Stored as text to hold the ciphertext envelope.
    recipientPhoneEncrypted: text("recipient_phone_encrypted"),
    recipientEmailEncrypted: text("recipient_email_encrypted"),

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

    // Related entities (optional, for tracking/queries). FK-constrained so a
    // deleted customer/request auto-purges its orphan jobs.
    customerId: uuid("customer_id").references(() => customers.id, {
      onDelete: "cascade",
    }),
    serviceRequestId: uuid("service_request_id").references(
      () => serviceRequests.id,
      { onDelete: "cascade" },
    ),

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

// 23. outbound_message_ledger — dedupe ledger for CRON-DRIVEN outbound comms.
// Distinct from the INBOUND webhook ledgers (fieldpulse/hcp_webhook_events): this
// stops a re-run of an outbound cron (warranty-expiry, booking-recovery, renewal
// nudge) from double-sending. The caller claims a (customer, trigger, period)
// slot before sending; the unique index makes the claim atomic. No PII stored.
export const outboundMessageLedger = pgTable(
  "outbound_message_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    triggerType: communicationTriggerTypeEnum("trigger_type").notNull(),
    // Caller-defined bucket the send is deduped within, e.g. "2026-06-15" (daily)
    // or "warranty:<equipmentId>" (once per unit). One send per bucket.
    periodKey: text("period_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("outbound_ledger_unique").on(
      table.organizationId,
      table.customerId,
      table.triggerType,
      table.periodKey,
    ),
  ],
);

// 24. request_status_events — append-only log of every service-request status
// transition. Source data for on-time KPIs, payroll/labor hours (Stage 10), and
// tech-on-the-way automation. actorType records whether a human, the AI agent,
// or a system/webhook drove the change. No PII (ids + enums only).
export const requestStatusEvents = pgTable(
  "request_status_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    serviceRequestId: uuid("service_request_id")
      .notNull()
      .references(() => serviceRequests.id, { onDelete: "cascade" }),
    // null fromStatus = the request's initial status at creation.
    fromStatus: requestStatusEnum("from_status"),
    toStatus: requestStatusEnum("to_status").notNull(),
    actorType: actorTypeEnum("actor_type").notNull().default("system"),
    // The user id for human actors; null for ai/system.
    actorId: uuid("actor_id"),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("request_status_events_request_idx").on(table.serviceRequestId),
    index("request_status_events_org_idx").on(table.organizationId),
  ],
);

// ── Context layer (Probook v3, Phase 1) ───────────────────────────────────────
// One thread per resolved customer + an append-only, PII-free event stream.
// Mirrors requestStatusEvents: ids + enums/label-keys only, no free text.
export const customerThreads = pgTable(
  "customer_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    lastChannel: text("last_channel"),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    openEstimateCount: integer("open_estimate_count").notNull().default(0),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("customer_threads_org_customer_unique").on(
      table.organizationId,
      table.customerId,
    ),
  ],
);

export const customerEvents = pgTable(
  "customer_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => customerThreads.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    refId: uuid("ref_id"),
    jobType: text("job_type"),
    window: text("window"),
    labelKey: text("label_key"),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("customer_events_org_customer_at_idx").on(
      table.organizationId,
      table.customerId,
      table.at,
    ),
  ],
);

// ── Forecasting (Probook v3, Phase 4) ─────────────────────────────────────────
// Nightly rollups + versioned snapshots. All counts/cents are integers; NO PII.
// Native vs synced revenue are NEVER blended — kept as separate `basis` rows.
export const demandDaily = pgTable(
  "demand_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    // NOT NULL with a sentinel: Postgres treats NULLs as DISTINCT in a plain
    // unique index, so a NULL "all types" row would never match
    // onConflictDoUpdate and would duplicate every run. Use '__all__'.
    jobType: text("job_type").notNull().default("__all__"),
    bookings: integer("bookings").notNull().default(0),
    sessions: integer("sessions").notNull().default(0),
    booked: integer("booked").notNull().default(0),
  },
  (table) => [
    uniqueIndex("demand_daily_org_day_jobtype_unique").on(
      table.organizationId,
      table.day,
      table.jobType,
    ),
  ],
);

export const revenueDaily = pgTable(
  "revenue_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    basis: text("basis").notNull(), // 'native_payment' | 'synced_creation' — NEVER blended
    collectedCents: integer("collected_cents").notNull().default(0),
    invoicedCents: integer("invoiced_cents").notNull().default(0),
    refundedCents: integer("refunded_cents").notNull().default(0),
  },
  (table) => [
    uniqueIndex("revenue_daily_org_day_basis_unique").on(
      table.organizationId,
      table.day,
      table.basis,
    ),
  ],
);

export const forecastSnapshots = pgTable(
  "forecast_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'demand' | 'revenue' | 'capacity'
    model: text("model").notNull(), // 'seasonal_naive' | 'revenue_partition' | ...
    horizonDays: integer("horizon_days").notNull(),
    segment: text("segment"), // jobType / revenue basis
    generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
    payload: jsonb("payload").notNull(),
  },
  (table) => [
    index("forecast_snapshots_org_kind_gen_idx").on(
      table.organizationId,
      table.kind,
      table.generatedAt,
    ),
  ],
);

export const forecastAccuracy = pgTable(
  "forecast_accuracy",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    model: text("model").notNull(),
    segment: text("segment"),
    horizonDays: integer("horizon_days").notNull(),
    forDay: date("for_day").notNull(),
    predicted: integer("predicted").notNull(),
    actual: integer("actual"), // filled when the day passes
    absError: integer("abs_error"), // |actual - predicted| — MASE numerator, NOT a percentage
  },
  (table) => [
    uniqueIndex("forecast_accuracy_unique").on(
      table.organizationId,
      table.kind,
      table.segment,
      table.horizonDays,
      table.forDay,
    ),
  ],
);

// 25. customer_locations — physical service sites (Stage 5).
// ServiceTitan's CUSTOMER-vs-LOCATION split: one billing customer can hold many
// service addresses (property managers, landlords, commercial multi-site, or a
// homeowner with a rental). Jobs/equipment hang off a location. addressHash is a
// blind index (same HMAC pattern as customers) for dedupe/matching.
export const customerLocations = pgTable(
  "customer_locations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    // AES-256-GCM ciphertext of the service address (PII at rest).
    addressEncrypted: text("address_encrypted").notNull(),
    // Blind index of the normalized address for dedupe within a customer.
    addressHash: text("address_hash"),
    label: text("label"), // e.g. "Main St rental", "Warehouse B"
    zone: text("zone"), // dispatch/routing zone
    propertyType: text("property_type"),
    accessNotes: text("access_notes"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("customer_locations_customer_idx").on(table.customerId),
    index("customer_locations_org_idx").on(table.organizationId),
    // Dedupe a location within one customer by normalized-address hash.
    uniqueIndex("customer_locations_customer_addr_unique")
      .on(table.customerId, table.addressHash)
      .where(sql`${table.addressHash} IS NOT NULL`),
  ],
);

// ════════ Stage 8: Pricebook + tax (sales-money spine root) ════════
export const pricebookItemTypeEnum = pgEnum("pricebook_item_type", [
  "service",
  "material",
  "equipment",
]);

// 26. pricebook_categories — self-referential category tree.
export const pricebookCategories = pgTable(
  "pricebook_categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"), // self-link (app-enforced)
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("pricebook_categories_org_idx").on(table.organizationId)],
);

// 27. pricebook_items — priced catalog (money in integer cents).
export const pricebookItems = pgTable(
  "pricebook_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id"),
    type: pricebookItemTypeEnum("type").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    sku: text("sku"),
    costCents: integer("cost_cents").notNull().default(0),
    markupPct: integer("markup_pct").notNull().default(0),
    priceCents: integer("price_cents").notNull().default(0),
    memberPriceCents: integer("member_price_cents"),
    hours: integer("hours"), // labor hours (estimating)
    warranty: text("warranty"),
    active: boolean("active").notNull().default(true),
    // FieldPulse provenance — set on items mirrored from the /items endpoint.
    // NULL for natively-created items.
    fieldpulseItemId: text("fieldpulse_item_id"),
    // ── FieldPulse field-parity P1 promotions ──
    // is_labor_item: true when FP marks this as a labor line.
    isLaborItem: boolean("is_labor_item").notNull().default(false),
    // quantity_available: FP inventory stock count. NULL = untracked / display-only.
    quantityAvailable: integer("quantity_available"),
    // vendor_type: FP free-text vendor classification (e.g. "carrier", "trane").
    vendorType: text("vendor_type"),
    // fieldpulse_data: spillover jsonb for FP fields not promoted to typed columns.
    // Only set on FP-mirrored rows (fieldpulse_item_id IS NOT NULL). NULL on native rows.
    fieldpulseData: jsonb("fieldpulse_data"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("pricebook_items_org_idx").on(table.organizationId),
    index("pricebook_items_category_idx").on(table.categoryId),
    uniqueIndex("pricebook_items_org_sku_unique")
      .on(table.organizationId, table.sku)
      .where(sql`${table.sku} IS NOT NULL`),
    // Per-org unique on FieldPulse item id — partial (WHERE IS NOT NULL) to
    // allow multiple native items with null fieldpulseItemId per org.
    uniqueIndex("pricebook_items_org_fp_item_id_unique")
      .on(table.organizationId, table.fieldpulseItemId)
      .where(sql`${table.fieldpulseItemId} IS NOT NULL`),
  ],
);

// 28. pricebook_item_materials — materials that compose a service item.
export const pricebookItemMaterials = pgTable(
  "pricebook_item_materials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => pricebookItems.id, { onDelete: "cascade" }),
    materialItemId: uuid("material_item_id")
      .notNull()
      .references(() => pricebookItems.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull().default(1),
  },
  (table) => [index("pricebook_item_materials_item_idx").on(table.itemId)],
);

// 28b. job_materials — materials a technician actually used on a service request
// in the field. Distinct from estimate/invoice line snapshots: this is the ACTUAL
// consumption, captured on-site by the assigned tech. unitCostCents/unitPriceCents
// are snapshotted at add-time from the pricebook item (server-authoritative), or
// default to 0 for a manual (off-catalog) line. Feeds the actual-vs-estimated
// margin readout. Money in integer cents.
export const jobMaterials = pgTable(
  "job_materials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    serviceRequestId: uuid("service_request_id")
      .notNull()
      .references(() => serviceRequests.id, { onDelete: "cascade" }),
    pricebookItemId: uuid("pricebook_item_id").references(
      () => pricebookItems.id,
    ),
    description: text("description"),
    quantity: integer("quantity").notNull().default(1),
    unitCostCents: integer("unit_cost_cents").notNull().default(0),
    unitPriceCents: integer("unit_price_cents").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("job_materials_org_idx").on(table.organizationId),
    index("job_materials_request_idx").on(table.serviceRequestId),
  ],
);

// 28b. technician_time_entries — labor tracking / job-cost. A tech clocks IN
// (open entry: clock_out_at NULL) and OUT (minutes + a SNAPSHOTTED labor rate →
// labor_cost_cents) per job. The actual labor cost rolls into the invoice's
// actual-vs-estimated margin (margin = revenue − materials − actual labor).
// laborRateCents is snapshotted from the user's rate at clock-out so a later
// rate change never rewrites historical cost. Money is integer cents; minutes
// are integers.
export const technicianTimeEntries = pgTable(
  "technician_time_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    serviceRequestId: uuid("service_request_id")
      .notNull()
      .references(() => serviceRequests.id, { onDelete: "cascade" }),
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => users.id),
    clockInAt: timestamp("clock_in_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // NULL while the entry is OPEN (tech still on the clock); set at clock-out.
    clockOutAt: timestamp("clock_out_at", { withTimezone: true }),
    // Derived on clock-out: whole minutes between clock-in and clock-out.
    minutes: integer("minutes"),
    // Snapshotted from the user's labor_rate_cents at clock-out (cents/hour).
    // 0 when the tech has no rate set.
    laborRateCents: integer("labor_rate_cents").notNull().default(0),
    // round(minutes / 60 * laborRateCents). NULL while open.
    laborCostCents: integer("labor_cost_cents"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("tte_org_idx").on(table.organizationId),
    index("tte_request_idx").on(table.serviceRequestId),
    // At most ONE open entry per tech per job — a tech can't double clock-in.
    // Partial (WHERE clock_out_at IS NULL): closed entries never collide, so a
    // tech may have many historical entries on the same job.
    uniqueIndex("tte_open_per_tech_job_unique")
      .on(table.serviceRequestId, table.technicianId)
      .where(sql`${table.clockOutAt} IS NULL`),
  ],
);

// 28b. technician_locations — consent-gated live field position fixes. One row
// per GPS fix posted by a tech's phone while clocked in. Latest-per-tech feeds
// travel-aware dispatch + behind-schedule projection; history is trimmed by
// retention. Plain coords (not blind-indexed).
export const technicianLocations = pgTable(
  "technician_locations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The job the tech was on when this fix was captured (NULL if none).
    serviceRequestId: uuid("service_request_id").references(
      () => serviceRequests.id,
      { onDelete: "set null" },
    ),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    accuracyM: doublePrecision("accuracy_m"),
    heading: doublePrecision("heading"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("tloc_org_idx").on(table.organizationId),
    index("tloc_latest_idx").on(
      table.organizationId,
      table.technicianId,
      table.capturedAt,
    ),
    index("tloc_captured_idx").on(table.capturedAt),
  ],
);

// 28c. dispatch_decisions — one audit row per SCORED auto-dispatch decision (why
// this tech, or why it was queued), for the dispatcher override loop + threshold
// tuning. PII-free: technician ids + scores + reason strings only.
export const dispatchDecisions = pgTable(
  "dispatch_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    serviceRequestId: uuid("service_request_id")
      .notNull()
      .references(() => serviceRequests.id, { onDelete: "cascade" }),
    outcome: text("outcome", {
      enum: [
        "committed",
        "queued_ambiguous",
        "queued_no_fit",
        "queued_needs_review",
      ],
    }).notNull(),
    // The tech auto-committed to (null when the decision was queued for a human).
    chosenTechnicianId: uuid("chosen_technician_id").references(() => users.id, {
      onDelete: "set null",
    }),
    topScore: doublePrecision("top_score"),
    confidenceGap: doublePrecision("confidence_gap"),
    // Ranked, best-first. travelKm/travelMinutes (nullable, added 2026-07) carry
    // both travel signals for the routing-vs-haversine A/B; older rows omit them.
    candidates: jsonb("candidates")
      .$type<
        Array<{
          technicianId: string;
          score: number;
          reasons: string[];
          travelKm?: number | null;
          travelMinutes?: number | null;
        }>
      >()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("dispatch_decisions_org_idx").on(table.organizationId),
    index("dispatch_decisions_request_idx").on(table.serviceRequestId),
  ],
);

// 29. tax_rates — jurisdictional tax (rate in basis points; 825 = 8.25%).
export const taxRates = pgTable(
  "tax_rates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    jurisdiction: text("jurisdiction"),
    rateBps: integer("rate_bps").notNull(), // basis points
    isDefault: boolean("is_default").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("tax_rates_org_idx").on(table.organizationId),
    // At most one active default tax rate per org (deterministic getDefaultTaxBps).
    uniqueIndex("tax_rates_org_default_unique")
      .on(table.organizationId)
      .where(sql`${table.isDefault} = true AND ${table.active} = true`),
  ],
);

// ════════ Parity Stage 10: Purchasing / Inventory + materials BOM ════════
// Per-org stock LINKED to pricebook material items (no second catalog). Money
// and quantities are integers (cents / whole units). Purchase orders are
// internal records until a real vendor API exists (mock-first vendor seam).

export const purchaseOrderStatusEnum = pgEnum("purchase_order_status", [
  "draft",
  "ordered",
  "received",
  "cancelled",
]);

// inventory_items — per-org stock for a pricebook material item. quantityOnHand
// is decremented when a tracked material is recorded as used on a job and
// incremented when a purchase order is received. unitCostCents holds the latest
// received cost. One row per (org, pricebook item).
export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    pricebookItemId: uuid("pricebook_item_id")
      .notNull()
      .references(() => pricebookItems.id, { onDelete: "cascade" }),
    quantityOnHand: integer("quantity_on_hand").notNull().default(0),
    reorderPoint: integer("reorder_point"),
    unitCostCents: integer("unit_cost_cents").notNull().default(0),
    location: text("location"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("inventory_items_org_idx").on(table.organizationId),
    // One stock row per pricebook material per org (upsert target).
    uniqueIndex("inventory_items_org_item_unique").on(
      table.organizationId,
      table.pricebookItemId,
    ),
  ],
);

// purchase_orders — a stock-replenishment order. Internal record (mock vendor
// seam) until a real vendor API lands. totalCents is the sum of line totals.
export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    vendorName: text("vendor_name").notNull(),
    status: purchaseOrderStatusEnum("status").notNull().default("draft"),
    totalCents: integer("total_cents").notNull().default(0),
    notes: text("notes"),
    orderedAt: timestamp("ordered_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("purchase_orders_org_idx").on(table.organizationId)],
);

// po_line_items — a line on a purchase order. pricebookItemId is nullable (a
// line may be a one-off, non-cataloged purchase); when set + received it drives
// the matching inventory increment. Money in integer cents; quantity in units.
export const poLineItems = pgTable(
  "po_line_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    pricebookItemId: uuid("pricebook_item_id").references(
      () => pricebookItems.id,
    ),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull(),
    unitCostCents: integer("unit_cost_cents").notNull(),
    lineTotalCents: integer("line_total_cents").notNull(),
  },
  (table) => [
    index("po_line_items_org_idx").on(table.organizationId),
    index("po_line_items_po_idx").on(table.purchaseOrderId),
  ],
);

// ════════ Stage 9: Estimates, invoicing, payments, financing ════════
export const estimateStatusEnum = pgEnum("estimate_status", [
  "open",
  "sold",
  "dismissed",
  "expired",
]);
export const invoiceStateEnum = pgEnum("invoice_state", [
  "draft",
  "open",
  "paid",
  "void",
  "refunded",
]);
export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "succeeded",
  "failed",
  "refunded",
]);
export const financingStatusEnum = pgEnum("financing_status", [
  "pending",
  "approved",
  "declined",
  "expired",
]);

// 30. estimates — a good-better-best proposal for a service request.
export const estimates = pgTable(
  "estimates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    serviceRequestId: uuid("service_request_id"),
    customerId: uuid("customer_id"),
    status: estimateStatusEnum("status").notNull().default("open"),
    totalCents: integer("total_cents").notNull().default(0),
    // Tokenized public approval (hashed token, like staff invites/widget keys).
    approvalTokenHash: text("approval_token_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // e-signature capture on approval.
    signedAt: timestamp("signed_at", { withTimezone: true }),
    signatureName: text("signature_name"),
    signatureIp: text("signature_ip"),
    soldOptionId: uuid("sold_option_id"),
    fieldpulseEstimateId: text("fieldpulse_estimate_id"),
    fieldpulseStatusName: text("fieldpulse_status_name"),
    // ── FieldPulse field-parity P1 promotions ──
    // due_date: real FP due date (NULL for native estimates).
    dueDate: timestamp("due_date", { withTimezone: true }),
    // title: human-readable estimate title from FP (NULL for native estimates).
    title: text("title"),
    // fieldpulse_data: spillover jsonb for FP fields not promoted to typed columns.
    fieldpulseData: jsonb("fieldpulse_data"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("estimates_org_idx").on(table.organizationId),
    index("estimates_request_idx").on(table.serviceRequestId),
    uniqueIndex("estimates_approval_token_unique")
      .on(table.approvalTokenHash)
      .where(sql`${table.approvalTokenHash} IS NOT NULL`),
    uniqueIndex("estimates_org_fieldpulse_estimate_id_unique")
      .on(table.organizationId, table.fieldpulseEstimateId)
      .where(sql`${table.fieldpulseEstimateId} IS NOT NULL`),
  ],
);

// 31. estimate_options — the good/better/best tiers.
export const estimateOptions = pgTable(
  "estimate_options",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    estimateId: uuid("estimate_id")
      .notNull()
      .references(() => estimates.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // "Good" | "Better" | "Best"
    sortOrder: integer("sort_order").notNull().default(0),
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    taxCents: integer("tax_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
  },
  (table) => [index("estimate_options_estimate_idx").on(table.estimateId)],
);

// 32. estimate_line_items — SNAPSHOT of a pricebook item at quote time.
export const estimateLineItems = pgTable(
  "estimate_line_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    optionId: uuid("option_id")
      .notNull()
      .references(() => estimateOptions.id, { onDelete: "cascade" }),
    // Reference the source item but SNAPSHOT name/price so later catalog edits
    // never mutate a sent quote.
    pricebookItemId: uuid("pricebook_item_id"),
    name: text("name").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitPriceCents: integer("unit_price_cents").notNull().default(0),
    // Snapshot of the pricebook item's cost at quote time so margin stays
    // historically accurate even if the catalog item later changes or deactivates.
    costCents: integer("cost_cents").notNull().default(0),
    lineTotalCents: integer("line_total_cents").notNull().default(0),
  },
  (table) => [index("estimate_line_items_option_idx").on(table.optionId)],
);

// 33. invoices — native invoicing (path B; for non-FSM orgs).
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    serviceRequestId: uuid("service_request_id"),
    customerId: uuid("customer_id"),
    estimateId: uuid("estimate_id"),
    state: invoiceStateEnum("state").notNull().default("draft"),
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    taxCents: integer("tax_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    amountPaidCents: integer("amount_paid_cents").notNull().default(0),
    // Set ONLY for invoices pulled (read-only) from Fieldpulse. Its non-null-ness
    // is the synced-vs-native discriminator (native invoices leave it NULL).
    // Plaintext — Fieldpulse's public resource id, not a secret. Native money
    // flows (takePayment/refundPayment/reconcilePayment) refuse rows where this
    // is set: Fieldpulse holds the real money for them.
    fieldpulseInvoiceId: text("fieldpulse_invoice_id"),
    // Same as fieldpulseInvoiceId but for the Housecall Pro pull mirror. Either
    // external id being set marks the invoice read-only in native money flows.
    hcpInvoiceId: text("hcp_invoice_id"),
    // When a collections reminder was last sent for this invoice. Nullable
    // (never reminded). Powers the "Reminded 3d ago" chip and the send cooldown.
    lastReminderSentAt: timestamp("last_reminder_sent_at", { withTimezone: true }),
    // Real-world invoice dates from the source system. For pull-mirrored
    // invoices (FieldPulse/HCP) issuedAt is when the invoice was created THERE
    // — createdAt is only when WE imported the row, which made every mirrored
    // invoice look 0 days old. Null for native invoices (age falls back to
    // createdAt) or when the source omits the field.
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    // Payment due date from the source system; drives overdue (falls back to
    // the age>=30 heuristic when null).
    dueDate: timestamp("due_date", { withTimezone: true }),
    // fieldpulse_data: spillover jsonb for FP invoice fields not promoted to typed columns.
    fieldpulseData: jsonb("fieldpulse_data"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("invoices_org_idx").on(table.organizationId),
    index("invoices_request_idx").on(table.serviceRequestId),
    // One invoice per estimate (idempotent materialization).
    uniqueIndex("invoices_estimate_unique")
      .on(table.estimateId)
      .where(sql`${table.estimateId} IS NOT NULL`),
    // Idempotency key for the Fieldpulse pull mirror — unique PER ORG (Fieldpulse
    // ids aren't globally unique). Partial so native invoices (NULL) don't collide.
    uniqueIndex("invoices_org_fieldpulse_invoice_id_unique")
      .on(table.organizationId, table.fieldpulseInvoiceId)
      .where(sql`${table.fieldpulseInvoiceId} IS NOT NULL`),
    // Same, for the Housecall Pro pull mirror.
    uniqueIndex("invoices_org_hcp_invoice_id_unique")
      .on(table.organizationId, table.hcpInvoiceId)
      .where(sql`${table.hcpInvoiceId} IS NOT NULL`),
  ],
);

// 34. invoice_line_items — snapshot from the sold estimate option.
export const invoiceLineItems = pgTable(
  "invoice_line_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitPriceCents: integer("unit_price_cents").notNull().default(0),
    // Carried over from the estimate line snapshot for historical margin accuracy.
    costCents: integer("cost_cents").notNull().default(0),
    lineTotalCents: integer("line_total_cents").notNull().default(0),
  },
  (table) => [index("invoice_line_items_invoice_idx").on(table.invoiceId)],
);

// 35. payments — a charge against an invoice (provider-agnostic seam).
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // "mock" | "stripe"
    providerPaymentId: text("provider_payment_id"),
    amountCents: integer("amount_cents").notNull(),
    // Running total refunded against this payment. Written by an ATOMIC claim
    // (WHERE amountRefundedCents + amt <= amountCents) so concurrent refunds
    // can't over-refund — the aggregate SUM(refunds) guard was check-then-act.
    amountRefundedCents: integer("amount_refunded_cents").notNull().default(0),
    status: paymentStatusEnum("status").notNull().default("pending"),
    isDeposit: boolean("is_deposit").notNull().default(false),
    fieldpulsePaymentId: text("fieldpulse_payment_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("payments_invoice_idx").on(table.invoiceId),
    uniqueIndex("payments_provider_id_unique")
      .on(table.provider, table.providerPaymentId)
      .where(sql`${table.providerPaymentId} IS NOT NULL`),
    uniqueIndex("payments_org_fieldpulse_payment_id_unique")
      .on(table.organizationId, table.fieldpulsePaymentId)
      .where(sql`${table.fieldpulsePaymentId} IS NOT NULL`),
  ],
);

// 36. refunds — a refund/credit against a payment.
export const refunds = pgTable(
  "refunds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "cascade" }),
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason"),
    providerRefundId: text("provider_refund_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("refunds_payment_idx").on(table.paymentId)],
);

// 37. financing_applications — thin hand-off to a consumer lender.
export const financingApplications = pgTable(
  "financing_applications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id"),
    estimateId: uuid("estimate_id"),
    provider: text("provider").notNull(), // "mock" | "wisetack" | "greensky"
    providerAppId: text("provider_app_id"),
    status: financingStatusEnum("status").notNull().default("pending"),
    requestedAmountCents: integer("requested_amount_cents").notNull(),
    approvedAmountCents: integer("approved_amount_cents"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("financing_applications_org_idx").on(table.organizationId)],
);

// ════════════════ Memberships v1: plans + enrollment ════════════════
// A recurring service-agreement plan (the "$19/mo maintenance" SKU). Recurring
// billing is STRIPE-GATED and mocked for v1 — currentPeriodEnd is tracked on the
// enrollment but renewals are NOT auto-charged here.
export const membershipBillingPeriodEnum = pgEnum("membership_billing_period", [
  "monthly",
  "annual",
]);

// Lifecycle of a single scheduled maintenance visit entitled by a membership
// (ServiceTitan service-agreement parity). "scheduled" = planned but not yet
// materialized into a job; "generated" = a service_request was created for it;
// "completed" = the visit was performed; "skipped" = intentionally not done.
export const membershipVisitStatusEnum = pgEnum("membership_visit_status", [
  "scheduled",
  "generated",
  "completed",
  "skipped",
]);

export const membershipPlans = pgTable(
  "membership_plans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    // The recurring price charged per billing period. Integer cents.
    priceCents: integer("price_cents").notNull(),
    billingPeriod: membershipBillingPeriodEnum("billing_period")
      .notNull()
      .default("monthly"),
    // Maintenance entitlement: how many maintenance visits a member is owed per
    // year (ServiceTitan service-agreement parity). 0 = billing-only plan (no
    // auto-generated visits). Drives the generate-membership-visits cron.
    visitsPerYear: integer("visits_per_year").notNull().default(0),
    // Free-form member benefits (e.g. discount %, priority dispatch, waived
    // diagnostic) for display/quote logic. Nullable until a plan defines any.
    benefits: jsonb("benefits"),
    // Soft-deactivate (a plan may have historical enrollments): never hard delete.
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("membership_plans_org_idx").on(table.organizationId)],
);

// A customer's enrollment in a plan. This table is the AUTHORITATIVE source of a
// customer's membership state; customers.membershipStatus is a DERIVED cache kept
// in sync (same db.batch) so existing member-aware readers stay correct.
export const customerMemberships = pgTable(
  "customer_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    planId: uuid("plan_id")
      .notNull()
      .references(() => membershipPlans.id),
    status: membershipStatusEnum("status").notNull().default("active"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // The end of the current paid period. Tracked, but renewals are NOT
    // auto-charged in v1 (Stripe-gated). Nullable for annual/edge cases.
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    // The future Stripe Subscription id this enrollment maps to. NULL until the
    // Stripe billing seam is built (recurring billing is mocked in v1).
    providerSubscriptionId: text("provider_subscription_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("customer_memberships_org_idx").on(table.organizationId),
    index("customer_memberships_customer_idx").on(table.customerId),
    // A customer has AT MOST ONE active membership per org. Partial unique index
    // (WHERE status='active') so cancelled/expired rows don't collide — this
    // guards the double-enroll race at the DB layer.
    uniqueIndex("customer_memberships_org_customer_active_unique")
      .on(table.organizationId, table.customerId)
      .where(sql`${table.status} = 'active'`),
  ],
);

// A single maintenance visit entitled by a membership (ServiceTitan service-
// agreement parity). The generate-membership-visits cron materializes these for
// members whose plan.visitsPerYear>0 as their due date approaches. periodKey is
// the idempotency bucket (e.g. "2026-H1" for the first of two annual visits):
// the (customerMembershipId, periodKey) UNIQUE index makes generation safe to
// re-run on a daily cron — a retried run for the same period can't duplicate.
export const membershipVisits = pgTable(
  "membership_visits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerMembershipId: uuid("customer_membership_id")
      .notNull()
      .references(() => customerMemberships.id, { onDelete: "cascade" }),
    // When the visit is due. The generated job's scheduledDate is set to this.
    dueDate: timestamp("due_date", { withTimezone: true }).notNull(),
    // Idempotency bucket within a membership's cycle (e.g. "2026-H1").
    periodKey: text("period_key").notNull(),
    status: membershipVisitStatusEnum("status").notNull().default("scheduled"),
    // The service_request created when this visit was generated. NULL until then.
    generatedServiceRequestId: uuid("generated_service_request_id").references(
      () => serviceRequests.id,
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("membership_visits_org_idx").on(table.organizationId),
    index("membership_visits_membership_idx").on(table.customerMembershipId),
    // The idempotency guard: at most one visit row per (membership, period).
    // A concurrent/retried cron run collides here instead of double-generating.
    uniqueIndex("membership_visits_membership_period_unique").on(
      table.customerMembershipId,
      table.periodKey,
    ),
  ],
);

// review_requests — post-completion review asks + the public response capture.
//
// One row per completed job (idempotency enforced both by the outbound ledger at
// enqueue time and by the partial-unique service_request index here). The public
// response page is bearer-authorized by reviewTokenHash (sha256 at rest, like
// estimates/staff invites). COMPLIANCE: there is NO sentiment routing — the
// public-review link is offered to EVERYONE who responds, regardless of rating.
// `feedback` is PRIVATE free text and must NEVER be logged.
export const reviewRequests = pgTable(
  "review_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    serviceRequestId: uuid("service_request_id")
      .notNull()
      .references(() => serviceRequests.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    status: reviewRequestStatusEnum("status").notNull().default("pending"),
    // sha256 of the plaintext token (the bearer of authority for the public page).
    reviewTokenHash: text("review_token_hash").notNull(),
    // 1-5 star rating, set on response. Loggable (not PII).
    rating: integer("rating"),
    // PRIVATE free-text feedback — NEVER log this value.
    feedback: text("feedback"),
    // True once the responder clicked through to the public-review platform link.
    publicClicked: boolean("public_clicked").notNull().default(false),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("review_requests_org_idx").on(table.organizationId),
    // Token lookup for the public response page.
    uniqueIndex("review_requests_token_hash_unique").on(table.reviewTokenHash),
    // One review request per completed job (idempotency backstop to the ledger).
    uniqueIndex("review_requests_service_request_unique").on(
      table.serviceRequestId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Bot turn telemetry (CHATBOT-PLAN Step 10 prerequisite) — one row per resolved
// chat turn, capturing ONLY the routing/outcome SIGNALS the route already
// computes (deterministic-vs-LLM, intent, action, completion, escalation, model,
// latency). This is the aggregatable record behind the Insights "Bot analytics"
// section; the per-turn signals used to go only to pino->stdout.
//
// PII-FREE BY CONTRACT: no message text, no customer data — ids/enums/flags/
// numbers only. The write is best-effort and fired from after() so it can never
// fail or slow a customer turn (see src/lib/ai/bot-telemetry.ts).
//
// sessionId is a soft reference (NO hard FK) so a telemetry row can outlive a
// pruned/expired session and a write is never blocked by FK timing on the hot
// path. Tenant-scoped via organizationId like every other aggregate source.
export const botEvents = pgTable(
  "bot_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Soft reference to customer_sessions.id (no hard FK — see table note).
    sessionId: uuid("session_id"),
    // 1-based turn index within the session at the time of this event.
    turn: integer("turn").notNull(),
    // The medium the turn arrived over (mirrors sessionChannelEnum values).
    channel: text("channel").notNull().default("web"),
    // true  = the deterministic intent router resolved the turn (0 LLM tokens),
    // false = the turn fell back to the LLM.
    routed: boolean("routed").notNull(),
    // The winning intent id (router verdict), null on an LLM-fallback turn.
    intentId: text("intent_id"),
    // The router action / resolution label (ANSWER, SUBMIT, ESCALATE, …), null
    // on an LLM-fallback turn.
    action: text("action"),
    // The knowledge-base category of the winning intent, null when unknown.
    category: text("category"),
    // Whether the intake extraction was complete as of this turn.
    extractionComplete: boolean("extraction_complete").notNull().default(false),
    // Whether this turn escalated the session to a human.
    escalated: boolean("escalated").notNull().default(false),
    // Resolved model id for an LLM-fallback turn; null on a deterministic turn.
    model: text("model"),
    // End-to-end turn latency in ms; null when not measured.
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Period-scoped aggregates filter by org + createdAt.
    index("bot_events_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    // Intent-distribution rollups group by org + intent.
    index("bot_events_org_intent_idx").on(
      table.organizationId,
      table.intentId,
    ),
  ],
);

// platform_audit_log — cross-org, platform-operator audit trail for DESTRUCTIVE
// or evidence-bearing platform actions (tenant purge, tenant export). Crucially
// it is NOT FK'd to organizations: a purge DELETEs the org row (cascading every
// org-scoped table, including audit_log), so the evidence of the purge itself
// must live in a table that SURVIVES the cascade. targetOrgId is a plain uuid
// (no FK) for the same reason — it points at an org that may no longer exist.
// details is PII-free by contract (counts/ids/enums only), same as audit_log.
export const platformAuditLog = pgTable(
  "platform_audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    action: text("action").notNull(),
    // The platform admin who performed the action (their user id + email).
    // Nullable so a system/cron-initiated action can be recorded too.
    actorUserId: uuid("actor_user_id"),
    actorEmail: text("actor_email"),
    // The org the action targeted. NO FK — the org may be deleted by the action.
    targetOrgId: uuid("target_org_id"),
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("platform_audit_log_target_org_idx").on(table.targetOrgId),
    index("platform_audit_log_created_idx").on(table.createdAt),
  ],
);

// fp_import_runs — Observability ledger for FieldPulse full-import and
// nightly-sweep phases. Each row records one phase execution (technicians,
// customers, jobs, or invoices) with its outcome and row-level counts.
// Plain text for phase/status avoids enum migration churn when phases change.
// counts.lastPage is used as a resumability cursor if the run was interrupted.
export const fpImportRuns = pgTable(
  "fp_import_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // 'technicians' | 'customers' | 'jobs' | 'invoices' (plain text, not enum)
    phase: text("phase").notNull(),
    // 'running' | 'completed' | 'failed'
    status: text("status").notNull().default("running"),
    // { fetched, created, updated, skipped, errors, lastPage }
    counts: jsonb("counts").notNull().default({}),
    // Error message when status = 'failed'; null otherwise.
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("fp_import_runs_org_started_idx").on(
      table.organizationId,
      table.startedAt,
    ),
  ],
);
