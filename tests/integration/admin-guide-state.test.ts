import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Integration suite for the per-user admin guide (onboarding D1, migration
 * 0060) against the DEV database (`VITEST_INTEGRATION=1`). Two throwaway orgs,
 * neither the demo org; each is deleted (cascade) in afterAll.
 *
 * The session and the request cookies are the only things mocked: the real
 * route handlers, viewer resolver (platform admin + signed preview cookie +
 * target lookup) and SQL run against the dev branch.
 */

let session: Record<string, unknown> | null = null;
let cookieJar: Record<string, string> = {};
vi.mock("@/lib/auth/session", () => ({ getAdminSession: async () => session }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name in cookieJar ? { name, value: cookieJar[name] } : undefined),
  }),
}));

type Db = typeof import("@/lib/db");
type Row = Record<string, unknown>;
type Route = typeof import("@/app/api/admin/onboarding/route");
type GuideRoute = typeof import("@/app/api/admin/guide/route");
type Q = typeof import("@/lib/admin/admin-guide-queries");

const ORIGIN = "https://app.example.com";
const T1 = new Date("2026-11-10T12:00:00.000Z");
const T2 = new Date("2026-11-11T12:00:00.000Z");
const T3 = new Date("2026-11-12T12:00:00.000Z");

let db: Db["db"];
let sql: typeof import("drizzle-orm").sql;
let NextRequest: typeof import("next/server").NextRequest;
let onboarding: Route;
let guideRoute: GuideRoute;
let q: Q;
let signPreviewCookie: typeof import("@/lib/auth/preview-cookie").signPreviewCookie;

let orgA = "";
let orgB = "";
let platformId = "";
let platformEmail = "";
let chickId = "";
let otherAdminId = "";
let techId = "";
let inactiveId = "";
let bAdminId = "";
const savedEnv: Record<string, string | undefined> = {};

async function run(statement: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute(statement)).rows as Row[];
}

async function guideText(userId: string): Promise<string | null> {
  const rows = await run(sql`SELECT admin_guide_state::text AS t FROM users WHERE id = ${userId}`);
  return (rows[0]?.t as string | null | undefined) ?? null;
}

async function guideObj(userId: string): Promise<Record<string, unknown> | null> {
  const t = await guideText(userId);
  return t === null ? null : JSON.parse(t);
}

async function onboardingText(org: string): Promise<string | null> {
  const rows = await run(
    sql`SELECT onboarding_state::text AS t FROM organization_settings WHERE organization_id = ${org}`,
  );
  return (rows[0]?.t as string | null | undefined) ?? null;
}

async function addUser(org: string, name: string, role: string, active = true): Promise<string> {
  const rows = await run(
    sql`INSERT INTO users (organization_id,email,name,role,password_hash,is_active) VALUES (${org},${`${role}-${randomUUID()}@throwaway.example`},${name},${role},'x',${active}) RETURNING id`,
  );
  return rows[0].id as string;
}

function sessionFor(userId: string, org: string, email: string, role = "super_admin") {
  return { userId, organizationId: org, email, name: "Probe", role };
}

function getReq(cookie?: string) {
  return new NextRequest(`${ORIGIN}/api/admin/onboarding`, { headers: cookie ? { cookie } : {} });
}

