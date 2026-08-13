#!/usr/bin/env node
/**
 * Seed a fully-furnished FICTIONAL org on the DEV Neon branch so demos,
 * screenshots and multi-tenant checks never touch real customer data.
 *
 *   npx tsx scripts/agent/seed-org.mjs --name "Blue Valley Heating"
 *   npx tsx scripts/agent/seed-org.mjs --name "Cedar Gap HVAC" --customers 20 --invoices 40
 *   npx tsx scripts/agent/seed-org.mjs --name "Blue Valley Heating" --force
 *
 * Creates, through the same signup-path provisioning the product uses
 * (createOrgCore → org + settings + seeded comms templates): an owner
 * super_admin, two technicians, N customers, a 10-item pricebook, a default tax
 * rate, an aged invoice ledger (open / partial / paid, with line items and
 * payments — some collected this month) and a spread of completed/scheduled
 * service requests so customer cards show real booking counts.
 *
 * All content is invented: 555-01xx phones, .example domains, fictional people
 * and businesses at plausible East-Tennessee addresses. The name pools are
 * sampled with a PRNG seeded from the org slug, so every org gets a different
 * cast and re-running the same name reproduces it.
 *
 * Refuses to run against prod (ep-withered-hill). If the derived slug already
 * exists it aborts; --force deletes that ONE org first (the cascade is
 * org-scoped — no other tenant's rows are touched).
 *
 * Prints the org id, the owner login, per-entity counts, and the
 * `MINT_ORG_ID=… npx tsx scripts/agent/mint-admin-session.mjs` line that mints a
 * session scoped to the new tenant.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── 0. Re-exec under the react-server condition ───────────────────────────────
// src/lib/admin/provisioning.ts imports "server-only", whose export map resolves
// only under that condition. Setting it here (rather than making every caller
// remember NODE_OPTIONS) keeps the documented usage a plain `npx tsx`.
if (!(process.env.NODE_OPTIONS ?? "").includes("react-server")) {
  try {
    execFileSync(
      "npx",
      ["tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      {
        stdio: "inherit",
        env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" },
      },
    );
  } catch (error) {
    process.exit(typeof error?.status === "number" ? error.status : 1);
  }
  process.exit(0);
}

// ── 1. Env + args ────────────────────────────────────────────────────────────
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = { name: null, customers: 12, invoices: 25, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force") {
      parsed.force = true;
    } else if (arg === "--name" || arg === "--customers" || arg === "--invoices") {
      const value = argv[i + 1];
      if (value === undefined) fail(`missing value for ${arg}`);
      i += 1;
      if (arg === "--name") parsed.name = value;
      else parsed[arg.slice(2)] = Number(value);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (!parsed.name?.trim()) fail('usage: npx tsx scripts/agent/seed-org.mjs --name "Blue Valley Heating" [--customers 12] [--invoices 25] [--force]');
  if (!Number.isInteger(parsed.customers) || parsed.customers < 1 || parsed.customers > 60) {
    fail("--customers must be an integer between 1 and 60");
  }
  if (!Number.isInteger(parsed.invoices) || parsed.invoices < 0 || parsed.invoices > 300) {
    fail("--invoices must be an integer between 0 and 300");
  }
  return { ...parsed, name: parsed.name.trim() };
}

const args = parseArgs(process.argv.slice(2));

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl) fail("DATABASE_URL not set (expected in .env.local)");
if (databaseUrl.includes("ep-withered-hill")) {
  fail("refusing to seed: DATABASE_URL points at PROD (ep-withered-hill)");
}

// ── 2. Deterministic PRNG, seeded from the org name ──────────────────────────
function makeRng(seed) {
  let h = 2166136261;
  for (const ch of seed) {
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(args.name.toLowerCase());
/** Uniform integer in [min, max]. */
const int = (min, max) => min + Math.floor(rng() * (max - min + 1));
const pick = (list) => list[Math.floor(rng() * list.length)];
/** Draw `count` distinct values from a pool (falls back to numbered suffixes). */
function pickUnique(list, count) {
  const seen = new Set();
  const out = [];
  let guard = 0;
  while (out.length < count && guard < count * 200) {
    guard += 1;
    const value = pick(list);
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  while (out.length < count) out.push(`${pick(list)} ${out.length}`);
  return out;
}

// ── 3. Fictional name / place pools ──────────────────────────────────────────
const FIRST_NAMES = ["Marcus", "Priya", "Denise", "Hollis", "Yvette", "Trevor", "Camila", "Wes", "Dana", "Rosalie", "Emmett", "Nadia", "Corey", "Imani", "Beau", "Sylvia", "Rafael", "Junie", "Weston", "Odessa", "Lamar", "Greta", "Miles", "Tabitha"];
const LAST_NAMES = ["Ellison", "Raman", "Cobb", "Barrett", "Sandoval", "Nunn", "Ortiz", "Hollan", "Whitfield", "Pruitt", "Dagley", "Marsh", "Fontaine", "Whitaker", "Bledsoe", "Keough", "Ambrose", "Tillman", "Rickard", "Vance", "Sowell", "Odom", "Beecham", "Larkin"];
const BUSINESS_HEADS = ["Riverside", "Summit", "Blue Ridge", "Hilltop", "Cherokee", "Northside", "Boone Creek", "Watauga", "Laurel Fork", "Copper Kettle", "Old Mill", "Iron Bridge", "Poplar Grove", "Stonewall", "Fern Hollow", "Buffalo Ridge"];
const BUSINESS_TAILS = ["Bakery", "Dental", "Brewing", "Motel", "Auto Works", "Veterinary Clinic", "Outfitters", "Print Shop", "Coffee Roasters", "Fitness Club", "Day School", "Hardware", "Physical Therapy", "Diner", "Storage", "Tool & Die"];
const STREETS = ["W Walnut St", "Knob Creek Rd", "S Roan St", "E Oakland Ave", "Buffalo St", "N Roan St", "Cardinal Dr", "Fairidge Dr", "Sunset Dr", "Bristol Hwy", "Maple St", "Boone Ridge Ln", "Cherry Grove Rd", "Antioch Rd", "Milligan Hwy", "Lakeview Dr", "Cedar Creek Rd", "Indian Ridge Rd"];
const TOWNS = [
  ["Johnson City", "37601"],
  ["Johnson City", "37604"],
  ["Johnson City", "37615"],
  ["Jonesborough", "37659"],
  ["Elizabethton", "37643"],
  ["Kingsport", "37660"],
  ["Erwin", "37650"],
  ["Gray", "37615"],
];
const AREA_CODES = ["423", "865", "931"];
const BRAND_COLORS = ["#1d4ed8", "#0f766e", "#b45309", "#7c3aed", "#be123c", "#15803d"];

const areaCode = pick(AREA_CODES);
const phoneFor = (index) => `(${areaCode}) 555-0${100 + (index % 100)}`;
const addressFor = () => {
  const [town, zip] = pick(TOWNS);
  return `${int(100, 3900)} ${pick(STREETS)}, ${town}, TN ${zip}`;
};
const slugify = (value) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const daysAgo = (days) => new Date(Date.now() - days * 86_400_000);
const ref = () => `HVAC-${randomBytes(4).toString("hex").toUpperCase()}`;

// ── 4. Server-side modules (dynamic: they need the env loaded above) ─────────
const { db } = await import("../../src/lib/db/index.ts");
const schema = await import("../../src/lib/db/schema.ts");
const { encrypt } = await import("../../src/lib/crypto.ts");
const { createOrgCore, deriveSlug } = await import(
  "../../src/lib/admin/provisioning.ts"
);
const { upsertCustomerByContact } = await import(
  "../../src/lib/admin/crm-queries.ts"
);
const { eq } = await import("drizzle-orm");

const slug = deriveSlug(args.name);
if (!slug) fail(`--name "${args.name}" has no usable characters for a slug`);
const domain = `${slug}.example`;

const [existing] = await db
  .select({ id: schema.organizations.id })
  .from(schema.organizations)
  .where(eq(schema.organizations.slug, slug))
  .limit(1);
if (existing) {
  if (!args.force) {
    fail(
      `org "${slug}" already exists (${existing.id}). Re-run with --force to delete and reseed it.`,
    );
  }
  // Org-scoped only: every tenant table FKs organizations.id ON DELETE CASCADE,
  // so this removes exactly this org's rows and nothing else.
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, existing.id));
  console.log(`--force: deleted existing org ${existing.id}`);
}

