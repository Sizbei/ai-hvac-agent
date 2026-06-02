/**
 * Demo data seeder — populates the admin dashboard with realistic conversations,
 * service requests, CRM customers, feedback, and audit history so the app looks
 * alive when shown to an audience.
 *
 * Idempotent-ish: it deletes prior demo-generated rows (tagged via a stable
 * `DEMO-` reference-number prefix and known session tokens) before re-inserting,
 * so it is safe to run repeatedly. Run AFTER `db:seed` (which creates the org,
 * admin, and technicians).
 *
 *   npm run db:seed       # base org + users  (run first)
 *   npm run db:seed:demo  # this script
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, like, inArray } from "drizzle-orm";
import * as schema from "./schema";
import { encrypt } from "../crypto";
import { DEFAULT_TOKEN_BUDGET, DEFAULT_MAX_TURNS } from "../ai/chat-limits";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const DEMO_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SESSION_TOKEN_PREFIX = "demo-seed-";

type Urgency = "low" | "medium" | "high" | "emergency";
type IssueType =
  | "heating_not_working"
  | "cooling_not_working"
  | "thermostat_issue"
  | "air_quality"
  | "strange_noises"
  | "water_leak"
  | "maintenance"
  | "installation"
  | "other";
type SessionStatus =
  | "chatting"
  | "extracting"
  | "confirmed"
  | "submitted"
  | "escalated"
  | "abandoned";
type RequestStatus =
  | "pending"
  | "assigned"
  | "in_progress"
  | "completed"
  | "cancelled";

interface SeedMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  /** 0 = answered by the deterministic router (no LLM); >0 = LLM fallback. */
  readonly tokens: number;
}

interface SeedConversation {
  readonly key: string;
  readonly daysAgo: number;
  readonly status: SessionStatus;
  readonly messages: readonly SeedMessage[];
  readonly extraction?: {
    readonly issueType: IssueType;
    readonly urgency: Urgency;
    readonly address: string;
    readonly customerName: string;
    readonly customerPhone: string;
    readonly customerEmail: string;
    readonly description: string;
  };
  /** Creates a service request in the admin queue when present. */
  readonly request?: {
    readonly status: RequestStatus;
    readonly assignTo?: string; // technician email
  };
  readonly feedback?: "up" | "down";
}

const BOT_GREETING =
  "Hi! I'm an AI HVAC assistant — I can help describe your issue and get a technician dispatched. What heating, cooling, or air quality issue are you having?";

