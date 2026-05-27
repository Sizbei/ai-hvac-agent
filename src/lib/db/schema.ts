import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  pgEnum,
  index,
  varchar,
} from "drizzle-orm/pg-core";

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
  "in_progress",
  "completed",
  "cancelled",
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
    metadata: text("metadata"),
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
    assignedTo: uuid("assigned_to").references(() => users.id),
    status: requestStatusEnum("status").notNull().default("pending"),
    issueType: text("issue_type").notNull(),
    urgency: urgencyEnum("urgency").notNull(),
    description: text("description").notNull(),
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
  ],
);

// 6. audit_log
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
