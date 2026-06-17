/**
 * Google Calendar CLIENT seam.
 *
 * ┌─ GOOGLE CALENDAR SEAM ─────────────────────────────────────────────────────┐
 * │ {@link GoogleCalendarClient} is the only surface sync code calls. The live  │
 * │ implementation talks to Google Calendar REST v3 (events.insert / .update /  │
 * │ .delete / .list) with an OAuth access token it refreshes from the org's     │
 * │ refresh token. Mirrors the style of admin/scheduling-source.ts: a narrow    │
 * │ interface + a concrete impl + a factory, so the live client (or a fake in   │
 * │ tests) can be swapped without touching callers.                             │
 * │                                                                              │
 * │ Idempotency lives in upsertEvent: it lists by extendedProperties.private.    │
 * │ requestId and UPDATES the matching event, else INSERTS — so re-syncing a    │
 * │ request never duplicates its event.                                          │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Tokens are never logged. `fetchImpl` is injectable so tests mock the network.
 */
import type {
  GoogleCalendarEvent,
  GoogleCalendarEventRef,
  GoogleCalendarRange,
  OrgGoogleTokens,
} from "./types";
import {
  getGoogleOAuthConfig,
  refreshAccessToken,
  type GoogleOAuthConfig,
} from "./oauth";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
/** Refresh a little early so a token never expires mid-request. */
const ACCESS_TOKEN_SKEW_MS = 60_000;
/** Per-request timeout — a hung upstream must not stall the lambda until the
 * platform kill. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Result of an upsert: the Google event id + whether it was created vs updated. */
export interface UpsertEventResult {
  readonly eventId: string;
  readonly created: boolean;
}

/**
 * The seam every sync caller depends on. One client instance is bound to one
 * org's OAuth config (the credentials are app-level; the per-org refresh token
 * arrives as `tokens` on each call).
 */
export interface GoogleCalendarClient {
  /**
   * Create or update the event for a request. Idempotent on
   * `event.extendedProperties.private.requestId`: re-syncing UPDATES rather than
   * duplicating.
   */
  upsertEvent(
    tokens: OrgGoogleTokens,
    event: GoogleCalendarEvent,
  ): Promise<UpsertEventResult>;

  /** Delete the event for `requestId`. No-op (resolves) if none exists. */
  deleteEvent(tokens: OrgGoogleTokens, requestId: string): Promise<void>;

  /** List synced events overlapping a UTC range (returns id + idempotency key). */
  listEvents(
    tokens: OrgGoogleTokens,
    range: GoogleCalendarRange,
  ): Promise<readonly GoogleCalendarEventRef[]>;
}

/** Narrow a Google event item to its id + our idempotency key. */
function toEventRef(raw: unknown): GoogleCalendarEventRef | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string") {
    return null;
  }
  const ext = obj.extendedProperties;
  let requestId: string | null = null;
  if (typeof ext === "object" && ext !== null) {
    const priv = (ext as Record<string, unknown>).private;
    if (typeof priv === "object" && priv !== null) {
      const rid = (priv as Record<string, unknown>).requestId;
      requestId = typeof rid === "string" ? rid : null;
    }
  }
  return { id: obj.id, requestId };
}

/**
 * REST v3 client. Holds the app-level OAuth config; each method refreshes the
 * org's access token (from the cache when fresh, else from the refresh token)
 * before calling Google.
 */
export class RestGoogleCalendarClient implements GoogleCalendarClient {
  constructor(
    private readonly config: GoogleOAuthConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** A valid bearer token: use the cache when it has comfortable headroom, else refresh. */
  private async accessTokenFor(tokens: OrgGoogleTokens): Promise<string> {
    const fresh =
      tokens.accessToken &&
      tokens.accessTokenExpiresAt &&
      tokens.accessTokenExpiresAt - ACCESS_TOKEN_SKEW_MS > Date.now();
    if (fresh && tokens.accessToken) {
      return tokens.accessToken;
    }
    const refreshed = await refreshAccessToken(
      this.config,
      tokens.refreshToken,
      this.fetchImpl,
    );
    return refreshed.accessToken;
  }

  private async authedFetch(
    accessToken: string,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    return this.fetchImpl(`${CALENDAR_API_BASE}${path}`, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        ...init.headers,
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
    });
  }