const CONVERSATIONS: readonly SeedConversation[] = [
  {
    key: "ac-out-heatwave",
    daysAgo: 0,
    status: "submitted",
    messages: [
      { role: "user", content: "hi", tokens: 0 },
      { role: "assistant", content: BOT_GREETING, tokens: 0 },
      {
        role: "user",
        content: "My AC stopped cooling and it's 86 degrees inside with my kids home.",
        tokens: 0,
      },
      {
        role: "assistant",
        content:
          "That's really uncomfortable, especially with kids at home — let's get a technician out quickly. What's the service address?",
        tokens: 142,
      },
      { role: "user", content: "412 Maple Ave, Austin, TX 78704", tokens: 0 },
      {
        role: "assistant",
        content: "Got it. What's the best name and phone number for the technician to reach you?",
        tokens: 0,
      },
      {
        role: "user",
        content: "Jessica Nguyen, 512-555-0142, jess.nguyen@gmail.com",
        tokens: 0,
      },
      {
        role: "assistant",
        content:
          "Great — I have everything I need. I've created a high-priority service request and our team will reach out shortly to schedule.",
        tokens: 0,
      },
    ],
    extraction: {
      issueType: "cooling_not_working",
      urgency: "high",
      address: "412 Maple Ave, Austin, TX 78704",
      customerName: "Jessica Nguyen",
      customerPhone: "512-555-0142",
      customerEmail: "jess.nguyen@gmail.com",
      description: "AC stopped cooling during a heatwave; 86°F indoors with children at home.",
    },
    request: { status: "assigned", assignTo: "mike.johnson@demo-hvac.com" },
    feedback: "up",
  },
  {
    key: "furnace-noise",
    daysAgo: 1,
    status: "submitted",
    messages: [
      {
        role: "user",
        content: "my furnace is making a loud banging noise when it turns on",
        tokens: 0,
      },
      {
        role: "assistant",
        content:
          "A banging noise on startup is worth checking — it can be delayed ignition or a duct issue. Is it still producing heat, and what's the service address?",
        tokens: 167,
      },
      { role: "user", content: "yes still heating. 88 Birchwood Dr, Round Rock TX 78664", tokens: 0 },
      {
        role: "assistant",
        content: "Thanks. What name and phone number should we put on the request?",
        tokens: 0,
      },
      { role: "user", content: "Tom Becker 512-555-0199", tokens: 0 },
      {
        role: "assistant",
        content:
          "Great — I have everything I need. I've logged a service request and we'll be in touch to schedule a visit.",
        tokens: 0,
      },
    ],
    extraction: {
      issueType: "strange_noises",
      urgency: "medium",
      address: "88 Birchwood Dr, Round Rock, TX 78664",
      customerName: "Tom Becker",
      customerPhone: "512-555-0199",
      customerEmail: "tom.becker@outlook.com",
      description: "Furnace makes a loud banging noise on startup but still produces heat.",
    },
    request: { status: "in_progress", assignTo: "sarah.chen@demo-hvac.com" },
    feedback: "up",
  },
  {
    key: "no-heat-emergency-cold",
    daysAgo: 2,
    status: "submitted",
    messages: [
      {
        role: "user",
        content: "We have no heat at all and it's 28 degrees outside, house is freezing",
        tokens: 0,
      },
      {
        role: "assistant",
        content:
          "No heat in freezing weather is a priority — I'll mark this urgent. What's the service address so we can dispatch someone?",
        tokens: 158,
      },
      { role: "user", content: "1024 Cedar Lane, Cedar Park TX 78613", tokens: 0 },
      { role: "user", content: "Maria Lopez, 512-555-0177, maria.lopez@yahoo.com", tokens: 0 },
      {
        role: "assistant",
        content:
          "Great — I have everything I need. I've created an urgent service request and our dispatcher will call you right away.",
        tokens: 0,
      },
    ],
    extraction: {
      issueType: "heating_not_working",
      urgency: "high",
      address: "1024 Cedar Lane, Cedar Park, TX 78613",
      customerName: "Maria Lopez",
      customerPhone: "512-555-0177",
      customerEmail: "maria.lopez@yahoo.com",
      description: "Complete loss of heat with outdoor temperature at 28°F; home is very cold.",
    },
    request: { status: "completed", assignTo: "david.martinez@demo-hvac.com" },
    feedback: "up",
  },
  {
    key: "gas-leak-escalation",
    daysAgo: 2,
    status: "escalated",
    messages: [
      { role: "user", content: "I think I smell gas near my furnace", tokens: 0 },
      {
        role: "assistant",
        content:
          "A gas smell can be dangerous — please leave your home right now, avoid using any switches, phones, or flames inside, and once you're safely outside call your gas utility's emergency line or 911. I'm flagging this as an emergency so our team can follow up right away.",
        tokens: 0,
      },
    ],
  },
  {
    key: "thermostat-faq",
    daysAgo: 3,
    status: "abandoned",
    messages: [
      { role: "user", content: "do you charge for estimates?", tokens: 0 },
      {
        role: "assistant",
        content:
          "Estimates for new installations are free. Diagnostic visits for repairs have a service-call fee that's applied toward the repair if you proceed. Want me to help set up a visit?",
        tokens: 0,
      },
      { role: "user", content: "what are your hours", tokens: 0 },
      {
        role: "assistant",
        content:
          "We offer standard service Monday–Saturday, 8am–6pm, with 24/7 emergency support for issues like no heat, gas smells, or flooding.",
        tokens: 0,
      },
    ],
  },
  {
    key: "maintenance-tuneup",
    daysAgo: 4,
    status: "submitted",
    messages: [
      { role: "user", content: "I'd like to schedule a seasonal AC tune-up", tokens: 0 },
      {
        role: "assistant",
        content:
          "Happy to help schedule a maintenance tune-up. What's the service address and the best contact name and number?",
        tokens: 121,
      },
      {
        role: "user",
        content: "Dave Park, 737-555-0123, 55 Lakeshore Blvd Austin TX 78746, dpark@fastmail.com",
        tokens: 0,
      },
      {
        role: "assistant",
        content:
          "Great — I have everything I need. I've created a maintenance request and we'll reach out with available dates.",
        tokens: 0,
      },
    ],
    extraction: {
      issueType: "maintenance",
      urgency: "low",
      address: "55 Lakeshore Blvd, Austin, TX 78746",
      customerName: "Dave Park",
      customerPhone: "737-555-0123",
      customerEmail: "dpark@fastmail.com",
      description: "Customer requests a seasonal AC maintenance tune-up.",
    },
    request: { status: "pending" },
  },
  {
    key: "water-leak",
    daysAgo: 5,
    status: "submitted",
    messages: [
      {
        role: "user",
        content: "there's water pooling around the indoor unit of my AC",
        tokens: 0,
      },
      {
        role: "assistant",
        content:
          "Water around the indoor unit is usually a clogged condensate drain or a frozen coil. To prevent damage you can turn the system off. What's the service address?",
        tokens: 174,
      },
      { role: "user", content: "203 Oak Hill Ct, Pflugerville TX 78660. Name is Sam Reed 512-555-0188", tokens: 0 },
      {
        role: "assistant",
        content:
          "Great — I have everything I need. I've logged a service request and we'll get someone out to take a look.",
        tokens: 0,
      },
    ],
    extraction: {
      issueType: "water_leak",
      urgency: "medium",
      address: "203 Oak Hill Ct, Pflugerville, TX 78660",
      customerName: "Sam Reed",
      customerPhone: "512-555-0188",
      customerEmail: "sam.reed@gmail.com",
      description: "Water pooling around the indoor AC unit, likely a clogged condensate drain.",
    },
    request: { status: "assigned", assignTo: "mike.johnson@demo-hvac.com" },
    feedback: "down",
  },
  {
    key: "thermostat-wifi",
    daysAgo: 6,
    status: "abandoned",
    messages: [
      { role: "user", content: "hello", tokens: 0 },
      { role: "assistant", content: BOT_GREETING, tokens: 0 },
      {
        role: "user",
        content: "my smart thermostat won't connect to wifi after a power outage",
        tokens: 0,
      },
      {
        role: "assistant",
        content:
          "After an outage, thermostats often need to rejoin the network. Try resetting the thermostat's wifi from its settings menu and reconnecting. If it still won't connect, I can schedule a technician — want me to do that?",
        tokens: 156,
      },
    ],
  },
  {
    key: "install-quote",
    daysAgo: 8,
    status: "submitted",
    messages: [
      {
        role: "user",
        content: "I want a quote to replace my old AC unit, it's 15 years old",
        tokens: 0,
      },
      {
        role: "assistant",
        content:
          "A 15-year-old unit is a great candidate for replacement — newer systems are far more efficient. Estimates for installations are free. What's the address and a good contact?",
        tokens: 188,
      },
      {
        role: "user",
        content: "Priya Shah, 512-555-0210, priya.shah@gmail.com, 700 Vista Ridge, Leander TX 78641",
        tokens: 0,
      },
      {
        role: "assistant",
        content:
          "Great — I have everything I need. I've created a request for a replacement estimate and our team will reach out to schedule a site visit.",
        tokens: 0,
      },
    ],
    extraction: {
      issueType: "installation",
      urgency: "low",
      address: "700 Vista Ridge, Leander, TX 78641",
      customerName: "Priya Shah",
      customerPhone: "512-555-0210",
      customerEmail: "priya.shah@gmail.com",
      description: "Customer requesting a free estimate to replace a 15-year-old AC unit.",
    },
    request: { status: "completed" },
    feedback: "up",
  },
];

