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
    index("sessions_org_created_idx").on(table.organizationId, table.createdAt),
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
    propertyType: text("property_type"),
    propertySqft: integer("property_sqft"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("customers_org_id_idx").on(table.organizationId),
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
