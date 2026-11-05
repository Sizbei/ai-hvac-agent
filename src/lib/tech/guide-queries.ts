import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { logger, errorCode } from "@/lib/logger";
import { cardHiddenFor, parseGuideState } from "./guide-state";
import { guideHideSql, guideSelectSql, guideStampSql } from "./guide-sql";
import { deriveGuide, type GuidePayload, type Signals } from "./guide-steps";

type Row = Record<string, unknown>;

function signalsFromRow(row: Row): Signals {
  const b = (k: string) => row[k] === true;
  return {
    startJob: b("start_job"), finishJob: b("finish_job"), clockIn: b("clock_in"),
    shareLocation: b("share_location"), addMaterial: b("add_material"), noteOrPhoto: b("note_or_photo"),
    captureSignature: b("capture_signature"), buildInvoice: b("build_invoice"), collectPayment: b("collect_payment"),
    hasOpenJob: b("has_open_job"),
    state: parseGuideState(row.field_guide_state),
  };
}

/** GET: one SELECT, then the stamp statement only when something new completed. */
export async function getGuide(organizationId: string, userId: string, now: Date = new Date()): Promise<GuidePayload> {
  const res = await db.execute(guideSelectSql(organizationId, userId));
  const signals = signalsFromRow((res.rows[0] ?? {}) as Row);
  const d = deriveGuide(signals, now);
  if (Object.keys(d.newStamps).length > 0) {
    try {
      await db.execute(guideStampSql({ organizationId, userId, newStamps: d.newStamps }));
    } catch (error) {
      logger.warn({ code: errorCode(error), organizationId, userId }, "Field guide stamp write failed; returning the derived payload");
    }
  }
  return {
    steps: d.steps, progress: d.progress, upNext: d.upNext, finished: d.finished,
    hasOpenJob: signals.hasOpenJob,
    hiddenAt: signals.state.hiddenAt ?? null,
    cardHidden: cardHiddenFor(signals.state, now),
  };
}

/** PATCH: write-once hide. Null when the row is not a live technician of the org. */
export async function hideGuide(organizationId: string, userId: string, now: Date = new Date()): Promise<{ hiddenAt: string } | null> {
  const res = await db.execute(guideHideSql({ organizationId, userId, hiddenAt: now.toISOString() }));
  const row = res.rows[0] as Row | undefined;
  if (!row) return null;
  const state = parseGuideState(row.field_guide_state);
  return { hiddenAt: state.hiddenAt ?? now.toISOString() };
}

/** Server-side read for the jobs page: never throws. */
export async function readGuideHidden(organizationId: string, userId: string, now: Date = new Date()): Promise<boolean> {
  try {
    const res = await db.execute(sql`SELECT field_guide_state FROM users WHERE id = ${userId} AND organization_id = ${organizationId}`);
    const row = res.rows[0] as Row | undefined;
    return cardHiddenFor(parseGuideState(row?.field_guide_state), now);
  } catch (error) {
    logger.warn({ code: errorCode(error), organizationId, userId }, "Field guide hidden read failed; showing the card");
    return false;
  }
}