// ── 5. Org + settings + comms templates (the self-serve signup path) ─────────
/** Zip two distinct-value draws into `count` distinct "First Last" names. */
function fullNames(firstPool, lastPool, count) {
  const firsts = pickUnique(firstPool, count);
  const lasts = pickUnique(lastPool, count);
  return firsts.map((first, i) => `${first} ${lasts[i]}`);
}

// Staff names come from ONE draw so the owner and the technicians are three
// distinct people (and three distinct, globally-unique emails).
const [ownerName, ...techNames] = fullNames(FIRST_NAMES, LAST_NAMES, 3);
const staffEmail = (name) => `${slugify(name).replaceAll("-", ".")}@${domain}`;
const ownerEmail = staffEmail(ownerName);

const created = await createOrgCore({
  name: args.name,
  createdBy: null,
  ownerEmail: null,
  ownerUser: {
    email: ownerEmail,
    name: ownerName,
    googleId: `seed-org-${slug}-${randomUUID()}`,
  },
  slugConflictIsTerminal: true,
});
if (!created.ok) fail(`createOrgCore failed: ${created.error.kind}`);
const orgId = created.result.organizationId;

const orgPhone = `(${areaCode}) 555-0${int(100, 199)}`;
const taxBps = pick([925, 950, 975]);
await db
  .update(schema.organizationSettings)
  .set({
    companyName: args.name,
    primaryColor: pick(BRAND_COLORS),
    welcomeMessage: `Hi! I'm the ${args.name} assistant. How can I help with your heating or cooling today?`,
    launcherPosition: "bottom-right",
    businessInfo: {
      phone: orgPhone,
      email: `service@${domain}`,
      serviceArea: `${addressFor()} — serving Johnson City, Jonesborough, Elizabethton, and Kingsport`,
      businessHours: "Monday–Friday 7:30am–6:00pm, Saturday 8:00am–noon",
      licensedInsured: `Licensed and insured in Tennessee (TN HVAC #00${int(10000, 99999)})`,
      paymentMethods: "Cash, check, all major cards, and financing",
      financingAvailable: true,
    },
    onboardingState: { dismissed: true, embedViewed: true },
    updatedAt: new Date(),
  })
  .where(eq(schema.organizationSettings.organizationId, orgId));

