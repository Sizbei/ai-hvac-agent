import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.mock("server-only", () => ({}));

const executed: SQL[] = [];
const queue: Array<{ rows: unknown[] } | Error> = [];

vi.mock("@/lib/db", () => ({
  db: {
    execute: vi.fn(async (q: SQL) => {
      executed.push(q);
      const next = queue.shift() ?? { rows: [] };
      if (next instanceof Error) throw next;
      return next;
    }),
  },
}));

const warn = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: { warn: (...a: unknown[]) => warn(...a) } }));

import { getOnboarding, patchOnboarding } from "./onboarding-queries";

const ORG = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-11-04T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const OPTS = { demo: false, write: true, googleEnabled: false, appUrl: "https://app.example.com/", now: NOW };
const render = (q: SQL) => new PgDialect().sqlToQuery(q);
const flat = (q: SQL) => render(q).sql.replace(/\s+/g, " ");

function row(p: Record<string, unknown> = {}) {
  return {
    company_name: "Acme",
    phone: false,
    business_hours: false,
    logo_url: false,
    technician_ready: false,
    fp_passwordless: 0,
    tech_passwordless: 0,
    pending_invite: false,
    pricebook: false,
    any_request: false,
    booked_assigned: false,
    tech_signed_in_evidence: false,
    widget_key: false,
    allowed_origins: false,
    integration_connected: false,
    completed_request: false,
    org_created_at: "2026-11-01T00:00:00.000Z",
    onboarding_state: null,
    ...p,
  };
}

const stepOf = (p: Awaited<ReturnType<typeof getOnboarding>>, id: string) =>
  p.steps.find((s) => s.id === id)!;

beforeEach(() => {
  executed.length = 0;
  queue.length = 0;
  warn.mockReset();
});

