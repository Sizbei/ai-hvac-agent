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
import { eq, like, inArray, or } from "drizzle-orm";
import * as schema from "./schema";
import { encrypt } from "../crypto";
import { DEFAULT_TOKEN_BUDGET, DEFAULT_MAX_TURNS } from "../ai/chat-limits";
import { type ArrivalWindow } from "../admin/arrival-window";
import {
  arrivalWindowUtcForBusinessDate,
  businessIsoDate,
  businessWallClockToUtc,
  businessWeekDates,
  toBusinessWallClock,
} from "../admin/calendar-time";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const DEMO_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SESSION_TOKEN_PREFIX = "demo-seed-";
// Separate token prefix for the capacity-consuming booked jobs (Stage 1 calendar
// robustness). These are intentionally NOT narrative conversations — they exist
// only to occupy band capacity so the bot's window-offer logic has something to
// route around. Kept on their own prefix so they clear/reseed independently.
const CAPACITY_SESSION_TOKEN_PREFIX = "demo-cap-";
// Demo-tagged reference-number prefix for the capacity booked jobs, so they're
// findable + removable on re-run (mirrors the HVAC-DEMO prefix scheme).
const CAPACITY_REF_PREFIX = "HVAC-CAP";

// ── Spears Services, Inc. brand/config (verified facts) ──
// Seeded into organizationSettings (JSONB columns — no migration). businessInfo
// keys mirror businessInfoSchema in org-config-types.ts so personalizeAnswer and
// the LLM brand block read from one source. afterHoursConfig keys mirror
// afterHoursConfigSchema (window only — no dollar fee; the bot discloses that a
// charge may apply without quoting an amount, and the team confirms the work).
const SPEARS_COMPANY_NAME = "Spears Services";
const SPEARS_BUSINESS_INFO = {
  phone: "423-854-9505",
  email: "office@spearsservices.com",
  serviceArea:
    "Northeast Tennessee, Southwest Virginia & Western North Carolina (Tri-Cities)",
} as const;
const SPEARS_AFTER_HOURS_CONFIG = {
  enabled: true,
  startHour: 17, // 5pm
  endHour: 8, // 8am — after-hours window wraps 5pm–8am
  weekendsAreAfterHours: true,
  timezone: "America/New_York", // Johnson City, TN is Eastern
} as const;

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
  /** "web" (default), "phone", or "sms" — the medium the conversation arrived over. */
  readonly channel?: "web" | "phone" | "sms";
  /** Optional rolling summary, shown in the admin detail for long conversations. */
  readonly runningSummary?: string;
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
    /**
     * Places the request on the scheduling calendar for the CURRENT business
     * week. `weekday` is 1=Mon … 5=Fri (matching the seeded Mon–Fri tech shifts);
     * `window` is the arrival band. When present we set scheduledDate +
     * arrivalWindowStart/End (UTC). Omit to leave the request in the unscheduled
     * panel so the badge + queue still demonstrate.
     */
    readonly schedule?: {
      readonly weekday: 1 | 2 | 3 | 4 | 5;
      readonly window: ArrivalWindow;
    };
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
    request: {
      status: "assigned",
      assignTo: "mike.johnson@demo-hvac.com",
      schedule: { weekday: 1, window: "morning" },
    },
    feedback: "up",
  },
  {
    key: "phone-no-heat",
    daysAgo: 0,
    status: "submitted",
    channel: "phone",
    runningSummary:
      "Caller Robert Alvarez phoned in: furnace producing no heat overnight with an infant in the home (high urgency). Confirmed service address 27 Larkspur Ln, Pflugerville, TX 78660 and callback number 512-555-0177; address was read back and confirmed.",
    messages: [
      {
        role: "assistant",
        content:
          "Thanks for calling. I'm the HVAC assistant. What issue are you having today?",
        tokens: 0,
      },
      {
        role: "user",
        content: "my furnace isn't putting out any heat and it got cold overnight",
        tokens: 0,
      },
      {
        role: "assistant",
        content:
          "I'm sorry to hear that, especially overnight. Let's get someone out to you. What's the service address?",
        tokens: 138,
      },
      { role: "user", content: "twenty seven larkspur lane pflugerville texas", tokens: 0 },
      {
        role: "assistant",
        content:
          "Let me repeat that back to make sure I have it right: 27 Larkspur Lane, Pflugerville, Texas. Is that correct?",
        tokens: 0,
      },
      { role: "user", content: "yes that's right", tokens: 0 },
      {
        role: "assistant",
        content:
          "Thank you. How urgent is this — is it an emergency, or can it wait a little while?",
        tokens: 0,
      },
      { role: "user", content: "it's pretty urgent, we have a baby in the house", tokens: 0 },
      {
        role: "assistant",
        content: "Understood. What's the best name and callback number for the technician?",
        tokens: 0,
      },
      { role: "user", content: "Robert Alvarez, five one two, five five five, zero one seven seven", tokens: 0 },
      {
        role: "assistant",
        content:
          "Great — I have everything I need. I'll get this over to our team and a technician will be in touch to schedule. Is there anything else I can help you with?",
        tokens: 0,
      },
    ],
    extraction: {
      issueType: "heating_not_working",
      urgency: "high",
      address: "27 Larkspur Ln, Pflugerville, TX 78660",
      customerName: "Robert Alvarez",
      customerPhone: "512-555-0177",
      customerEmail: "robert.alvarez@gmail.com",
      description:
        "Phone call: furnace producing no heat overnight with an infant in the home.",
    },
    request: { status: "pending" },
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
    request: {
      status: "in_progress",
      assignTo: "sarah.chen@demo-hvac.com",
      schedule: { weekday: 2, window: "afternoon" },
    },
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
    request: {
      status: "assigned",
      assignTo: "mike.johnson@demo-hvac.com",
      schedule: { weekday: 3, window: "morning" },
    },
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
  // ── Calendar-fill conversations ──
  // Short, already-extracted requests whose only job is to populate the
  // scheduling calendar across the current week (Mon–Fri × the three techs), so
  // the day AND week views show cards and the conflict/availability shading is
  // exercised. They reuse the same converted-conversation pipeline (session +
  // messages + encrypted service request) as the narrative conversations above.
  {
    key: "cal-tuneup-tue-am",
    daysAgo: 1,
    status: "submitted",
    messages: [
      { role: "user", content: "I'd like to book a furnace tune-up for this week", tokens: 0 },
      {
        role: "assistant",
        content: "Happy to help. What's the service address and a good contact?",
        tokens: 96,
      },
      {
        role: "user",
        content: "Grace Liu, 423-555-0231, 19 Sycamore St, Johnson City TN 37601, grace.liu@gmail.com",
        tokens: 0,
      },
      {
        role: "assistant",
        content: "Great — I've created a maintenance request and we'll be in touch to confirm.",
        tokens: 0,
      },
    ],
    extraction: {
      issueType: "maintenance",
      urgency: "low",
      address: "19 Sycamore St, Johnson City, TN 37601",
      customerName: "Grace Liu",
      customerPhone: "423-555-0231",
      customerEmail: "grace.liu@gmail.com",
      description: "Seasonal furnace tune-up requested for this week.",
    },
    request: {
      status: "assigned",
      assignTo: "mike.johnson@demo-hvac.com",
      schedule: { weekday: 2, window: "morning" },
    },
  },
  {
    key: "cal-coil-wed-pm",
    daysAgo: 1,
    status: "submitted",
    messages: [
      { role: "user", content: "my AC isn't cooling well, I think the coil is dirty", tokens: 0 },
      {
        role: "assistant",
        content: "We can take a look. What's the address and best contact name and number?",
        tokens: 112,
      },
      {
        role: "user",
        content: "Hector Ramirez, 423-555-0245, 88 Watauga Ave, Johnson City TN 37601",
        tokens: 0,
      },
      {
        role: "assistant",
        content: "Great — I've logged a service request and we'll schedule a visit.",
        tokens: 0,
      },
    ],
    extraction: {
      issueType: "cooling_not_working",
      urgency: "medium",
      address: "88 Watauga Ave, Johnson City, TN 37601",
      customerName: "Hector Ramirez",
      customerPhone: "423-555-0245",
      customerEmail: "hector.ramirez@gmail.com",
      description: "AC cooling poorly; suspected dirty evaporator coil.",
    },
    request: {
      status: "assigned",
      assignTo: "sarah.chen@demo-hvac.com",
      schedule: { weekday: 3, window: "afternoon" },
    },
  },
  {
    key: "cal-thermostat-thu-am",
    daysAgo: 2,
    status: "submitted",
    messages: [
      { role: "user", content: "thermostat screen is blank, want someone to check it", tokens: 0 },
      {
        role: "assistant",
        content: "Sure — what's the service address and a good contact?",
        tokens: 88,
      },
      {
        role: "user",
        content: "Nina Patel, 423-555-0260, 305 Cherokee Rd, Johnson City TN 37604",
        tokens: 0,
      },
      {
        role: "assistant",
        content: "Great — I've created a request and we'll reach out to schedule.",
        tokens: 0,
      },
    ],
    extraction: {
      issueType: "thermostat_issue",
      urgency: "medium",
      address: "305 Cherokee Rd, Johnson City, TN 37604",
      customerName: "Nina Patel",
      customerPhone: "423-555-0260",
      customerEmail: "nina.patel@gmail.com",
      description: "Thermostat display is blank; needs diagnosis.",
    },
    request: {
      status: "assigned",
      assignTo: "david.martinez@demo-hvac.com",
      schedule: { weekday: 4, window: "morning" },
    },
  },
  {
    key: "cal-install-thu-pm",
    daysAgo: 2,
    status: "submitted",
    messages: [
      { role: "user", content: "I want an estimate to install a mini-split in my garage", tokens: 0 },
      {
        role: "assistant",
        content: "Estimates are free. What's the address and best contact?",
        tokens: 104,
      },
      {
        role: "user",
        content: "Owen Fischer, 423-555-0272, 12 Knob Creek Rd, Johnson City TN 37604",
        tokens: 0,
      },
      {
        role: "assistant",
        content: "Great — I've created a request for a site visit and we'll be in touch.",
        tokens: 0,
      },
    ],
    extraction: {
      issueType: "installation",
      urgency: "low",
      address: "12 Knob Creek Rd, Johnson City, TN 37604",
      customerName: "Owen Fischer",
      customerPhone: "423-555-0272",
      customerEmail: "owen.fischer@gmail.com",
      description: "Free estimate requested for a garage mini-split installation.",
    },
    request: {
      status: "assigned",
      assignTo: "mike.johnson@demo-hvac.com",
      schedule: { weekday: 4, window: "afternoon" },
    },
  },
  {
    key: "cal-airquality-fri-am",
    daysAgo: 3,
    status: "submitted",
    messages: [
      { role: "user", content: "the air in the house feels really dusty, can someone check the filtration", tokens: 0 },
      {
        role: "assistant",
        content: "We can assess your air quality. What's the address and a good contact?",
        tokens: 118,
      },
      {
        role: "user",
        content: "Carla Mendez, 423-555-0288, 47 Buffalo St, Johnson City TN 37604",
        tokens: 0,
      },
      {
        role: "assistant",
        content: "Great — I've logged a request and we'll schedule a visit.",
        tokens: 0,
      },
    ],
    extraction: {
      issueType: "air_quality",
      urgency: "low",
      address: "47 Buffalo St, Johnson City, TN 37604",
      customerName: "Carla Mendez",
      customerPhone: "423-555-0288",
      customerEmail: "carla.mendez@gmail.com",
      description: "Persistent dust indoors; customer wants air filtration assessed.",
    },
    request: {
      status: "assigned",
      assignTo: "sarah.chen@demo-hvac.com",
      schedule: { weekday: 5, window: "morning" },
    },
  },
  {
    key: "cal-noise-fri-pm",
    daysAgo: 3,
    status: "submitted",
    messages: [
      { role: "user", content: "outdoor unit is rattling loudly, want it looked at", tokens: 0 },
      {
        role: "assistant",
        content: "We'll get someone out. What's the service address and best contact?",
        tokens: 92,
      },
      {
        role: "user",
        content: "Derek Shaw, 423-555-0294, 920 Indian Ridge Rd, Johnson City TN 37604",
        tokens: 0,
      },
      {
        role: "assistant",
        content: "Great — I've created a service request and we'll be in touch to schedule.",
        tokens: 0,
      },
    ],
    extraction: {
      issueType: "strange_noises",
      urgency: "medium",
      address: "920 Indian Ridge Rd, Johnson City, TN 37604",
      customerName: "Derek Shaw",
      customerPhone: "423-555-0294",
      customerEmail: "derek.shaw@gmail.com",
      description: "Outdoor condenser unit rattling loudly; needs inspection.",
    },
    request: {
      status: "assigned",
      assignTo: "david.martinez@demo-hvac.com",
      schedule: { weekday: 5, window: "afternoon" },
    },
  },
  {
    key: "cal-evening-mon",
    daysAgo: 0,
    status: "submitted",
    messages: [
      { role: "user", content: "can someone come after work hours to check my heat pump", tokens: 0 },
      {
        role: "assistant",
        content: "We have early-evening slots. What's the address and a good contact?",
        tokens: 101,
      },
      {
        role: "user",
        content: "Tara Wolfe, 423-555-0301, 6 Unaka Ave, Johnson City TN 37604",
        tokens: 0,
      },
      {
        role: "assistant",
        content: "Great — I've created a request and we'll confirm the evening window.",
        tokens: 0,
      },
    ],
    extraction: {
      issueType: "heating_not_working",
      urgency: "medium",
      address: "6 Unaka Ave, Johnson City, TN 37604",
      customerName: "Tara Wolfe",
      customerPhone: "423-555-0301",
      customerEmail: "tara.wolfe@gmail.com",
      description: "Heat pump short-cycling; customer requests an evening visit.",
    },
    request: {
      status: "assigned",
      assignTo: "sarah.chen@demo-hvac.com",
      schedule: { weekday: 1, window: "evening" },
    },
  },
];

