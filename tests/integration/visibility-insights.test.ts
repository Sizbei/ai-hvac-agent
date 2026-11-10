import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedVisibilityOrg, type VisibilityOrg } from "./visibility-fixture";

vi.mock("server-only", () => ({}));

/**
 * Sweep D (Task 13): reports, insights, operations metrics and bot analytics
 * read only visible rows for an org user (VISIBLE_ONLY), and every row for the
 * platform owner (SHOW_ALL). DEV database, one throwaway org
 * (visibility-fixture.ts), deleted in afterAll. The onboarding signals case
 * (an org whose only requests are hidden) lives in onboarding-state.test.ts.
 *
 * Per set (fixture): one request (no lead source, no location), an open
 * 10000 invoice with a 2500 succeeded payment, a submitted session with one
 * user message. Added here, per set: both requests assigned to one technician,
 * an in_progress status event, a closed 30-minute time entry, a review rating
 * (visible 5, hidden 1), an assistant reply (visible 0 tokens, hidden 100), a
 * bot turn (visible routed, hidden not) and a session outcome. Plus one bot
 * turn with no session (pruned-session telemetry), counted for everyone.
 */

type V = typeof import("@/lib/admin/visibility");

let fx: VisibilityOrg;
let v: V;
let rep: typeof import("@/lib/admin/reporting-queries");
let ops: typeof import("@/lib/admin/ops-insights-queries");
let opm: typeof import("@/lib/admin/operations-metrics-queries");
let ai: typeof import("@/lib/admin/ai-insights-queries");
let bot: typeof import("@/lib/admin/bot-analytics-queries");
let tech: string;

beforeAll(async () => {
  fx = await seedVisibilityOrg();
  v = await import("@/lib/admin/visibility");
  rep = await import("@/lib/admin/reporting-queries");
  ops = await import("@/lib/admin/ops-insights-queries");
  opm = await import("@/lib/admin/operations-metrics-queries");
  ai = await import("@/lib/admin/ai-insights-queries");
  bot = await import("@/lib/admin/bot-analytics-queries");
  const { db } = await import("@/lib/db");
  const { sql } = await import("drizzle-orm");
  const org = fx.org;

  tech = ((await db.execute(sql`INSERT INTO users (organization_id,email,name,role,password_hash,is_active)
    VALUES (${org},'tech-'||gen_random_uuid()||'@throwaway.example','Probe Technician','technician','x',true)
    RETURNING id`)).rows[0] as { id: string }).id;

  const sets = [
    { ids: fx.visible, rating: 5, tokens: 0, routed: true, outcome: "booked" },
    { ids: fx.hidden, rating: 1, tokens: 100, routed: false, outcome: "abandoned" },
  ];
  for (const s of sets) {
    await db.batch([
      db.execute(sql`UPDATE service_requests SET assigned_to = ${tech}
        WHERE id = ${s.ids.request} AND organization_id = ${org}`),
      db.execute(sql`INSERT INTO request_status_events (organization_id,service_request_id,to_status,actor_type,at)
        VALUES (${org},${s.ids.request},'in_progress'::request_status,'human',now())`),
      db.execute(sql`INSERT INTO technician_time_entries (organization_id,technician_id,service_request_id,clock_in_at,clock_out_at,minutes)
        VALUES (${org},${tech},${s.ids.request},now()-interval '30 minutes',now(),30)`),
      db.execute(sql`UPDATE review_requests SET rating = ${s.rating}
        WHERE id = ${s.ids.reviewRequest} AND organization_id = ${org}`),
      db.execute(sql`INSERT INTO messages (organization_id,session_id,role,content,tokens_used)
        VALUES (${org},${s.ids.session},'assistant'::message_role,'Probe reply',${s.tokens})`),
      db.execute(sql`INSERT INTO bot_events (organization_id,session_id,turn,routed)
        VALUES (${org},${s.ids.session},1,${s.routed})`),
      db.execute(sql`UPDATE customer_sessions SET outcome = ${s.outcome}::session_outcome
        WHERE id = ${s.ids.session} AND organization_id = ${org}`),
    ]);
  }
  await db.execute(sql`INSERT INTO bot_events (organization_id,session_id,turn,routed)
    VALUES (${org},NULL,1,true)`);

  // Marking-style: the message INSERT un-hid the hidden session and customer
  // (ruling 16 trigger). Hide them again by UPDATE, then check every flag.
  await db.batch([
    db.execute(sql`UPDATE customer_sessions SET hidden_from_org = true WHERE id = ${fx.hidden.session} AND organization_id = ${org}`),
    db.execute(sql`UPDATE customers SET hidden_from_org = true WHERE id = ${fx.hidden.customer} AND organization_id = ${org}`),
    db.execute(sql`UPDATE service_requests SET hidden_from_org = true WHERE id = ${fx.hidden.request} AND organization_id = ${org}`),
  ]);
  const flags = await db.execute(sql`SELECT
      (SELECT hidden_from_org FROM service_requests WHERE id = ${fx.hidden.request}) AS r,
      (SELECT hidden_from_org FROM customer_sessions WHERE id = ${fx.hidden.session}) AS s,
      (SELECT hidden_from_org FROM invoices WHERE id = ${fx.hidden.invoice}) AS i,
      (SELECT hidden_from_org FROM service_requests WHERE id = ${fx.visible.request}) AS vr,
      (SELECT hidden_from_org FROM customer_sessions WHERE id = ${fx.visible.session}) AS vs`);
  const row = flags.rows[0] as Record<string, boolean>;
  if (!(row.r && row.s && row.i) || row.vr || row.vs) {
    throw new Error("fixture: hidden flags changed during setup");
  }
}, 60_000);

