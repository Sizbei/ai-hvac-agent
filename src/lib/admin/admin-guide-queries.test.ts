import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

import { patchAdminGuide, readAdminGuide } from "./admin-guide-queries";
import type { ViewerContext } from "@/lib/auth/viewer";

const ORG = "11111111-1111-1111-1111-111111111111";
const ME = "22222222-2222-2222-2222-222222222222";
const TARGET = "33333333-3333-3333-3333-333333333333";
const T1 = "2026-11-10T12:00:00.000Z";
const render = (q: SQL) => new PgDialect().sqlToQuery(q);
const flat = (q: SQL) => render(q).sql.replace(/\s+/g, " ");

function viewer(p: Partial<ViewerContext> = {}): ViewerContext {
  return {
    session: { userId: ME, organizationId: ORG, email: "me@x.com", name: "Me", role: "super_admin" },
    isPlatformAdmin: false,
    features: { map: false, reviewRequests: true, payLinks: true, showHistory: false },
    preview: null,
    uiRole: "super_admin",
    showHidden: false,
    ...p,
  } as ViewerContext;
}

function row(p: Record<string, unknown> = {}) {
  return { state: null, has_field_pulse: false, feature_flags: {}, contact_name: null, ...p };
}

const ORIGINAL = process.env.PLATFORM_ADMIN_EMAILS;

beforeEach(() => {
  executed.length = 0;
  queue.length = 0;
  process.env.PLATFORM_ADMIN_EMAILS = " Owner@X.com ";
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
  else process.env.PLATFORM_ADMIN_EMAILS = ORIGINAL;
});

describe("readAdminGuide", () => {
  it("reads the session user's own state with one SELECT and builds the payload", async () => {
    queue.push({
      rows: [row({
        state: { tourStartedAt: T1, lastLesson: "customers", junk: 1 },
        has_field_pulse: true,
        feature_flags: { payLinks: false },
        contact_name: "Raymond Chen",
      })],
    });
    const g = await readAdminGuide(viewer(), { readOnly: false });
    expect(g).toEqual({
      welcomeDue: true,
      lastLesson: "customers",
      tourStartedAt: T1,
      tourCompletedAt: null,
      readOnly: false,
      payLinks: false,
      hasFieldPulse: true,
      historyHidden: true,
      historyContact: "Raymond Chen",
    });
    expect(executed).toHaveLength(1);
    expect(render(executed[0]).params.slice(0, 2)).toEqual([ME, ORG]);
    expect(render(executed[0]).params).toContainEqual(["owner@x.com"]);
    expect(flat(executed[0])).not.toMatch(/\bUPDATE\b/);
  });

  it("payLinks defaults on when the org has no flag stored (getFeatures semantics)", async () => {
    queue.push({ rows: [row({ feature_flags: null })] });
    expect((await readAdminGuide(viewer(), { readOnly: false })).payLinks).toBe(true);
  });

  it("historyHidden is !viewer.showHidden", async () => {
    queue.push({ rows: [row()] });
    expect((await readAdminGuide(viewer({ showHidden: true }), { readOnly: false })).historyHidden).toBe(false);
  });

  it("an active preview reads the TARGET's state with the target's role, read-only", async () => {
    queue.push({ rows: [row({ state: { welcomeDismissedAt: T1 } })] });
    const v = viewer({
      preview: { status: "active", targetUserId: TARGET, targetName: "Chick", targetRole: "admin", exp: 1 },
      uiRole: "admin",
    });
    const g = await readAdminGuide(v, { readOnly: true });
    expect(render(executed[0]).params.slice(0, 2)).toEqual([TARGET, ORG]);
    expect(render(executed[0]).params).not.toContain(ME);
    expect(g).toMatchObject({ welcomeDue: false, readOnly: true });
  });

  it("previewing a technician: never due", async () => {
    queue.push({ rows: [row()] });
    const v = viewer({
      preview: { status: "active", targetUserId: TARGET, targetName: "Tech", targetRole: "technician", exp: 1 },
      uiRole: "technician",
    });
    expect((await readAdminGuide(v, { readOnly: true })).welcomeDue).toBe(false);
  });

  it("a stale preview reads no user row and is never due", async () => {
    queue.push({ rows: [row()] });
    const g = await readAdminGuide(viewer({ preview: { status: "stale", exp: 1 } }), { readOnly: true });
    expect(render(executed[0]).params).not.toContain(ME);
    expect(g).toMatchObject({ welcomeDue: false, readOnly: true, lastLesson: null });
  });

  it("a preview cookie the viewer could not resolve reads as stale: no own state, never due", async () => {
    queue.push({ rows: [row({ state: { lastLesson: "paid" } })] });
    const g = await readAdminGuide(viewer({ preview: null }), { readOnly: true });
    expect(render(executed[0]).params).not.toContain(ME);
    expect(flat(executed[0])).toContain("NULL::jsonb AS state");
    expect(g).toMatchObject({ welcomeDue: false, readOnly: true, lastLesson: null, tourStartedAt: null });
  });

  it("no matching platform admin: the generic contact", async () => {
    queue.push({ rows: [row({ contact_name: null })] });
    expect((await readAdminGuide(viewer(), { readOnly: false })).historyContact).toBe("your account administrator");
  });

  it("throws on a DB error (the route turns it into guide: null)", async () => {
    queue.push(new Error("db down"));
    await expect(readAdminGuide(viewer(), { readOnly: false })).rejects.toThrow("db down");
  });
});

describe("patchAdminGuide", () => {
  it("runs one UPDATE scoped to the user and org with the merge pieces", async () => {
    await patchAdminGuide(ORG, ME, { lesson: "paid", dismissWelcome: true }, new Date(T1));
    expect(executed).toHaveLength(1);
    const { params } = render(executed[0]);
    expect(flat(executed[0])).toMatch(/^UPDATE users SET admin_guide_state/);
    expect(params).toEqual([
      JSON.stringify({ welcomeDismissedAt: T1, tourStartedAt: T1 }),
      JSON.stringify({ lastLesson: "paid" }),
      ME,
      ORG,
    ]);
  });

  it("runs the UPDATE even when nothing would change (no no-op skip)", async () => {
    await patchAdminGuide(ORG, ME, { tourCompleted: true }, new Date(T1));
    await patchAdminGuide(ORG, ME, { tourCompleted: true }, new Date(T1));
    expect(executed).toHaveLength(2);
  });
});