await db.insert(schema.taxRates).values({
  organizationId: orgId,
  name: "TN state + county",
  jurisdiction: "Washington County, TN",
  rateBps: taxBps,
  isDefault: true,
  active: true,
});

// ── 6. Technicians ───────────────────────────────────────────────────────────
const techIds = [];
for (const name of techNames) {
  const id = randomUUID();
  await db.insert(schema.users).values({
    id,
    organizationId: orgId,
    email: staffEmail(name),
    name,
    role: "technician",
    isActive: true,
  });
  techIds.push(id);
}

// ── 7. Customers ─────────────────────────────────────────────────────────────
const commercialCount = Math.floor(args.customers * 0.4);
const businessNames = fullNames(
  BUSINESS_HEADS,
  BUSINESS_TAILS,
  commercialCount,
);
const peopleNames = fullNames(
  FIRST_NAMES,
  LAST_NAMES,
  args.customers - commercialCount,
);

const customers = [];
for (const [index, name] of [...businessNames, ...peopleNames].entries()) {
  const isCommercial = index < businessNames.length;
  const address = addressFor();
  const id = await upsertCustomerByContact(orgId, {
    name,
    phone: phoneFor(index),
    email: isCommercial
      ? `office@${slugify(name)}.example`
      : `${slugify(name)}@mailbox.example`,
    address,
  });
  await db
    .update(schema.customers)
    .set({
      customerType: isCommercial ? "commercial" : "residential",
      propertyType: isCommercial ? "commercial" : "single_family",
      updatedAt: new Date(),
    })
    .where(eq(schema.customers.id, id));
  customers.push({ id, name, address });
}

// ── 8. Pricebook ─────────────────────────────────────────────────────────────
const skuPrefix =
  args.name
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 3) || "HV";
const PRICEBOOK = [
  ["Diagnostic Service Call", "service", 12900, 4500, "DIAG", 1],
  ["Blower Motor Replacement", "service", 64900, 24900, "BLWR", 3],
  ["Capacitor Replacement", "service", 24900, 3800, "CAP", 1],
  ["Condenser Fan Motor Replacement", "service", 58900, 21500, "CFAN", 2],
  ["Evaporator Coil Replacement", "service", 189900, 78000, "COIL", 6],
  ["Refrigerant Recharge — R-410A per lb", "material", 8900, 3200, "R410", null],
  ["Annual Maintenance Plan", "service", 24900, 7500, "MAINT", 2],
  ["Smart Wi-Fi Thermostat Upgrade", "equipment", 44900, 17500, "TSTAT", 1],
  ["Ductwork Sealing — per system", "service", 79900, 28000, "DUCT", 5],
  ["Gas Furnace Replacement — 80k BTU", "equipment", 429900, 198000, "FURN", 8],
];