  private calendarPath(calendarId: string): string {
    return `/calendars/${encodeURIComponent(calendarId)}/events`;
  }

  /** Find an already-synced event id for a request id, or null. */
  private async findEventId(
    accessToken: string,
    tokens: OrgGoogleTokens,
    requestId: string,
  ): Promise<string | null> {
    const params = new URLSearchParams({
      privateExtendedProperty: `requestId=${requestId}`,
      maxResults: "1",
      showDeleted: "false",
    });
    const res = await this.authedFetch(
      accessToken,
      `${this.calendarPath(tokens.calendarId)}?${params.toString()}`,
      { method: "GET" },
    );
    if (!res.ok) {
      throw new Error(`Google events.list failed: HTTP ${res.status}`);
    }
    const body: unknown = await res.json();
    const items =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).items
        : undefined;
    if (!Array.isArray(items) || items.length === 0) {
      return null;
    }
    const ref = toEventRef(items[0]);
    return ref?.id ?? null;
  }

  async upsertEvent(
    tokens: OrgGoogleTokens,
    event: GoogleCalendarEvent,
  ): Promise<UpsertEventResult> {
    const accessToken = await this.accessTokenFor(tokens);
    const requestId = event.extendedProperties.private.requestId;
    const existingId = await this.findEventId(accessToken, tokens, requestId);

    if (existingId) {
      const res = await this.authedFetch(
        accessToken,
        `${this.calendarPath(tokens.calendarId)}/${encodeURIComponent(existingId)}`,
        { method: "PATCH", body: JSON.stringify(event) },
      );
      if (!res.ok) {
        throw new Error(`Google events.update failed: HTTP ${res.status}`);
      }
      return { eventId: existingId, created: false };
    }

    const res = await this.authedFetch(
      accessToken,
      this.calendarPath(tokens.calendarId),
      { method: "POST", body: JSON.stringify(event) },
    );
    if (!res.ok) {
      throw new Error(`Google events.insert failed: HTTP ${res.status}`);
    }
    const created: unknown = await res.json();
    const ref = toEventRef(created);
    if (!ref) {
      throw new Error("Google events.insert returned no event id");
    }
    return { eventId: ref.id, created: true };
  }

  async deleteEvent(
    tokens: OrgGoogleTokens,
    requestId: string,
  ): Promise<void> {
    const accessToken = await this.accessTokenFor(tokens);
    const existingId = await this.findEventId(accessToken, tokens, requestId);
    if (!existingId) {
      return; // already absent — nothing to delete
    }
    const res = await this.authedFetch(
      accessToken,
      `${this.calendarPath(tokens.calendarId)}/${encodeURIComponent(existingId)}`,
      { method: "DELETE" },
    );
    // 410 Gone = already deleted; treat as success.
    if (!res.ok && res.status !== 410) {
      throw new Error(`Google events.delete failed: HTTP ${res.status}`);
    }
  }

  async listEvents(
    tokens: OrgGoogleTokens,
    range: GoogleCalendarRange,
  ): Promise<readonly GoogleCalendarEventRef[]> {
    const accessToken = await this.accessTokenFor(tokens);
    const params = new URLSearchParams({
      timeMin: range.startIso,
      timeMax: range.endIso,
      singleEvents: "true",
      showDeleted: "false",
      maxResults: "250",
    });
    const res = await this.authedFetch(
      accessToken,
      `${this.calendarPath(tokens.calendarId)}?${params.toString()}`,
      { method: "GET" },
    );
    if (!res.ok) {
      throw new Error(`Google events.list failed: HTTP ${res.status}`);
    }
    const body: unknown = await res.json();
    const items =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).items
        : undefined;
    if (!Array.isArray(items)) {
      return [];
    }
    return items
      .map(toEventRef)
      .filter((ref): ref is GoogleCalendarEventRef => ref !== null);
  }
}

/**
 * Resolve the active Google Calendar client, or null when the integration isn't
 * configured (no OAuth env vars). A single seam: callers branch on null to
 * degrade safely. `fetchImpl` is injectable for tests.
 */
export function getGoogleCalendarClient(
  fetchImpl: typeof fetch = fetch,
): GoogleCalendarClient | null {
  const config = getGoogleOAuthConfig();
  if (!config) {
    return null;
  }
  return new RestGoogleCalendarClient(config, fetchImpl);
}
