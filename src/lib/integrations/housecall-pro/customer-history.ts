/**
 * CUSTOMER SERVICE HISTORY: read a returning customer's PAST jobs from Housecall
 * Pro and reduce them to a small, PII-free summary the bot's returning-customer
 * context and the admin customer view can reference ("last serviced in March").
 *
 * READ-ONLY and DEGRADE-SAFE, mirroring customer-sync.ts: every failure path
 * (org not HCP-connected, HCP/network error, malformed payload) returns the
 * EMPTY summary rather than throwing. A history hiccup must never block a chat
 * reply or break an admin page. The summary carries NO customer name / contact /
 * address — only a count and the most-recent job's date + work description.
 *
 * The API key never leaves the client seam; this module only sees typed jobs.
 */
import { logger } from "@/lib/logger";
import { getHousecallClient } from "./client";
import type { HousecallCustomerServiceHistory, HousecallJob } from "./types";

/** The "no history" result returned for every degrade path. */
const EMPTY_HISTORY: HousecallCustomerServiceHistory = {
  jobCount: 0,
  lastServiceDate: null,
  lastServiceDescription: null,
};

/**
 * Pick the most-recent job by schedule_start. HCP's ordering isn't guaranteed,
 * so we compare dates rather than trusting list position; jobs without a start
 * date lose to any that has one (an undated job can't be "most recent").
 */
function mostRecent(jobs: readonly HousecallJob[]): HousecallJob | null {
  let best: HousecallJob | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const job of jobs) {
    const ms = job.schedule_start ? Date.parse(job.schedule_start) : NaN;
    const score = Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
    if (best === null || score > bestMs) {
      best = job;
      bestMs = score;
    }
  }
  return best;
}

/** Reduce a customer's HCP jobs to the PII-free summary (pure). */
export function summarizeServiceHistory(
  jobs: readonly HousecallJob[],
): HousecallCustomerServiceHistory {
  if (jobs.length === 0) {
    return EMPTY_HISTORY;
  }
  const recent = mostRecent(jobs);
  return {
    jobCount: jobs.length,
    lastServiceDate: recent?.schedule_start ?? null,
    lastServiceDescription: recent?.description ?? null,
  };
}

/**
 * Resolve the org's HCP client and summarize the given customer's past jobs.
 *
 *  - No client (org not HCP-connected) → empty summary (no network call).
 *  - Any HCP/network/parse error → empty summary (logged at WARN, never thrown).
 *
 * `fetchImpl` is injectable so tests mock the network and never hit the real API.
 */
export async function getCustomerServiceHistory(
  organizationId: string,
  hcpCustomerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HousecallCustomerServiceHistory> {
  const client = await getHousecallClient(organizationId, fetchImpl).catch(
    () => null,
  );
  if (!client) {
    return EMPTY_HISTORY; // org not HCP-connected — safe no-op
  }

  try {
    const jobs = await client.listCustomerJobs(hcpCustomerId);
    return summarizeServiceHistory(jobs);
  } catch (error: unknown) {
    // Degrade: an HCP failure must not surface to the chat or admin flow.
    logger.warn(
      { organizationId, hcpCustomerId, error },
      "Housecall Pro service-history fetch failed (degraded)",
    );
    return EMPTY_HISTORY;
  }
}
