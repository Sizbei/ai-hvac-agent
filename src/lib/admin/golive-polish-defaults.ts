/**
 * Go-live polish of an org's shipped defaults (pure planning; the database work
 * lives in scripts/agent/golive-polish-defaults.mjs).
 *
 * Rows are found by stable keys (names, template keys), never by uuid, so one
 * plan works on dev and prod. Every change records its prior value, and undo
 * restores only fields still holding the value polish wrote.
 */

/**
 * The generic residential demo items seeded before go-live (never FieldPulse
 * items), by name AND seeded price. They were seeded on 2026-06-17, before the
 * 2026-07-09 dev/prod branch split, with no SKU; an item matches only with all
 * of that, so a real native item that happens to share a name is left alone.
 */
export const DEMO_PRICEBOOK: readonly { name: string; priceCents: number }[] = [
  { name: "3-Ton 16-SEER AC Condenser", priceCents: 489000 },
  { name: "80% Gas Furnace 60k BTU", priceCents: 359000 },
  { name: "AC Tune-Up", priceCents: 12900 },
  { name: "Air Filter (MERV 11)", priceCents: 3900 },
  { name: "Blower Motor Replacement", priceCents: 64900 },
  { name: "Capacitor Replacement", priceCents: 24900 },
  { name: "Diagnostic / Service Call", priceCents: 8900 },
  { name: "Full System Replace (3-Ton 16-SEER)", priceCents: 1289000 },
  { name: "Furnace Tune-Up", priceCents: 12900 },
  { name: "Hard-Start Kit", priceCents: 8900 },
  { name: "Refrigerant Recharge (R-410A, 2lb)", priceCents: 31900 },
  { name: "Smart Thermostat Install", priceCents: 38900 },
];

/** Demo items were all created before this instant (the dev/prod branch split). */
export const DEMO_SEEDED_BEFORE = new Date("2026-07-09T00:00:00Z");

/** The residential demo plan: matched on name, price and period together. */
export const DEMO_PLAN = { name: "Comfort Club", priceCents: 1900, billingPeriod: "monthly" } as const;

/** Seeded Title Case names → sentence case; "Job completed" becomes the visit canon. */
export const TEMPLATE_RENAMES: readonly { key: string; from: string; to: string }[] = [
  { key: "appointment_reminder_2h_sms", from: "2-Hour Reminder (SMS)", to: "2-hour reminder (SMS)" },
  { key: "appointment_reminder_24h_sms", from: "24-Hour Reminder (SMS)", to: "24-hour reminder (SMS)" },
  { key: "appointment_cancelled_sms", from: "Appointment Cancelled (SMS)", to: "Appointment cancelled (SMS)" },
  { key: "appointment_rescheduled_sms", from: "Appointment Rescheduled (SMS)", to: "Appointment rescheduled (SMS)" },
  { key: "appointment_scheduled_sms", from: "Appointment Scheduled (SMS)", to: "Appointment scheduled (SMS)" },
  { key: "estimate_sent_sms", from: "Estimate Sent (SMS)", to: "Estimate sent (SMS)" },
  { key: "follow_up_sms", from: "Follow Up (SMS)", to: "Follow-up (SMS)" },
  { key: "invoice_overdue_sms", from: "Invoice Overdue Reminder (SMS)", to: "Invoice overdue reminder (SMS)" },
  { key: "job_completed_email", from: "Job Completed (Email)", to: "Visit completed (email)" },
  { key: "job_completed_sms", from: "Job Completed (SMS)", to: "Visit completed (SMS)" },
  { key: "payment_receipt_sms", from: "Payment Receipt (SMS)", to: "Payment receipt (SMS)" },
  { key: "review_request_sms", from: "Review Request (SMS)", to: "Review request (SMS)" },
  { key: "technician_enroute_sms", from: "Technician En Route (SMS)", to: "Technician en route (SMS)" },
];

/** Spears navy, sampled from public/brand/spears-logo.png (the dominant fill). */
export const SPEARS_NAVY = "#16264a";

export type PolishTable = "pricebook_items" | "membership_plans" | "communication_templates" | "organization_settings";
export type PolishColumn = "active" | "name" | "primary_color";
export type PolishValue = boolean | string | null;

export interface PolishChange {
  table: PolishTable;
  /** Row id (organization_settings: the organization id). */
  id: string;
  column: PolishColumn;
  from: PolishValue;
  to: PolishValue;
  /** Human label for the dry-run listing. */
  label: string;
}

