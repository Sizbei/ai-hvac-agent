/**
 * Customer-thread read/write service (Probook v3, Phase 1).
 *
 * - `appendEvent` is best-effort and NEVER throws into the request path: a
 *   failed event write logs and returns, so eventing can't 500 a real action.
 * - `getThread` FAILS OPEN: any DB error returns EMPTY_THREAD, so every call
 *   site is fail-open by construction.
 * - All rendered output is PII-free: labels come from renderEventLabel, which
 *   reads only structured fields (never refId / free text).
 */
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerEvents, customerThreads } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { logger } from "@/lib/logger";
import {
  renderEventLabel,
  type CustomerEventView,
  type EventKind,
  type EventLabelKey,
} from "./event-labels";

export interface AppendEventInput {
  readonly kind: EventKind;
  readonly labelKey: EventLabelKey;
  readonly refId?: string | null;
  readonly jobType?: string | null;
  readonly window?: string | null;
  readonly channel?: "voice" | "sms" | "web" | null;
}

export interface ResolvedThread {
  readonly threadId: string;
  readonly customerId: string;
}

export interface ThreadEventLine {
  readonly at: Date;
  readonly kind: string;
  readonly label: string;
}

export interface CustomerThreadView {
  readonly exists: boolean;
  readonly lastChannel: string | null;
  readonly openEstimateCount: number;
  readonly events: readonly ThreadEventLine[];
}

export const EMPTY_THREAD: CustomerThreadView = {
  exists: false,
  lastChannel: null,
  openEstimateCount: 0,
  events: [],
};

// resolveThread: find the thread id; null if none (no insert).
export async function resolveThread(
  organizationId: string,
  customerId: string,
): Promise<ResolvedThread | null> {
  const [row] = await db
    .select({ id: customerThreads.id })
    .from(customerThreads)
    .where(withTenant(customerThreads, organizationId, eq(customerThreads.customerId, customerId)))
    .limit(1);
  return row ? { threadId: row.id, customerId } : null;
}

// ensureThreadId: get-or-create via onConflictDoUpdate on the (org,customer)
// unique index (neon-http has no transactions, so a CAS upsert avoids a 500 on
// concurrent first events).
async function ensureThreadId(
  organizationId: string,
  customerId: string,
  channel: string | null,
): Promise<string | null> {
  const [row] = await db
    .insert(customerThreads)
    .values({ organizationId, customerId, lastChannel: channel, lastEventAt: sql`now()` })
    .onConflictDoUpdate({
      target: [customerThreads.organizationId, customerThreads.customerId],
      // Keep a previously-recorded channel when this event carries none, so a
      // channel-less emitter (e.g. a background status change) never nulls out
      // the last real contact channel.
      set: {
        lastChannel: channel ?? sql`${customerThreads.lastChannel}`,
        lastEventAt: sql`now()`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: customerThreads.id });
  return row?.id ?? null;
}

// appendEvent: best-effort, structured-only, NEVER throws into the request path.
export async function appendEvent(
  organizationId: string,
  customerId: string,
  evt: AppendEventInput,
): Promise<void> {
  try {
    const threadId = await ensureThreadId(organizationId, customerId, evt.channel ?? null);
    if (!threadId) return;
    await db.insert(customerEvents).values({
      organizationId,
      customerId,
      threadId,
      kind: evt.kind,
      refId: evt.refId ?? null,
      jobType: evt.jobType ?? null,
      window: evt.window ?? null,
      labelKey: evt.labelKey,
    });
  } catch (error) {
    logger.error(
      { error, organizationId, customerId, kind: evt.kind },
      "Failed to append customer event (non-fatal)",
    );
  }
}

// getThread: FAILS OPEN internally — any DB error returns EMPTY_THREAD (never
// throws), so every call site is fail-open by construction.
export async function getThread(
  organizationId: string,
  customerId: string,
  limit = 20,
): Promise<CustomerThreadView> {
  try {
    const [thread] = await db
      .select({
        lastChannel: customerThreads.lastChannel,
        openEstimateCount: customerThreads.openEstimateCount,
      })
      .from(customerThreads)
      .where(withTenant(customerThreads, organizationId, eq(customerThreads.customerId, customerId)))
      .limit(1);
    if (!thread) return EMPTY_THREAD;

    const rows = await db
      .select({
        at: customerEvents.at,
        kind: customerEvents.kind,
        labelKey: customerEvents.labelKey,
        jobType: customerEvents.jobType,
        window: customerEvents.window,
        refId: customerEvents.refId,
      })
      .from(customerEvents)
      .where(withTenant(customerEvents, organizationId, eq(customerEvents.customerId, customerId)))
      .orderBy(desc(customerEvents.at))
      .limit(limit);

    return {
      exists: true,
      lastChannel: thread.lastChannel,
      openEstimateCount: thread.openEstimateCount,
      events: rows.map((r) => ({
        at: r.at,
        kind: r.kind,
        label: renderEventLabel({
          kind: r.kind as CustomerEventView["kind"],
          labelKey: r.labelKey as CustomerEventView["labelKey"],
          jobType: r.jobType,
          window: r.window,
          refId: r.refId,
        }),
      })),
    };
  } catch (error) {
    logger.error({ error, organizationId, customerId }, "getThread failed (fail-open)");
    return EMPTY_THREAD;
  }
}