function generateReferenceNumber(index: number): string {
  // Stable, demo-tagged so we can find and clean these up on re-run.
  return `HVAC-DEMO${String(index).padStart(4, "0")}`;
}

async function clearPreviousDemoData(
  db: ReturnType<typeof drizzle>,
): Promise<void> {
  // Find demo sessions by token prefix, then cascade-delete their children.
  const sessions = await db
    .select({ id: schema.customerSessions.id })
    .from(schema.customerSessions)
    .where(like(schema.customerSessions.token, `${SESSION_TOKEN_PREFIX}%`));

  const sessionIds = sessions.map((s) => s.id);

  if (sessionIds.length > 0) {
    await db
      .delete(schema.serviceRequests)
      .where(inArray(schema.serviceRequests.sessionId, sessionIds));
    await db
      .delete(schema.auditLog)
      .where(inArray(schema.auditLog.sessionId, sessionIds));
    await db
      .delete(schema.messages)
      .where(inArray(schema.messages.sessionId, sessionIds));
    await db
      .delete(schema.customerSessions)
      .where(inArray(schema.customerSessions.id, sessionIds));
  }

  // Remove CRM customers created by this seeder (tagged in notes).
  await db
    .delete(schema.customers)
    .where(eq(schema.customers.notes, "seeded:demo"));
}