export interface PolishState {
  pricebook: {
    id: string;
    name: string;
    active: boolean;
    fieldpulseItemId: string | null;
    priceCents: number;
    sku: string | null;
    createdAt: Date;
  }[];
  plans: { id: string; name: string; priceCents: number; billingPeriod: string; active: boolean }[];
  templates: { id: string; key: string; name: string }[];
  /** null when the org has no settings row (polish then leaves the color alone). */
  settings: { organizationId: string; primaryColor: string | null } | null;
}

/** The changes --apply would make. Already-polished rows produce none (idempotent). */
export function planPolish(state: PolishState): PolishChange[] {
  const changes: PolishChange[] = [];
  const isDemoItem = (item: PolishState["pricebook"][number]) =>
    item.fieldpulseItemId === null &&
    item.sku === null &&
    item.createdAt < DEMO_SEEDED_BEFORE &&
    DEMO_PRICEBOOK.some((d) => d.name === item.name && d.priceCents === item.priceCents);
  for (const item of state.pricebook) {
    if (item.active && isDemoItem(item)) {
      changes.push({ table: "pricebook_items", id: item.id, column: "active", from: true, to: false, label: item.name });
    }
  }
  for (const plan of state.plans) {
    if (
      plan.active &&
      plan.name === DEMO_PLAN.name &&
      plan.priceCents === DEMO_PLAN.priceCents &&
      plan.billingPeriod === DEMO_PLAN.billingPeriod
    ) {
      changes.push({ table: "membership_plans", id: plan.id, column: "active", from: true, to: false, label: plan.name });
    }
  }
  const renames = new Map(TEMPLATE_RENAMES.map((r) => [r.key, r]));
  for (const template of state.templates) {
    const rename = renames.get(template.key);
    // Only the seeded name: a name staff already edited is theirs.
    if (rename && template.name === rename.from) {
      changes.push({
        table: "communication_templates",
        id: template.id,
        column: "name",
        from: rename.from,
        to: rename.to,
        label: `${rename.from} → ${rename.to}`,
      });
    }
  }
  if (state.settings && state.settings.primaryColor === null) {
    changes.push({
      table: "organization_settings",
      id: state.settings.organizationId,
      column: "primary_color",
      from: null,
      to: SPEARS_NAVY,
      label: `brand color → ${SPEARS_NAVY}`,
    });
  }
  return changes;
}

/** One field of one row: the key undo matches current values on. */
export const polishFieldKey = (c: Pick<PolishChange, "table" | "id" | "column">): string =>
  `${c.table}:${c.id}:${c.column}`;

/** Adds new changes to an earlier record, keeping the earliest prior value per field. */
export function mergeRecord(existing: readonly PolishChange[], next: readonly PolishChange[]): PolishChange[] {
  const seen = new Set(existing.map(polishFieldKey));
  return [...existing, ...next.filter((c) => !seen.has(polishFieldKey(c)))];
}

/**
 * Undo: restore each recorded field whose current value is still what polish
 * wrote. A field changed since (or a row gone) is skipped, never overwritten.
 */
export function planUndo(
  record: readonly PolishChange[],
  current: ReadonlyMap<string, PolishValue>,
): { restore: PolishChange[]; skipped: PolishChange[] } {
  const restore: PolishChange[] = [];
  const skipped: PolishChange[] = [];
  for (const change of record) {
    const key = polishFieldKey(change);
    if (current.has(key) && current.get(key) === change.to) {
      restore.push({ ...change, from: change.to, to: change.from });
    } else {
      skipped.push(change);
    }
  }
  return { restore, skipped };
}

/** Validates a record file read back from disk. Throws on anything unexpected. */
export function parsePolishRecord(raw: unknown): { host: string; org: string; changes: PolishChange[] } {
  if (typeof raw !== "object" || raw === null) throw new Error("record is not an object");
  const { host, org, changes } = raw as Record<string, unknown>;
  if (typeof host !== "string" || typeof org !== "string" || !Array.isArray(changes)) {
    throw new Error("record needs host, org and changes");
  }
  const tables = new Set<PolishTable>(["pricebook_items", "membership_plans", "communication_templates", "organization_settings"]);
  const columns = new Set<PolishColumn>(["active", "name", "primary_color"]);
  const isValue = (v: unknown) => v === null || typeof v === "boolean" || typeof v === "string";
  for (const c of changes as Record<string, unknown>[]) {
    if (
      typeof c !== "object" || c === null ||
      !tables.has(c.table as PolishTable) || !columns.has(c.column as PolishColumn) ||
      typeof c.id !== "string" || !isValue(c.from) || !isValue(c.to) || typeof c.label !== "string"
    ) {
      throw new Error("record has a malformed change");
    }
  }
  return { host, org, changes: changes as PolishChange[] };
}
