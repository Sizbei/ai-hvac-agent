/**
 * Google Calendar integration — shared types.
 *
 * These describe the SEAM between our app and Google Calendar (REST v3). They
 * are deliberately minimal: the fields we actually push to an event plus the
 * OAuth token bundle a client needs to authenticate. Nothing here imports the
 * DB or `fetch`, so the request->event MAPPING is pure and unit-testable
 * without touching Google or the network.
 */

/**
 * The OAuth credentials for ONE organization's Google Calendar connection.
 *
 * The `refreshToken` is the long-lived grant (stored encrypted at rest — see
 * connection-queries.ts); `accessToken`/`accessTokenExpiresAt` are the
 * short-lived cache. A client refreshes the access token from the refresh
 * token when the cache is empty or stale. Tokens are NEVER logged.
 */
export interface OrgGoogleTokens {
  /** Long-lived OAuth refresh token (plaintext in memory only). */
  readonly refreshToken: string;
  /** Cached short-lived access token, if still valid. */
  readonly accessToken: string | null;
  /** Epoch ms the cached access token expires; null when uncached. */
  readonly accessTokenExpiresAt: number | null;
  /** Target calendar id ("primary" or a specific calendar). */
  readonly calendarId: string;
}

/**
 * A Google Calendar event time. We always send a wall-clock `dateTime`
 * (RFC-3339 *without* a UTC offset) paired with an IANA `timeZone`, so Google
 * anchors the event to the business timezone — DST-correct — rather than to a
 * fixed offset. This mirrors how the rest of the app renders Eastern.
 */
export interface GoogleEventDateTime {
  /** RFC-3339 local datetime, no offset, e.g. "2026-06-09T08:00:00". */
  readonly dateTime: string;
  /** IANA timezone, e.g. "America/New_York". */
  readonly timeZone: string;
}

/**
 * The subset of a Google Calendar event we create/update. `extendedProperties.
 * private.requestId` is our IDEMPOTENCY KEY: on re-sync we look up the existing
 * event by this key and UPDATE it instead of inserting a duplicate.
 */
export interface GoogleCalendarEvent {
  readonly summary: string;
  readonly description: string;
  readonly start: GoogleEventDateTime;
  readonly end: GoogleEventDateTime;
  readonly extendedProperties: {
    readonly private: {
      /** The service_request id — unique per event, used for idempotent upsert. */
      readonly requestId: string;
    };
  };
}

/** A previously-synced event as returned by listEvents (id + idempotency key). */
export interface GoogleCalendarEventRef {
  readonly id: string;
  readonly requestId: string | null;
}

/** Half-open [startIso, endIso) UTC range for listEvents. */
export interface GoogleCalendarRange {
  readonly startIso: string;
  readonly endIso: string;
}