describe("getOnboarding", () => {
  it("sends one statement when nothing needs a stamp and firstSeenAt is stored", async () => {
    queue.push({ rows: [row({ onboarding_state: { firstSeenAt: "2026-11-01T00:00:00.000Z" } })] });
    const p = await getOnboarding(ORG, OPTS);
    expect(executed).toHaveLength(1);
    expect(flat(executed[0])).toContain("AS tech_signed_in_evidence");
    expect(render(executed[0]).params).toContain(ORG);
    expect(p.progress).toEqual({ requiredDone: 0, requiredTotal: 4, optionalDone: 0, optionalTotal: 4 });
    expect(p.upNext).toBe("phone_hours");
    expect(p.dismissedAt).toBeNull();
    expect(p.completedSeenAt).toBeNull();
    expect(p.demo).toBe(false);
    expect(stepOf(p, "tech_sign_in").copyValue).toBe("https://app.example.com/tech-login");
  });

  it("first GET with nothing to stamp writes firstSeenAt only ($top-only, empty $keys)", async () => {
    queue.push({ rows: [row()] }, { rows: [] });
    const p = await getOnboarding(ORG, OPTS);
    expect(executed).toHaveLength(2);
    const params = render(executed[1]).params;
    expect(params).toContain(JSON.stringify({ firstSeenAt: NOW_ISO }));
    expect(params.filter((x) => Array.isArray(x))).toEqual([[], ["firstSeenAt"]]);
    expect(p.dismissedAt).toBeNull();
    expect(p).not.toHaveProperty("firstSeenAt");
  });

  it("maps every column to its signal", async () => {
    queue.push({
      rows: [
        row({
          phone: true, business_hours: true, logo_url: true, technician_ready: true,
          pricebook: true, booked_assigned: true, any_request: true, tech_signed_in_evidence: true,
          widget_key: true, allowed_origins: true, integration_connected: true,
          onboarding_state: {
            firstSeenAt: "2026-10-01T00:00:00.000Z",
            firstCompleted: Object.fromEntries(
              ["phone_hours", "brand", "add_technician", "pricebook", "book_first_request", "tech_sign_in", "chat_widget", "integrations"].map((k) => [k, "2026-10-01T00:00:00.000Z"]),
            ),
          },
        }),
      ],
    });
    const p = await getOnboarding(ORG, OPTS);
    expect(executed).toHaveLength(1);
    expect(p.progress).toEqual({ requiredDone: 4, requiredTotal: 4, optionalDone: 4, optionalTotal: 4 });
    expect(p.steps.every((s) => s.done && !s.needsAttention)).toBe(true);
  });

  it("reads fp_passwordless as a number (string from the driver)", async () => {
    queue.push({ rows: [row({ fp_passwordless: "2", onboarding_state: { firstCompleted: { brand: "2026-10-01T00:00:00.000Z" } } })] });
    const p = await getOnboarding(ORG, OPTS);
    expect(stepOf(p, "add_technician").note).toBe("2 technicians from FieldPulse can't sign in yet. Use Reset password in Staff.");
    expect(stepOf(p, "add_technician").hrefLabel).toBe("Set a password in Staff");
  });

  it("sends a second statement with the new stamps and reports the step done", async () => {
    queue.push({ rows: [row({ phone: true, business_hours: true, onboarding_state: { firstCompleted: { brand: "2026-10-01T00:00:00.000Z" } } })] }, { rows: [] });
    const p = await getOnboarding(ORG, OPTS);
    expect(executed).toHaveLength(2);
    const q = render(executed[1]);
    expect(q.sql).toContain("RETURNING onboarding_state");
    expect(q.params).toContain(JSON.stringify({ phone_hours: NOW_ISO }));
    expect(q.params).toContain(JSON.stringify({ firstSeenAt: NOW_ISO }));
    expect(q.params).toContainEqual(["phone_hours"]);
    expect(stepOf(p, "phone_hours").done).toBe(true);
    expect(p.progress.requiredDone).toBe(1);
    expect(p.upNext).toBe("add_technician");
  });

  it("grandfathers an old org: dismissedAt in the payload comes from top", async () => {
    queue.push({ rows: [row({ org_created_at: "2026-09-01T00:00:00.000Z", completed_request: true })] }, { rows: [] });
    const p = await getOnboarding(ORG, OPTS);
    expect(executed).toHaveLength(2);
    const params = render(executed[1]).params;
    expect(params).toContain(JSON.stringify({ firstSeenAt: NOW_ISO, dismissedAt: NOW_ISO }));
    expect(params).toContainEqual(["firstSeenAt", "dismissedAt"]);
    expect(p.dismissedAt).toBe(NOW_ISO);
    expect(p.completedSeenAt).toBeNull();
  });

  it("second GET (firstSeenAt stored, still no stamps): no grandfather write", async () => {
    queue.push({
      rows: [row({ org_created_at: "2026-09-01T00:00:00.000Z", completed_request: true, onboarding_state: { firstSeenAt: "2026-10-01T00:00:00.000Z" } })],
    });
    const p = await getOnboarding(ORG, OPTS);
    expect(executed).toHaveLength(1);
    expect(p.dismissedAt).toBeNull();
    expect(p.completedSeenAt).toBeNull();
  });

  it("grandfathers a finished org with completedSeenAt", async () => {
    queue.push({
      rows: [row({ phone: true, business_hours: true, technician_ready: true, booked_assigned: true, tech_signed_in_evidence: true })],
    }, { rows: [] });
    const p = await getOnboarding(ORG, OPTS);
    expect(executed).toHaveLength(2);
    const params = render(executed[1]).params;
    expect(params).toContain(JSON.stringify({ firstSeenAt: NOW_ISO, completedSeenAt: NOW_ISO }));
    expect(params).toContainEqual(["firstSeenAt", "completedSeenAt"]);
    expect(p.completedSeenAt).toBe(NOW_ISO);
  });

  it("keeps the stored dismissedAt over a fresh top value", async () => {
    queue.push({ rows: [row({ onboarding_state: { dismissedAt: "2026-10-02T00:00:00.000Z", completedSeenAt: "2026-10-03T00:00:00.000Z" } })] });
    const p = await getOnboarding(ORG, OPTS);
    expect(p.dismissedAt).toBe("2026-10-02T00:00:00.000Z");
    expect(p.completedSeenAt).toBe("2026-10-03T00:00:00.000Z");
  });

  it("sends one statement for the demo org even with stamps due", async () => {
    queue.push({ rows: [row({ phone: true, business_hours: true, org_created_at: "2026-01-01T00:00:00.000Z", completed_request: true })] });
    const p = await getOnboarding(ORG, { ...OPTS, demo: true });
    expect(executed).toHaveLength(1);
    expect(p.demo).toBe(true);
    expect(stepOf(p, "tech_sign_in").done).toBe(true);
    expect(stepOf(p, "phone_hours").done).toBe(true);
    expect(p.dismissedAt).toBeNull();
  });

  it("demo: stored dismissal fields never reach the payload (read-time rule)", async () => {
    queue.push({
      rows: [row({ onboarding_state: { dismissed: true, dismissedAt: "2026-10-02T00:00:00.000Z", completedSeenAt: "2026-10-03T00:00:00.000Z" } })],
    });
    const p = await getOnboarding(ORG, { ...OPTS, demo: true });
    expect(executed).toHaveLength(1);
    expect(p.dismissedAt).toBeNull();
    expect(p.completedSeenAt).toBeNull();
  });

  it("write:false (preview): one SELECT, no stamp, firstSeenAt or grandfather write", async () => {
    // A first GET on an old org with a step due: every write path would fire.
    queue.push({
      rows: [row({ phone: true, business_hours: true, org_created_at: "2026-01-01T00:00:00.000Z" })],
    });
    const p = await getOnboarding(ORG, { ...OPTS, write: false });
    expect(executed).toHaveLength(1);
    expect(flat(executed[0])).toContain("AS tech_signed_in_evidence");
    expect(stepOf(p, "phone_hours").done).toBe(true);
  });

  it("the same row with write:true does write (the preview test is meaningful)", async () => {
    queue.push({
      rows: [row({ phone: true, business_hours: true, org_created_at: "2026-01-01T00:00:00.000Z" })],
    });
    await getOnboarding(ORG, OPTS);
    expect(executed).toHaveLength(2);
  });

  it("still returns the payload when the stamp statement throws", async () => {
    queue.push({ rows: [row({ phone: true, business_hours: true })] }, new Error("boom"));
    const p = await getOnboarding(ORG, OPTS);
    expect(executed).toHaveLength(2);
    expect(stepOf(p, "phone_hours").done).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("tolerates a missing settings row (NULL columns)", async () => {
    queue.push({ rows: [row({ company_name: null, onboarding_state: null, org_created_at: null })] }, { rows: [] });
    const p = await getOnboarding(ORG, OPTS);
    expect(p.progress.requiredDone).toBe(0);
    // only the write-once firstSeenAt; the upsert is row-less safe
    expect(executed).toHaveLength(2);
    expect(render(executed[1]).params).toContain(JSON.stringify({ firstSeenAt: NOW_ISO }));
  });
});

describe("patchOnboarding", () => {
  it("demo: one SELECT, no upsert, the body applied onto the parsed state", async () => {
    queue.push({ rows: [{ onboarding_state: { dismissedAt: "2026-10-02T00:00:00.000Z", flags: {} } }] });
    const s = await patchOnboarding(
      ORG,
      { dismissed: true, completedSeen: true, flags: { embedCopied: true } },
      { demo: true, now: NOW },
    );
    expect(executed).toHaveLength(1);
    const q = render(executed[0]);
    expect(q.sql.replace(/\s+/g, " ")).toBe("SELECT onboarding_state FROM organization_settings WHERE organization_id = $1");
    expect(q.params).toEqual([ORG]);
    expect(s).toEqual({
      dismissedAt: "2026-10-02T00:00:00.000Z",
      completedSeenAt: NOW_ISO,
      firstCompleted: {},
      flags: { embedCopied: true },
    });
  });

  it("demo with no settings row returns the body applied onto an empty state", async () => {
    queue.push({ rows: [] });
    const s = await patchOnboarding(ORG, { dismissed: true }, { demo: true, now: NOW });
    expect(s).toEqual({ dismissedAt: NOW_ISO, firstCompleted: {}, flags: {} });
  });

  it("builds the flags statement with top and parses RETURNING", async () => {
    queue.push({ rows: [{ onboarding_state: { dismissedAt: NOW_ISO, flags: { embedCopied: true } } }] });
    const s = await patchOnboarding(ORG, { dismissed: true, flags: { embedCopied: true } }, { demo: false, now: NOW });
    expect(executed).toHaveLength(1);
    const q = render(executed[0]);
    expect(q.sql).toContain("INSERT INTO organization_settings");
    expect(q.sql).not.toContain("techSignedInAt");
    expect(q.params).toContain(ORG);
    expect(q.params).toContain(JSON.stringify({ dismissedAt: NOW_ISO }));
    expect(q.params).toContain(JSON.stringify({ embedCopied: true }));
    expect(s).toEqual({ dismissedAt: NOW_ISO, firstCompleted: {}, flags: { embedCopied: true } });
  });

  it("showOnHome removes dismissedAt with one UPDATE and parses RETURNING", async () => {
    queue.push({ rows: [{ onboarding_state: { firstSeenAt: NOW_ISO, flags: {} } }] });
    const s = await patchOnboarding(ORG, { showOnHome: true }, { demo: false, now: NOW });
    expect(executed).toHaveLength(1);
    const q = render(executed[0]);
    expect(q.sql.replace(/\s+/g, " ")).toBe(
      "UPDATE organization_settings SET onboarding_state = onboarding_state - 'dismissedAt' - 'dismissed' WHERE organization_id = $1 RETURNING onboarding_state",
    );
    expect(q.params).toEqual([ORG]);
    expect(s.dismissedAt).toBeUndefined();
    expect(s.firstSeenAt).toBe(NOW_ISO);
  });

  it("demo showOnHome: drops dismissedAt in memory, no write", async () => {
    queue.push({ rows: [{ onboarding_state: { dismissedAt: "2026-10-02T00:00:00.000Z", flags: {} } }] });
    const s = await patchOnboarding(ORG, { showOnHome: true }, { demo: true, now: NOW });
    expect(render(executed[0]).sql).toContain("SELECT");
    expect(s.dismissedAt).toBeUndefined();
  });

  it("completedSeen only: empty flags, completedSeenAt in top", async () => {
    queue.push({ rows: [{ onboarding_state: { completedSeenAt: NOW_ISO } }] });
    await patchOnboarding(ORG, { completedSeen: true }, { demo: false, now: NOW });
    const params = render(executed[0]).params;
    expect(params).toContain(JSON.stringify({ completedSeenAt: NOW_ISO }));
    expect(params).toContain(JSON.stringify({}));
  });
});