function generateReferenceNumber(index: number): string {
  // Stable, demo-tagged so we can find and clean these up on re-run.
  return `HVAC-DEMO${String(index).padStart(4, "0")}`;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The next business-tz weekday (Mon–Fri) STRICTLY after `fromIsoDay`, as a
 * YYYY-MM-DD business date. Steps a day at a time off the day's Eastern noon
 * instant (DST-safe, same convention as businessDaysFrom) and skips Sat/Sun.
 * Used to anchor the capacity-consuming booked jobs on a real working day so the
 * seeded shifts (Mon–Fri) always cover the band we're filling.
 */
function nextBusinessDayAfter(fromIsoDay: string): string {
  let cursor = businessWallClockToUtc(fromIsoDay, 12, 0);
  for (let guard = 0; guard < 14; guard += 1) {
    cursor = new Date(cursor.getTime() + MS_PER_DAY);
    const wall = toBusinessWallClock(cursor);
    const weekday = new Date(
      Date.UTC(wall.year, wall.month - 1, wall.day),
    ).getUTCDay();
    if (weekday >= 1 && weekday <= 5) {
      const mm = String(wall.month).padStart(2, "0");
      const dd = String(wall.day).padStart(2, "0");
      return `${wall.year}-${mm}-${dd}`;
    }
  }
  // Unreachable in practice (a 14-day window always contains a weekday).
  throw new Error("nextBusinessDayAfter: no weekday found within 14 days");
}

async function clearPreviousDemoData(
  db: ReturnType<typeof drizzle>,
): Promise<void> {
  // Find demo sessions by token prefix, then cascade-delete their children.
  // Matches BOTH the narrative-conversation sessions and the capacity booked-job
  // sessions so a re-run clears every seeder-owned session (and its requests).
  const sessions = await db
    .select({ id: schema.customerSessions.id })
    .from(schema.customerSessions)
    .where(
      or(
        like(schema.customerSessions.token, `${SESSION_TOKEN_PREFIX}%`),
        like(schema.customerSessions.token, `${CAPACITY_SESSION_TOKEN_PREFIX}%`),
      ),
    );

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

  // Remove CRM customers created by this seeder (tagged in notes). Delete the
  // child rows (equipment + notes) FIRST — they carry a FK to customers, so a
  // bare customers delete fails the constraint on a re-run that left children
  // behind. Resolve the demo customer ids, then cascade down manually.
  const demoCustomers = await db
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(eq(schema.customers.notes, "seeded:demo"));
  const demoCustomerIds = demoCustomers.map((c) => c.id);
  if (demoCustomerIds.length > 0) {
    await db
      .delete(schema.customerEquipment)
      .where(inArray(schema.customerEquipment.customerId, demoCustomerIds));
    await db
      .delete(schema.customerNotes)
      .where(inArray(schema.customerNotes.customerId, demoCustomerIds));
    await db
      .delete(schema.customers)
      .where(inArray(schema.customers.id, demoCustomerIds));
  }

  // Remove the recurring technician availability for the demo org. These rows
  // aren't session-linked, so they're cleared by org id; reseeded below. Keeps
  // the seed re-runnable without piling up duplicate shifts.
  await db
    .delete(schema.technicianAvailability)
    .where(eq(schema.technicianAvailability.organizationId, DEMO_ORG_ID));
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

  // Org config (Spears brand + after-hours). JSONB columns — no migration.
  // Idempotent upsert keyed on the org PK; only the brand-relevant columns are
  // set, everything else keeps its existing/default value.
  await db
    .insert(schema.organizationSettings)
    .values({
      organizationId: DEMO_ORG_ID,
      companyName: SPEARS_COMPANY_NAME,
      businessInfo: SPEARS_BUSINESS_INFO,
      afterHoursConfig: SPEARS_AFTER_HOURS_CONFIG,
    })
    .onConflictDoUpdate({
      target: schema.organizationSettings.organizationId,
      set: {
        companyName: SPEARS_COMPANY_NAME,
        businessInfo: SPEARS_BUSINESS_INFO,
        afterHoursConfig: SPEARS_AFTER_HOURS_CONFIG,
        updatedAt: new Date(),
      },
    });
  console.log("  Seeded org config: Spears Services (brand + after-hours)");

  // ── Technician recurring availability (Mon–Fri 8:00–17:00 Eastern) ──
  // One row per technician per weekday. dayOfWeek is 0=Sun … 6=Sat; start/end are
  // minutes-from-midnight in the BUSINESS timezone (see technicianAvailability
  // schema). 8:00–17:00 → 480–1020. Cleared per-org in clearPreviousDemoData.
  const WORK_START_MINUTE = 8 * 60; // 480
  const WORK_END_MINUTE = 17 * 60; // 1020
  const WEEKDAYS = [1, 2, 3, 4, 5] as const; // Mon–Fri
  const TECH_EMAILS = [
    "mike.johnson@demo-hvac.com",
    "sarah.chen@demo-hvac.com",
    "david.martinez@demo-hvac.com",
  ] as const;

  let availabilityRows = 0;
  for (const email of TECH_EMAILS) {
    const technicianId = techByEmail.get(email);
    if (!technicianId) continue; // base seed not run for this tech — skip safely
    for (const dayOfWeek of WEEKDAYS) {
      await db.insert(schema.technicianAvailability).values({
        organizationId: DEMO_ORG_ID,
        technicianId,
        dayOfWeek,
        startMinute: WORK_START_MINUTE,
        endMinute: WORK_END_MINUTE,
      });
      availabilityRows += 1;
    }
  }
  console.log(
    `  Seeded technician availability: ${availabilityRows} rows (Mon–Fri 8:00–17:00)`,
  );

  // ── Capacity-consuming booked jobs (Stage 1 calendar robustness) ──
  // These are dummy BOOKED jobs (status "scheduled" — an ACTIVE_BOOKING_STATUS)
  // with concrete arrival windows that OCCUPY band capacity, so the bot's
  // window-offer logic (computeOpenWindows → buildWindowPrompt) has something to
  // route around. The scenario, on the NEXT business day after today:
  //   • MORNING  fully booked — one job per active tech (8–12) → available 0.
  //   • AFTERNOON / EVENING left open — no capacity jobs → still bookable.
  //   • A LATER business day (the next business day after that) left fully open.
  // Arrival windows are built with businessWallClockToUtc so the band hours are
  // Eastern wall-clock (matching arrival-window.ts: morning [8,12), afternoon
  // [12,16), evening [16,20)) — we do NOT hand-roll timezone math. Each job gets
  // its own minimal session (capacity token prefix) so it's a valid FK target and
  // is cleared on re-run alongside the narrative sessions.
  const todayIso = businessIsoDate(new Date());
  const fullyBookedDay = nextBusinessDayAfter(todayIso); // morning full here
  const openLaterDay = nextBusinessDayAfter(fullyBookedDay); // left fully open
  const activeTechIds = TECH_EMAILS
    .map((email) => techByEmail.get(email))
    .filter((id): id is string => Boolean(id));

  let capacitySessionIndex = 0;
  let capacityRefIndex = 1;
  let capacityJobs = 0;
  for (const technicianId of activeTechIds) {
    // One MORNING (8–12 Eastern) job per active tech on the fully-booked day.
    const morningStart = businessWallClockToUtc(fullyBookedDay, 8, 0);
    const morningEnd = businessWallClockToUtc(fullyBookedDay, 12, 0);

    const [capSession] = await db
      .insert(schema.customerSessions)
      .values({
        organizationId: DEMO_ORG_ID,
        token: `${CAPACITY_SESSION_TOKEN_PREFIX}${capacitySessionIndex++}`,
        status: "submitted",
        channel: "web",
        tokensUsed: 0,
        tokenBudget: DEFAULT_TOKEN_BUDGET,
        turnCount: 0,
        maxTurns: DEFAULT_MAX_TURNS,
      })
      .returning({ id: schema.customerSessions.id });

    await db.insert(schema.serviceRequests).values({
      organizationId: DEMO_ORG_ID,
      sessionId: capSession.id,
      assignedTo: technicianId,
      // "scheduled" is an ACTIVE_BOOKING_STATUS → genuinely consumes capacity.
      status: "scheduled",
      issueType: "maintenance",
      urgency: "low",
      description:
        "Seeded capacity hold — books a morning slot so the next business day's morning band reads as full.",
      customerNameEncrypted: encrypt("Capacity Hold"),
      referenceNumber: `${CAPACITY_REF_PREFIX}${String(capacityRefIndex++).padStart(4, "0")}`,
      scheduledDate: morningStart,
      arrivalWindowStart: morningStart,
      arrivalWindowEnd: morningEnd,
    });
    capacityJobs += 1;
  }
  console.log(
    `  Seeded ${capacityJobs} capacity booked jobs: morning FULL on ${fullyBookedDay} ` +
      `(afternoon/evening open), ${openLaterDay} left fully open`,
  );

  // ── Current business week (Eastern), Sunday-first ── so seeded jobs always
  // land in the week the calendar is showing. It's a seed SCRIPT, so reading the
  // runtime clock here is intentional and fine. weekDates[1..5] = Mon..Fri.
  const weekDates = businessWeekDates(businessIsoDate(new Date()));

  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  let refIndex = 1;
  let scheduledJobs = 0;

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
        channel: convo.channel ?? "web",
        runningSummary: convo.runningSummary ?? null,
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

      // Place on the calendar when a schedule is given. We resolve the arrival
      // window via arrivalWindowUtcForBusinessDate (the SAME helper the live
      // reschedule/calendar path uses): it interprets the window hours as Eastern
      // wall-clock and converts to UTC, so the card lands on the correct grid row.
      // (arrival-window.ts's arrivalWindowForDate applies the hours in UTC, which
      // would shift a "morning" job to ~4 AM Eastern in summer and fall off the
      // 7 AM–8 PM grid — wrong for a calendar that renders in Eastern.) All three
      // columns are persisted UTC.
      const sched = convo.request.schedule;
      const placement =
        sched && !completedAt
          ? arrivalWindowUtcForBusinessDate(weekDates[sched.weekday], sched.window)
          : null;
      if (placement) scheduledJobs += 1;

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
        scheduledDate: placement ? placement.start : null,
        arrivalWindowStart: placement ? placement.start : null,
        arrivalWindowEnd: placement ? placement.end : null,
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

  console.log(
    `  Scheduled ${scheduledJobs} jobs across the current week (Mon–Fri × techs)`,
  );
  console.log("Demo seeding complete!");
}

seedDemo().catch((error: unknown) => {
  console.error("Demo seeding failed:", error);
  process.exit(1);
});