async function seedDemo(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  if (!process.env.ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY environment variable is required");
  }

  const sql = neon(process.env.DATABASE_URL);
  const db = drizzle(sql, { schema });

  console.log("Seeding demo conversations...");

  // Resolve technician IDs by email for assignment.
  const techRows = await db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.organizationId, DEMO_ORG_ID));
  const techByEmail = new Map(techRows.map((t) => [t.email, t.id]));
  const adminId = techByEmail.get("admin@demo-hvac.com") ?? null;

  await clearPreviousDemoData(db);

  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  let refIndex = 1;

  for (const convo of CONVERSATIONS) {
    const createdAt = new Date(now - convo.daysAgo * DAY_MS);
    const totalTokens = convo.messages.reduce((sum, m) => sum + m.tokens, 0);

    // 1. Session
    const [session] = await db
      .insert(schema.customerSessions)
      .values({
        organizationId: DEMO_ORG_ID,
        token: `${SESSION_TOKEN_PREFIX}${convo.key}`,
        status: convo.status,
        tokensUsed: totalTokens,
        tokenBudget: DEFAULT_TOKEN_BUDGET,
        turnCount: convo.messages.filter((m) => m.role === "user").length,
        maxTurns: DEFAULT_MAX_TURNS,
        metadata: convo.extraction
          ? JSON.stringify({
              ...convo.extraction,
              isHvacRelated: true,
            })
          : null,
        createdAt,
        updatedAt: createdAt,
      })
      .returning({ id: schema.customerSessions.id });

    // 2. Messages (timestamps marching forward within the conversation)
    let msgTime = createdAt.getTime();
    for (const m of convo.messages) {
      msgTime += 45_000; // ~45s between turns
      await db.insert(schema.messages).values({
        organizationId: DEMO_ORG_ID,
        sessionId: session.id,
        role: m.role,
        content: m.content,
        tokensUsed: m.role === "assistant" ? m.tokens : null,
        createdAt: new Date(msgTime),
      });
    }

    // 3. Service request (encrypted PII) for converted conversations
    if (convo.request && convo.extraction) {
      const ex = convo.extraction;
      const assignedTo = convo.request.assignTo
        ? (techByEmail.get(convo.request.assignTo) ?? null)
        : null;
      const completedAt =
        convo.request.status === "completed"
          ? new Date(msgTime + DAY_MS)
          : null;

      await db.insert(schema.serviceRequests).values({
        organizationId: DEMO_ORG_ID,
        sessionId: session.id,
        assignedTo,
        status: convo.request.status,
        issueType: ex.issueType,
        urgency: ex.urgency,
        description: ex.description,
        customerNameEncrypted: encrypt(ex.customerName),
        customerPhoneEncrypted: encrypt(ex.customerPhone),
        customerEmailEncrypted: encrypt(ex.customerEmail),
        addressEncrypted: encrypt(ex.address),
        referenceNumber: generateReferenceNumber(refIndex++),
        completedAt,
        createdAt,
        updatedAt: createdAt,
      });
    }

    // 4. Message feedback (audit log) — drives the AI Insights feedback widget
    if (convo.feedback) {
      await db.insert(schema.auditLog).values({
        organizationId: DEMO_ORG_ID,
        sessionId: session.id,
        action: "message_feedback",
        entity: "message",
        details: JSON.stringify({ vote: convo.feedback }),
        createdAt: new Date(msgTime + 30_000),
      });
    }

    console.log(`  Seeded conversation: ${convo.key} (${convo.status})`);
  }

  // 5. A couple of CRM customers so the Customers view isn't empty.
  const crmCustomers = [
    {
      name: "Jessica Nguyen",
      phone: "512-555-0142",
      email: "jess.nguyen@gmail.com",
      address: "412 Maple Ave, Austin, TX 78704",
      propertyType: "Single-family home",
      sqft: 2100,
    },
    {
      name: "Priya Shah",
      phone: "512-555-0210",
      email: "priya.shah@gmail.com",
      address: "700 Vista Ridge, Leander, TX 78641",
      propertyType: "Single-family home",
      sqft: 2800,
    },
  ];

  for (const c of crmCustomers) {
    const [customer] = await db
      .insert(schema.customers)
      .values({
        organizationId: DEMO_ORG_ID,
        nameEncrypted: encrypt(c.name),
        phoneEncrypted: encrypt(c.phone),
        emailEncrypted: encrypt(c.email),
        addressEncrypted: encrypt(c.address),
        propertyType: c.propertyType,
        propertySqft: c.sqft,
        notes: "seeded:demo",
      })
      .returning({ id: schema.customers.id });

    await db.insert(schema.customerEquipment).values({
      organizationId: DEMO_ORG_ID,
      customerId: customer.id,
      equipmentType: "ac",
      make: "Carrier",
      model: "24ACC6",
      locationInHome: "Side yard",
    });

    if (adminId) {
      await db.insert(schema.customerNotes).values({
        organizationId: DEMO_ORG_ID,
        customerId: customer.id,
        authorId: adminId,
        content: "Existing customer — prefers afternoon appointments.",
        noteType: "general",
      });
    }

    console.log(`  Seeded CRM customer: ${c.name}`);
  }

  console.log("Demo seeding complete!");
}

seedDemo().catch((error: unknown) => {
  console.error("Demo seeding failed:", error);
  process.exit(1);
});