function patchReq(body: unknown, cookie?: string) {
  return new NextRequest(`${ORIGIN}/api/admin/guide`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function previewCookieFor(targetUserId: string): Promise<string> {
  return signPreviewCookie(
    { adminUserId: platformId, targetUserId, exp: Math.floor(Date.now() / 1000) + 600 },
    process.env.AUTH_SECRET ?? "",
  );
}

beforeAll(async () => {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL missing from .env.local");
  if (url.includes("ep-withered-hill")) {
    throw new Error("Refusing to run against the production database");
  }
  if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET missing from .env.local");
  ({ sql } = await import("drizzle-orm"));
  ({ db } = await import("@/lib/db"));
  ({ NextRequest } = await import("next/server"));
  ({ signPreviewCookie } = await import("@/lib/auth/preview-cookie"));
  onboarding = await import("@/app/api/admin/onboarding/route");
  guideRoute = await import("@/app/api/admin/guide/route");
  q = await import("@/lib/admin/admin-guide-queries");
  const { createOrgCore } = await import("@/lib/admin/provisioning");

  const make = async (label: string, ownerEmail: string, ownerName: string) => {
    const out = await createOrgCore({
      name: `Probe Guide Org ${label} ${randomUUID().slice(0, 8)}`,
      createdBy: null,
      ownerEmail: null,
      ownerUser: { email: ownerEmail, name: ownerName, googleId: `probe-${randomUUID()}` },
      skipOrgCountCheck: true,
    });
    if (!out.ok) throw new Error(`createOrgCore failed: ${JSON.stringify(out.error)}`);
    return { org: out.result.organizationId as string, owner: out.result.ownerUserId as string };
  };
  platformEmail = `platform-${randomUUID()}@throwaway.example`;
  const a = await make("A", platformEmail, "Probe Platform Owner");
  orgA = a.org;
  platformId = a.owner;
  const b = await make("B", `owner-${randomUUID()}@throwaway.example`, "Probe B Owner");
  orgB = b.org;
  bAdminId = b.owner;
  chickId = await addUser(orgA, "Probe Chick", "admin");
  otherAdminId = await addUser(orgA, "Probe Other Admin", "admin");
  techId = await addUser(orgA, "Probe Technician", "technician");
  inactiveId = await addUser(orgA, "Probe Inactive Admin", "admin", false);

  for (const k of ["PLATFORM_ADMIN_EMAILS", "PLATFORM_ORG_ID", "DEMO_MODE_ORG_IDS"]) savedEnv[k] = process.env[k];
  // The probe owner is the platform admin of org A for this suite only.
  process.env.PLATFORM_ADMIN_EMAILS = ` ${platformEmail.toUpperCase()} `;
  process.env.PLATFORM_ORG_ID = orgA;
  const demo = (process.env.DEMO_MODE_ORG_IDS ?? "").split(",").map((s) => s.trim());
  for (const org of [orgA, orgB]) {
    if (demo.includes(org) || org === process.env.DEMO_ORG_ID || org === "00000000-0000-0000-0000-000000000001") {
      throw new Error("A throwaway org collided with a demo/live org id");
    }
  }
}, 60_000);

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const id of [orgA, orgB]) {
    if (!id) continue;
    try {
      await db.execute(sql`DELETE FROM organizations WHERE id = ${id}`);
    } catch (error) {
      console.error(`afterAll: could not delete probe org ${id}`, error);
    }
  }
}, 60_000);

describe("migration 0060 (dev DB)", () => {
  it("is re-run safe: the statement runs again without error", async () => {
    const text = readFileSync("drizzle/0060_admin_guide.sql", "utf8").replace(/--[^\n]*/g, "").trim();
    await expect(db.execute(sql.raw(text))).resolves.toBeDefined();
    const cols = await run(
      sql`SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'admin_guide_state'`,
    );
    expect(cols).toEqual([{ is_nullable: "YES", column_default: null }]);
  });
});

describe("PATCH merge (dev DB)", () => {
  it("lesson sets tourStartedAt once and always overwrites lastLesson", async () => {
    await q.patchAdminGuide(orgA, otherAdminId, { lesson: "requests" }, T1);
    expect(await guideObj(otherAdminId)).toEqual({ tourStartedAt: T1.toISOString(), lastLesson: "requests" });
    await q.patchAdminGuide(orgA, otherAdminId, { lesson: "customers" }, T2);
    expect(await guideObj(otherAdminId)).toEqual({ tourStartedAt: T1.toISOString(), lastLesson: "customers" });
  });

  it("welcomeDismissedAt and tourCompletedAt are write-once; lastLesson survives a lesson-less patch", async () => {
    await q.patchAdminGuide(orgA, otherAdminId, { dismissWelcome: true, tourCompleted: true }, T2);
    await q.patchAdminGuide(orgA, otherAdminId, { dismissWelcome: true, tourCompleted: true }, T3);
    expect(await guideObj(otherAdminId)).toEqual({
      tourStartedAt: T1.toISOString(),
      lastLesson: "customers",
      welcomeDismissedAt: T2.toISOString(),
      tourCompletedAt: T2.toISOString(),
    });
  });

  it.each([
    ["a json string", `'"oops"'::jsonb`],
    ["an array", `'[1,2]'::jsonb`],
    ["json null", `'null'::jsonb`],
  ])("a stored non-object (%s) is treated as {}", async (_n, literal) => {
    await db.execute(sql`UPDATE users SET admin_guide_state = ${sql.raw(literal)} WHERE id = ${otherAdminId}`);
    await q.patchAdminGuide(orgA, otherAdminId, { lesson: "paid" }, T1);
    expect(await guideObj(otherAdminId)).toEqual({ tourStartedAt: T1.toISOString(), lastLesson: "paid" });
  });

  it("matches no row for another org's user, a technician or an inactive admin", async () => {
    const before = {
      b: await guideText(bAdminId),
      tech: await guideText(techId),
      inactive: await guideText(inactiveId),
      chick: await guideText(chickId),
    };
    await q.patchAdminGuide(orgA, bAdminId, { dismissWelcome: true }, T1); // B's user, A's org
    await q.patchAdminGuide(orgB, chickId, { dismissWelcome: true }, T1); // A's user, B's org
    await q.patchAdminGuide(orgA, techId, { dismissWelcome: true }, T1);
    await q.patchAdminGuide(orgA, inactiveId, { dismissWelcome: true }, T1);
    expect({
      b: await guideText(bAdminId),
      tech: await guideText(techId),
      inactive: await guideText(inactiveId),
      chick: await guideText(chickId),
    }).toEqual(before);
  });

  it("the route writes only the session user's own row and answers 204", async () => {
    session = sessionFor(bAdminId, orgB, "b@throwaway.example");
    cookieJar = {};
    const others = { chick: await guideText(chickId), other: await guideText(otherAdminId) };
    const res = await guideRoute.PATCH(patchReq({ lesson: "schedule" }));
    expect(res.status).toBe(204);
    expect((await guideObj(bAdminId))?.lastLesson).toBe("schedule");
    expect({ chick: await guideText(chickId), other: await guideText(otherAdminId) }).toEqual(others);
  });
});