for (const [name, type, priceCents, costCents, sku, hours] of PRICEBOOK) {
  await db.insert(schema.pricebookItems).values({
    organizationId: orgId,
    type,
    name,
    sku: `${skuPrefix}-${sku}`,
    costCents,
    priceCents,
    markupPct: Math.round(((priceCents - costCents) / costCents) * 100),
    hours,
    active: true,
    warranty:
      type === "equipment" ? "10-year parts, 1-year labor" : "1-year labor",
  });
}

// ── 9. Invoices + line items + payments ──────────────────────────────────────
// Six open / three paid / one partial per ten, aged oldest-first so the AR
// tiles show a real overdue tail. The first two paid invoices are pinned inside
// the current calendar month so "collected this month" is never $0.
const OUTCOMES = ["open", "open", "paid", "open", "partial", "paid", "open", "open", "paid", "open"];
const dayOfMonth = new Date().getUTCDate();

let invoiceCount = 0;
let lineItemCount = 0;
let paymentCount = 0;
let collectedThisMonthCents = 0;
let openBalanceCents = 0;
let pinnedThisMonth = 0;

const monthStart = new Date(
  Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
);

for (let i = 0; i < args.invoices && customers.length > 0; i += 1) {
  let outcome = OUTCOMES[i % OUTCOMES.length];
  // Age curve: oldest first, clustering toward recent (520 days → 4 days).
  let issuedDaysAgo =
    4 + Math.round(516 * ((args.invoices - i) / args.invoices) ** 2.2);

  const pinToThisMonth = outcome === "paid" && pinnedThisMonth < 2;
  if (pinToThisMonth) {
    pinnedThisMonth += 1;
    issuedDaysAgo = dayOfMonth + 3;
  }

  const lines = pickUnique(PRICEBOOK, int(1, 3)).map((item) => ({
    name: item[0],
    qty: item[1] === "material" ? int(1, 4) : 1,
    unit: item[2],
    cost: item[3],
  }));
  const subtotalCents = lines.reduce((sum, l) => sum + l.unit * l.qty, 0);
  const taxCents = Math.round((subtotalCents * taxBps) / 10_000);
  const totalCents = subtotalCents + taxCents;

  let amountPaidCents = 0;
  let paymentDaysAgo = null;
  if (outcome === "paid") {
    amountPaidCents = totalCents;
    paymentDaysAgo = pinToThisMonth
      ? int(0, Math.max(0, dayOfMonth - 1))
      : Math.max(0, issuedDaysAgo - int(3, 20));
  } else if (outcome === "partial") {
    amountPaidCents = Math.round(totalCents * 0.35);
    paymentDaysAgo = Math.max(0, issuedDaysAgo - int(2, 10));
    if (amountPaidCents >= totalCents) outcome = "paid";
  }

  const state = amountPaidCents >= totalCents && totalCents > 0 ? "paid" : "open";
  const issuedAt = daysAgo(issuedDaysAgo);
  const invoiceId = randomUUID();
  const customer = customers[i % customers.length];
  // Chased AR: older unpaid invoices have had a reminder go out recently.
  const reminded = state === "open" && issuedDaysAgo > 60 && rng() < 0.5;

  await db.insert(schema.invoices).values({
    id: invoiceId,
    organizationId: orgId,
    customerId: customer.id,
    state,
    subtotalCents,
    taxCents,
    totalCents,
    amountPaidCents,
    issuedAt,
    dueDate: new Date(issuedAt.getTime() + 30 * 86_400_000),
    createdAt: issuedAt,
    updatedAt: issuedAt,
    lastReminderSentAt: reminded ? daysAgo(int(1, 10)) : null,
  });
  invoiceCount += 1;
  if (state === "open") openBalanceCents += totalCents - amountPaidCents;

  await db.insert(schema.invoiceLineItems).values(
    lines.map((l) => ({
      organizationId: orgId,
      invoiceId,
      name: l.name,
      quantity: l.qty,
      unitPriceCents: l.unit,
      costCents: l.cost * l.qty,
      lineTotalCents: l.unit * l.qty,
    })),
  );
  lineItemCount += lines.length;

  if (amountPaidCents > 0 && paymentDaysAgo !== null) {
    const paidAt = daysAgo(paymentDaysAgo);
    await db.insert(schema.payments).values({
      organizationId: orgId,
      invoiceId,
      provider: "mock",
      providerPaymentId: `mock_${slug}_${i}_${randomUUID().slice(0, 8)}`,
      amountCents: amountPaidCents,
      status: "succeeded",
      isDeposit: amountPaidCents < totalCents,
      createdAt: paidAt,
      updatedAt: paidAt,
    });
    paymentCount += 1;
    if (paidAt >= monthStart) collectedThisMonthCents += amountPaidCents;
  }
}

