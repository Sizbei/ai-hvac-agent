/**
 * HCP-backed {@link SchedulingSource} — Stage 4.
 *
 * Conforms to the admin scheduling-source seam so the calendar + the customer
 * open-window math consume HCP availability through the SAME interface as the DB
 * source, with NO caller changes. It reads HCP's concrete bookable windows via
 * the S1 client, maps them to the recurring-slot shape the open-window math
 * expects (availability-mapping.ts), and reports them as a synthetic, opaque
 * technician roster — so the PII-free guarantee of the public availability
 * surface is preserved (no HCP staff identity ever crosses this boundary).
 *
 * CACHING: HCP is a remote API; the chat slot-picker can ask for availability on
 * many turns. We cache the mapped surface per org for a short TTL (in-memory, the
 * same pattern as other short-lived caches) so we don't hammer HCP per turn.
 *
 * DEGRADE SAFELY: this source THROWS on an HCP error; the factory
 * (getSchedulingSource) catches that and falls back to the DB source so a remote
 * hiccup never fails the customer's slot-pick. See ../../admin/scheduling-source.
 *
 * NOTE on getJobs: HCP's availability windows are ALREADY net of bookings, so
 * this source reports NO booked jobs — subtracting bookings again would
 * double-count and under-report open slots. The mapping owns the "what's open"
 * truth; jobs are intentionally empty here.
 */
import type { SchedulingSource } from "@/lib/admin/scheduling-source";
import type { AvailabilitySlot, ScheduledJob } from "@/lib/admin/types";
import type { HousecallProClient } from "./client";
import {
  mapHcpAvailability,
  type MappedHcpAvailability,
} from "./availability-mapping";

/** How far ahead we ask HCP for bookable windows. Matches the availability
 * route's MAX_DAYS so a single cached fetch covers any bounded request range. */
const AVAILABILITY_HORIZON_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Default cache TTL: short, so availability stays fresh without hammering HCP
 * on every chat turn. Overridable for tests. */
export const DEFAULT_HCP_AVAILABILITY_TTL_MS = 30_000;

interface CacheEntry {
  readonly value: MappedHcpAvailability;
  readonly expiresAt: number;
}

/**
 * A tiny per-key TTL cache for the mapped HCP availability surface. In-memory and
 * process-local (best-effort across a serverless instance's warm lifetime) — a
 * cold start simply re-fetches. `now`/`ttlMs` are injectable for deterministic
 * tests; nothing here logs the HCP key (it never reaches this layer).
 */
export class HcpAvailabilityCache {
  private readonly store = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number = DEFAULT_HCP_AVAILABILITY_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): MappedHcpAvailability | null {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) {
        this.store.delete(key);
      }
      return null;
    }
    return entry.value;
  }

  set(key: string, value: MappedHcpAvailability): void {
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}

/** Process-wide default cache, shared across requests in a warm instance. */
const defaultCache = new HcpAvailabilityCache();

/**
 * HCP-backed scheduling source for one org. Bound to a resolved {@link
 * HousecallProClient} (the factory builds the client + checks connectedness; this
 * class just consumes it). The mapped surface is cached per org so repeated
 * getAvailability/getActiveTechnicianIds calls within a TTL hit HCP once.
 */
export class HcpSchedulingSource implements SchedulingSource {
  constructor(
    private readonly organizationId: string,
    private readonly client: HousecallProClient,
    private readonly cache: HcpAvailabilityCache = defaultCache,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Fetch + map HCP's bookable windows for the forward horizon, cached per org.
   * Throws on an HCP error so the factory can fall back to the DB source.
   */
  private async loadMapped(): Promise<MappedHcpAvailability> {
    const cached = this.cache.get(this.organizationId);
    if (cached) {
      return cached;
    }
    const startMs = this.now();
    const range = {
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(startMs + AVAILABILITY_HORIZON_DAYS * MS_PER_DAY).toISOString(),
    };
    const windows = await this.client.listAvailability(range);
    const mapped = mapHcpAvailability(windows);
    this.cache.set(this.organizationId, mapped);
    return mapped;
  }

  /**
   * Recurring working-hour windows derived from HCP's bookable slots. A
   * `technicianId` filter scopes to one synthetic HCP tech (parity with the DB
   * source's signature); HCP itself has no per-tech availability surface here.
   */
  async getAvailability(
    technicianId?: string,
  ): Promise<readonly AvailabilitySlot[]> {
    const mapped = await this.loadMapped();
    if (technicianId) {
      return mapped.slots.filter((s) => s.technicianId === technicianId);
    }
    return mapped.slots;
  }

  /**
   * No booked jobs: HCP's availability windows are already net of bookings, so
   * the open-window math must NOT subtract again. Always empty.
   */
  async getJobs(
    startIso: string,
    endIso: string,
  ): Promise<readonly ScheduledJob[]> {
    // The range is irrelevant: HCP's availability windows are already net of
    // bookings, so this source reports no jobs regardless of [startIso, endIso).
    void startIso;
    void endIso;
    return [];
  }

  /**
   * The synthetic, opaque technician roster backing the mapped availability —
   * the "bookable staff" the open-window aggregation counts when HCP is the
   * source of truth. No HCP staff identity; ids are deterministic placeholders.
   */
  async getActiveTechnicianIds(): Promise<readonly string[]> {
    const mapped = await this.loadMapped();
    return mapped.technicianIds;
  }
}
