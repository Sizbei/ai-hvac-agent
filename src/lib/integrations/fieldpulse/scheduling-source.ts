/**
 * Fieldpulse-backed {@link SchedulingSource}.
 *
 * Conforms to the admin scheduling-source seam so the calendar + the customer
 * open-window math consume Fieldpulse availability through the SAME interface
 * as the DB source, with NO caller changes. It reads Fieldpulse's bookable
 * windows via the client, maps them to the recurring-slot shape the open-window
 * math expects, and reports them as a synthetic technician roster.
 *
 * NOTE: Fieldpulse may not have a public availability endpoint. This source
 * attempts the call and throws on 404, allowing the factory to fall back to the
 * DB source. When/if Fieldpulse exposes availability, this will work.
 *
 * CACHING: Fieldpulse is a remote API; the chat slot-picker can ask for
 * availability on many turns. We cache the mapped surface per org for a short
 * TTL (in-memory) so we don't hammer Fieldpulse per turn.
 *
 * DEGRADE SAFELY: this source THROWS on a Fieldpulse error; the factory
 * (getSchedulingSource) catches that and falls back to the DB source so a
 * remote hiccup never fails the customer's slot-pick.
 */
import type { SchedulingSource } from "@/lib/admin/scheduling-source";
import type { AvailabilitySlot, ScheduledJob } from "@/lib/admin/types";
import type { FieldpulseClient } from "./client";
import {
  mapFieldpulseAvailability,
  type MappedFieldpulseAvailability,
} from "./availability-mapping";
import { mapFieldpulseUsers } from "./technician-mapping";

/** How far ahead we ask Fieldpulse for bookable windows. */
const AVAILABILITY_HORIZON_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Default cache TTL: short, so availability stays fresh without hammering FP. */
export const DEFAULT_FIELDPULSE_AVAILABILITY_TTL_MS = 30_000;

interface CacheEntry {
  readonly value: MappedFieldpulseAvailability;
  readonly expiresAt: number;
}

/**
 * A tiny per-key TTL cache for the mapped Fieldpulse availability surface.
 * In-memory and process-local; a cold start simply re-fetches.
 */
export class FieldpulseAvailabilityCache {
  private readonly store = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number = DEFAULT_FIELDPULSE_AVAILABILITY_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): MappedFieldpulseAvailability | null {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) {
        this.store.delete(key);
      }
      return null;
    }
    return entry.value;
  }

  set(key: string, value: MappedFieldpulseAvailability): void {
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}

/** Process-wide default cache. */
const defaultCache = new FieldpulseAvailabilityCache();

interface RosterCacheEntry {
  readonly value: readonly string[];
  readonly expiresAt: number;
}

/**
 * A per-org TTL cache for the mapped Fieldpulse technician roster.
 */
export class FieldpulseTechnicianCache {
  private readonly store = new Map<string, RosterCacheEntry>();

  constructor(
    private readonly ttlMs: number = DEFAULT_FIELDPULSE_AVAILABILITY_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): readonly string[] | null {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) {
        this.store.delete(key);
      }
      return null;
    }
    return entry.value;
  }

  set(key: string, value: readonly string[]): void {
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}

/** Process-wide default roster cache. */
const defaultTechnicianCache = new FieldpulseTechnicianCache();

/**
 * Fieldpulse-backed scheduling source for one org. Bound to a resolved
 * {@link FieldpulseClient} (the factory builds the client + checks connectedness).
 */
export class FieldpulseSchedulingSource implements SchedulingSource {
  constructor(
    private readonly organizationId: string,
    private readonly client: FieldpulseClient,
    private readonly cache: FieldpulseAvailabilityCache = defaultCache,
    private readonly now: () => number = Date.now,
    private readonly technicianCache: FieldpulseTechnicianCache = defaultTechnicianCache,
  ) {}

  /**
   * Fetch + map Fieldpulse's bookable windows for the forward horizon, cached
   * per org. Throws on a Fieldpulse error (including 404 when availability is
   * not supported) so the factory can fall back to the DB source.
   */
  private async loadMapped(): Promise<MappedFieldpulseAvailability> {
    const cached = this.cache.get(this.organizationId);
    if (cached) {
      return cached;
    }
    const startMs = this.now();
    const range = {
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(startMs + AVAILABILITY_HORIZON_DAYS * MS_PER_DAY).toISOString(),
    };
    const slots = await this.client.listAvailability(range);
    const mapped = mapFieldpulseAvailability(slots);
    this.cache.set(this.organizationId, mapped);
    return mapped;
  }

  /**
   * Recurring working-hour windows derived from Fieldpulse's bookable slots.
   * A `technicianId` filter scopes to one synthetic Fieldpulse tech.
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
   * No booked jobs: Fieldpulse's availability windows (if they exist) should
   * already be net of bookings, so this source reports no jobs regardless of
   * the range. Always empty.
   */
  async getJobs(
    startIso: string,
    endIso: string,
  ): Promise<readonly ScheduledJob[]> {
    void startIso;
    void endIso;
    return [];
  }

  /**
   * The Fieldpulse technician roster as opaque ids — the "bookable staff" the
   * open-window aggregation counts when Fieldpulse is the source of truth.
   * Fetched via client.listUsers + technician-mapping, cached per org.
   *
   * DEGRADE SAFELY: a roster fetch failure falls back to the SYNTHETIC ids
   * derived from the mapped availability surface (never zero).
   */
  async getActiveTechnicianIds(): Promise<readonly string[]> {
    const cached = this.technicianCache.get(this.organizationId);
    if (cached) {
      return cached;
    }
    try {
      const users = await this.client.listUsers();
      const ids = mapFieldpulseUsers(users);
      if (ids.length > 0) {
        this.technicianCache.set(this.organizationId, ids);
        return ids;
      }
    } catch {
      // Swallow: degrade to the synthetic roster below.
    }
    // Fallback: synthetic ids from the mapped availability windows.
    const mapped = await this.loadMapped();
    return mapped.technicanIds;
  }
}