// ── 10. Service requests (booking history + a few upcoming) ──────────────────
const JOB_KINDS = [
  ["cooling_not_working", "no_cool", "high", "Evaporator coil iced over; system not holding temperature."],
  ["cooling_not_working", "service_call", "medium", "Low on refrigerant; space runs warm by mid-afternoon."],
  ["heating_not_working", "no_heat", "emergency", "Furnace down overnight with no backup heat."],
  ["heating_not_working", "install", "high", "Furnace replacement scheduled after repeated failures."],
  ["strange_noises", "diagnostic", "medium", "Hard-start rattle from the outdoor condenser."],
  ["strange_noises", "service_call", "high", "Grinding from the indoor unit; blower motor replacement."],
  ["thermostat_issue", "service_call", "low", "Thermostat losing its schedule; upgraded to a smart model."],
  ["air_quality", "service_call", "low", "Uneven room temperatures; duct sealing across the runs."],
  ["maintenance", "maintenance", "low", "Seasonal maintenance visit and filter changeout."],
];

let requestCount = 0;
let scheduledCount = 0;
// Every customer gets 1–3 completed jobs; the first few also get one upcoming
// visit so the calendar/dispatch board isn't purely historical.
const upcomingFor = new Set(
  customers.slice(0, Math.min(3, customers.length)).map((c) => c.id),
);

for (const customer of customers) {
  const jobs = int(1, 3) + (upcomingFor.has(customer.id) ? 1 : 0);
  for (let j = 0; j < jobs; j += 1) {
    const [issueType, jobType, urgency, description] = pick(JOB_KINDS);
    const scheduled = j === 0 && upcomingFor.has(customer.id);
    const at = scheduled ? daysAgo(-int(1, 6)) : daysAgo(int(5, 420));
    const status = scheduled ? "scheduled" : "completed";
    const sessionId = randomUUID();

    await db.insert(schema.customerSessions).values({
      id: sessionId,
      organizationId: orgId,
      token: `seed-${sessionId}`,
      status: "submitted",
      customerId: customer.id,
      createdAt: at,
      updatedAt: at,
    });

    await db.insert(schema.serviceRequests).values({
      organizationId: orgId,
      sessionId,
      customerId: customer.id,
      assignedTo: techIds[requestCount % techIds.length],
      status,
      issueType,
      jobType,
      urgency,
      description,
      referenceNumber: ref(),
      customerNameEncrypted: encrypt(customer.name),
      addressEncrypted: encrypt(customer.address),
      scheduledDate: at,
      arrivalWindowStart: at,
      arrivalWindowEnd: new Date(at.getTime() + 2 * 3_600_000),
      completedAt: status === "completed" ? new Date(at.getTime() + 2 * 3_600_000) : null,
      createdAt: at,
      updatedAt: at,
    });
    requestCount += 1;
    if (scheduled) scheduledCount += 1;
  }
}

// ── 11. Report ───────────────────────────────────────────────────────────────
const money = (cents) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

console.log("");
console.log(`Seeded fictional org "${args.name}"`);
console.log(`  org id        ${orgId}`);
console.log(`  slug          ${slug}`);
console.log(`  owner         ${ownerName} <${ownerEmail}> (super_admin, ${created.result.ownerUserId})`);
console.log("");
console.log(`  technicians   ${techIds.length} (${techNames.join(", ")})`);
console.log(`  customers     ${customers.length}`);
console.log(`  pricebook     ${PRICEBOOK.length}`);
console.log(`  tax rate      ${(taxBps / 100).toFixed(2)}% (default)`);
console.log(`  invoices      ${invoiceCount} (${lineItemCount} line items, ${paymentCount} payments)`);
console.log(`  open balance  ${money(openBalanceCents)}`);
console.log(`  collected MTD ${money(collectedThisMonthCents)}`);
console.log(`  requests      ${requestCount} (${scheduledCount} scheduled, ${requestCount - scheduledCount} completed)`);
console.log("");
console.log("Mint a session scoped to this org:");
console.log(`  MINT_ORG_ID=${orgId} npx tsx scripts/agent/mint-admin-session.mjs`);
console.log("");