describe("View as preview (dev DB, not the demo org)", () => {
  it("a preview GET returns the TARGET's guide and leaves admin_guide_state and onboarding_state unchanged", async () => {
    await db.execute(
      sql`UPDATE users SET admin_guide_state = ${JSON.stringify({ tourStartedAt: T1.toISOString(), lastLesson: "technicians" })}::jsonb WHERE id = ${chickId}`,
    );
    // No firstSeenAt yet: a normal GET would write it, so a preview write would show.
    await db.execute(sql`UPDATE organization_settings SET onboarding_state = NULL WHERE organization_id = ${orgA}`);
    const value = await previewCookieFor(chickId);
    session = sessionFor(platformId, orgA, platformEmail);
    cookieJar = { hvac_preview: value };

    const before = {
      chick: await guideText(chickId),
      platform: await guideText(platformId),
      onboarding: await onboardingText(orgA),
    };
    const res = await onboarding.GET(getReq(`hvac_preview=${value}`));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.steps.length).toBeGreaterThan(0);
    expect(data.guide).toEqual({
      welcomeDue: true,
      lastLesson: "technicians",
      tourStartedAt: T1.toISOString(),
      tourCompletedAt: null,
      readOnly: true,
      payLinks: true,
      hasFieldPulse: false,
      // Previewing folds into showHidden: the target sees history hidden.
      historyHidden: true,
      historyContact: "Probe Platform Owner",
    });
    expect({
      chick: await guideText(chickId),
      platform: await guideText(platformId),
      onboarding: await onboardingText(orgA),
    }).toEqual(before);
  });

  it("the guide PATCH is 403 PREVIEW_READ_ONLY while previewing and writes nothing", async () => {
    const value = await previewCookieFor(chickId);
    session = sessionFor(platformId, orgA, platformEmail);
    cookieJar = { hvac_preview: value };
    const before = { chick: await guideText(chickId), platform: await guideText(platformId) };
    const res = await guideRoute.PATCH(patchReq({ tourCompleted: true }, `hvac_preview=${value}`));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("PREVIEW_READ_ONLY");
    expect({ chick: await guideText(chickId), platform: await guideText(platformId) }).toEqual(before);
  });

  it("control: the same GET without the preview does write firstSeenAt (the check above can see a write)", async () => {
    session = sessionFor(platformId, orgA, platformEmail);
    cookieJar = {};
    const res = await onboarding.GET(getReq());
    expect(res.status).toBe(200);
    expect((await res.json()).data.guide).toMatchObject({ readOnly: false, welcomeDue: true });
    expect(await onboardingText(orgA)).toContain("firstSeenAt");
  });

  it("an org with no platform admin user gets the generic history contact", async () => {
    session = sessionFor(bAdminId, orgB, "b@throwaway.example");
    cookieJar = {};
    const res = await onboarding.GET(getReq());
    expect((await res.json()).data.guide.historyContact).toBe("your account administrator");
  });
});
