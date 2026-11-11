import { describe, expect, it } from "vitest";
import {
  DEMO_PRICEBOOK,
  SPEARS_NAVY,
  TEMPLATE_RENAMES,
  mergeRecord,
  parsePolishRecord,
  planPolish,
  planUndo,
  polishFieldKey,
  type PolishChange,
  type PolishState,
  type PolishValue,
} from "./golive-polish-defaults";

const ORG = "00000000-0000-0000-0000-000000000001";
const SEEDED = new Date("2026-06-17T03:49:37Z");

/** A native pricebook row; defaults are the seeded demo item of that name. */
function item(id: string, name: string, over: Partial<PolishState["pricebook"][number]> = {}): PolishState["pricebook"][number] {
  const priceCents = DEMO_PRICEBOOK.find((d) => d.name === name)?.priceCents ?? 0;
  return { id, name, active: true, fieldpulseItemId: null, priceCents, sku: null, createdAt: SEEDED, ...over };
}

function state(overrides: Partial<PolishState> = {}): PolishState {
  return {
    pricebook: [
      item("p1", "AC Tune-Up"),
      item("p2", "AC Tune-Up", { fieldpulseItemId: "fp-9" }),
      item("p3", "Hard-Start Kit", { active: false }),
      item("p4", "Walk-in cooler PM", { priceCents: 50000 }),
      item("p5", "AC Tune-Up", { priceCents: 14900 }),
      item("p6", "AC Tune-Up", { sku: "ACT-1" }),
      item("p7", "AC Tune-Up", { createdAt: new Date("2026-11-11T12:00:00Z") }),
    ],
    plans: [
      { id: "m1", name: "Comfort Club", priceCents: 1900, billingPeriod: "monthly", active: true },
      { id: "m2", name: "Comfort Club", priceCents: 4900, billingPeriod: "monthly", active: true },
    ],
    templates: [
      { id: "t1", key: "job_completed_sms", name: "Job Completed (SMS)" },
      { id: "t2", key: "follow_up_sms", name: "Our own follow-up" },
      { id: "t3", key: "invoice_sent_sms", name: "Invoice ready (SMS)" },
    ],
    settings: { organizationId: ORG, primaryColor: null },
    ...overrides,
  };
}

describe("planPolish", () => {
  it("deactivates only seeded demo items (name, price, no SKU, pre-split), the demo plan, seeded names and an unset color", () => {
    const changes = planPolish(state());
    expect(changes.map((c) => `${c.table}:${c.id}:${String(c.to)}`)).toEqual([
      "pricebook_items:p1:false",
      "membership_plans:m1:false",
      "communication_templates:t1:Visit completed (SMS)",
      `organization_settings:${ORG}:${SPEARS_NAVY}`,
    ]);
  });

  it("is idempotent: the polished state plans nothing", () => {
    const polished = state({
      pricebook: [item("p1", "AC Tune-Up", { active: false })],
      plans: [{ id: "m1", name: "Comfort Club", priceCents: 1900, billingPeriod: "monthly", active: false }],
      templates: [{ id: "t1", key: "job_completed_sms", name: "Visit completed (SMS)" }],
      settings: { organizationId: ORG, primaryColor: "#123456" },
    });
    expect(planPolish(polished)).toEqual([]);
  });

  it("leaves the color alone when the org has no settings row", () => {
    expect(planPolish(state({ settings: null })).some((c) => c.table === "organization_settings")).toBe(false);
  });

  it("renames to sentence case and the visit canon", () => {
    expect(DEMO_PRICEBOOK).toHaveLength(12);
    expect(TEMPLATE_RENAMES).toHaveLength(13);
    for (const r of TEMPLATE_RENAMES) {
      expect(r.to).not.toMatch(/\bJob\b/);
      // Sentence case: no capital after the first word except the SMS acronym.
      expect(r.to.split(" ").slice(1).filter((w) => /^[A-Z]/.test(w) && w !== "(SMS)")).toEqual([]);
    }
    expect(SPEARS_NAVY).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("mergeRecord", () => {
  it("keeps the earliest prior value for a field and appends new fields", () => {
    const a: PolishChange = { table: "pricebook_items", id: "p1", column: "active", from: true, to: false, label: "x" };
    const again: PolishChange = { ...a, from: false };
    const b: PolishChange = { ...a, id: "p2" };
    expect(mergeRecord([a], [again, b])).toEqual([a, b]);
  });
});

describe("planUndo", () => {
  const record = planPolish(state());

  it("restores fields still holding the polished value", () => {
    const current = new Map<string, PolishValue>(record.map((c) => [polishFieldKey(c), c.to]));
    const { restore, skipped } = planUndo(record, current);
    expect(skipped).toEqual([]);
    expect(restore.map((c) => c.to)).toEqual([true, true, "Job Completed (SMS)", null]);
  });

  it("skips fields edited since, and rows that are gone", () => {
    const [item, plan, template, colour] = record;
    const current = new Map<string, PolishValue>([
      [polishFieldKey(item), false],
      [polishFieldKey(template), "Owner's name"],
      [polishFieldKey(colour), "#ff0000"],
    ]);
    const { restore, skipped } = planUndo(record, current);
    expect(restore.map((c) => c.id)).toEqual([item.id]);
    expect(skipped).toEqual([plan, template, colour]);
  });
});

describe("parsePolishRecord", () => {
  it("round-trips a record and rejects malformed ones", () => {
    const changes = planPolish(state());
    expect(parsePolishRecord(JSON.parse(JSON.stringify({ host: "h", org: ORG, changes }))).changes).toEqual(changes);
    expect(() => parsePolishRecord(null)).toThrow();
    expect(() => parsePolishRecord({ host: "h", org: ORG, changes: [{ table: "users" }] })).toThrow();
  });
});