afterAll(async () => {
  await fx?.cleanup();
}, 60_000);

/** A period around now that holds every fixture row. */
function period() {
  const now = Date.now();
  return { fromDate: new Date(now - 60 * 60 * 1000), toDate: new Date(now + 60 * 60 * 1000) };
}

describe("visibility: reports, insights, operations (dev DB)", () => {
  it("lead source, location and technician scorecards count only visible requests", async () => {
    const run = async (vis: typeof v.SHOW_ALL) => {
      const p = period();
      const [lead, loc, cards] = await Promise.all([
        rep.getLeadSourceBreakdown(fx.org, p, vis),
        rep.getLocationBreakdown(fx.org, p, vis),
        rep.getTechnicianScorecards(fx.org, p, vis),
      ]);
      return {
        lead: lead.find((r) => r.source === "unknown"),
        loc: loc.find((r) => r.locationId === "unassigned"),
        card: cards.find((r) => r.technicianId === tech),
      };
    };

    const seen = await run(v.VISIBLE_ONLY);
    expect(seen.lead).toMatchObject({ leads: 1, booked: 1, revenueCents: 2500 });
    expect(seen.loc).toMatchObject({ jobs: 1, revenueCents: 10000, avgRating: 5 });
    expect(seen.card).toMatchObject({
      jobsAssigned: 1,
      revenueCents: 10000,
      laborHours: 0.5,
      avgRating: 5,
    });

    const all = await run(v.SHOW_ALL);
    expect(all.lead).toMatchObject({ leads: 2, booked: 2, revenueCents: 5000 });
    expect(all.loc).toMatchObject({ jobs: 2, revenueCents: 20000, avgRating: 3 });
    expect(all.card).toMatchObject({
      jobsAssigned: 2,
      revenueCents: 20000,
      laborHours: 1,
      avgRating: 3,
    });
  });

  it("getOpsInsights ignores hidden requests", async () => {
    const seen = await ops.getOpsInsights(fx.org, v.VISIBLE_ONLY);
    const all = await ops.getOpsInsights(fx.org, v.SHOW_ALL);
    const hours = (r: typeof seen) => r.requestsByHour.reduce((n, h) => n + h.count, 0);
    const load = (r: typeof seen) => r.technicianLoad.find((t) => t.technicianId === tech)?.total;

    expect(seen.totalRequests).toBe(1);
    expect(seen.requestsLast7Days).toBe(1);
    expect(hours(seen)).toBe(1);
    expect(load(seen)).toBe(1);
    expect(seen.byIssueType).toEqual([{ key: "no_heat", count: 1 }]);
    expect(seen.byUrgency).toEqual([{ key: "medium", count: 1 }]);

    expect(all.totalRequests).toBe(2);
    expect(all.requestsLast7Days).toBe(2);
    expect(hours(all)).toBe(2);
    expect(load(all)).toBe(2);
  });

  it("getOperationsMetrics ignores hidden requests and invoices", async () => {
    const seen = await opm.getOperationsMetrics(fx.org, period(), v.VISIBLE_ONLY);
    const all = await opm.getOperationsMetrics(fx.org, period(), v.SHOW_ALL);

    expect(seen.jobsBooked.current).toBe(1);
    expect(seen.samples.response).toBe(1);
    expect(seen.arAging.nativeOutstandingCents).toBe(7500);

    expect(all.jobsBooked.current).toBe(2);
    expect(all.samples.response).toBe(2);
    expect(all.arAging.nativeOutstandingCents).toBe(15000);
  });

  it("getAiInsights ignores hidden sessions, their messages and hidden requests", async () => {
    const seen = await ai.getAiInsights(fx.org, v.VISIBLE_ONLY);
    const all = await ai.getAiInsights(fx.org, v.SHOW_ALL);

    expect(seen).toMatchObject({
      totalSessions: 1,
      submittedRequests: 1,
      deterministicReplies: 1,
      llmReplies: 0,
      totalTokensUsed: 0,
      deflectionRate: 100,
    });
    expect(all).toMatchObject({
      totalSessions: 2,
      submittedRequests: 2,
      deterministicReplies: 1,
      llmReplies: 1,
      totalTokensUsed: 100,
      deflectionRate: 50,
    });
  });

  it("getBotAnalytics ignores hidden sessions and their turns, keeps session-less turns", async () => {
    const seen = await bot.getBotAnalytics(fx.org, period(), v.VISIBLE_ONLY);
    const all = await bot.getBotAnalytics(fx.org, period(), v.SHOW_ALL);
    const outcomes = (r: typeof seen) =>
      Object.fromEntries(r.outcomeDistribution.map((o) => [o.outcome, o.count]));

    expect(seen.totalTurns).toBe(2);
    expect(seen.deterministicRatio).toBe(1);
    expect(outcomes(seen)).toEqual({ booked: 1 });
    expect(seen.abandonRate).toBe(0);

    expect(all.totalTurns).toBe(3);
    expect(all.deterministicRatio).toBe(0.667);
    expect(outcomes(all)).toEqual({ booked: 1, abandoned: 1 });
    expect(all.abandonRate).toBe(0.5);
  });
});
