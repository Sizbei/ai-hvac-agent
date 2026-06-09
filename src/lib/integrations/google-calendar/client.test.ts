import { describe, it, expect, vi, afterEach } from "vitest";
import {
  RestGoogleCalendarClient,
  getGoogleCalendarClient,
} from "./client";
import type { GoogleOAuthConfig } from "./oauth";
import type { GoogleCalendarEvent, OrgGoogleTokens } from "./types";

const CONFIG: GoogleOAuthConfig = {
  clientId: "id",
  clientSecret: "secret",
  redirectUri: "uri",
};

const EVENT: GoogleCalendarEvent = {
  summary: "Jane Doe — No cooling",
  description: "Reference: REQ-0042",
  start: { dateTime: "2026-07-01T08:00:00", timeZone: "America/New_York" },
  end: { dateTime: "2026-07-01T12:00:00", timeZone: "America/New_York" },
  extendedProperties: { private: { requestId: "req-1" } },
};

/** Tokens with a fresh cached access token (no refresh needed). */
const FRESH_TOKENS: OrgGoogleTokens = {
  refreshToken: "refresh-1",
  accessToken: "cached-access",
  accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
  calendarId: "primary",
};

function res(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RestGoogleCalendarClient.upsertEvent", () => {
  it("INSERTS when no existing event matches the requestId (idempotency miss)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return res({ items: [] }); // list: nothing found
      }
      return res({ id: "evt-new" }); // insert
    });
    const client = new RestGoogleCalendarClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    const result = await client.upsertEvent(FRESH_TOKENS, EVENT);

    expect(result).toEqual({ eventId: "evt-new", created: true });
    // The list call filters by our idempotency key.
    const listUrl = fetchMock.mock.calls[0][0] as string;
    expect(listUrl).toContain("privateExtendedProperty=requestId%3Dreq-1");
    // The insert POSTs to the events collection with the event body + bearer.
    const insertCall = fetchMock.mock.calls[1];
    expect((insertCall[1] as RequestInit).method).toBe("POST");
    expect(insertCall[0]).toContain("/calendars/primary/events");
    const headers = (insertCall[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe("Bearer cached-access");
    const sent = JSON.parse((insertCall[1] as RequestInit).body as string);
    expect(sent.extendedProperties.private.requestId).toBe("req-1");
    expect(sent.start.timeZone).toBe("America/New_York");
  });

  it("UPDATES (PATCH) the existing event when one matches (idempotency hit)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return res({
          items: [
            {
              id: "evt-existing",
              extendedProperties: { private: { requestId: "req-1" } },
            },
          ],
        });
      }
      return res({ id: "evt-existing" });
    });
    const client = new RestGoogleCalendarClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    const result = await client.upsertEvent(FRESH_TOKENS, EVENT);

    expect(result).toEqual({ eventId: "evt-existing", created: false });
    const patchCall = fetchMock.mock.calls[1];
    expect((patchCall[1] as RequestInit).method).toBe("PATCH");
    expect(patchCall[0]).toContain("/events/evt-existing");
  });

  it("refreshes the access token when the cache is stale", async () => {
    const staleTokens: OrgGoogleTokens = {
      ...FRESH_TOKENS,
      accessToken: "old",
      accessTokenExpiresAt: Date.now() - 1000, // expired
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("oauth2.googleapis.com")) {
        return res({ access_token: "refreshed-access", expires_in: 3600 });
      }
      if (init?.method === "GET") {
        return res({ items: [] });
      }
      return res({ id: "evt-new" });
    });
    const client = new RestGoogleCalendarClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    await client.upsertEvent(staleTokens, EVENT);

    // First call is the token refresh; subsequent API calls use the new token.
    expect(fetchMock.mock.calls[0][0]).toContain("oauth2.googleapis.com");
    const listHeaders = (fetchMock.mock.calls[1][1] as RequestInit)
      .headers as Record<string, string>;
    expect(listHeaders.authorization).toBe("Bearer refreshed-access");
  });

  it("throws when events.insert returns a non-OK response", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET") return res({ items: [] });
      return res({}, false, 500);
    });
    const client = new RestGoogleCalendarClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    await expect(client.upsertEvent(FRESH_TOKENS, EVENT)).rejects.toThrow(
      /events.insert failed: HTTP 500/,
    );
  });
});

describe("RestGoogleCalendarClient.deleteEvent", () => {
  it("deletes the matching event", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return res({
          items: [
            {
              id: "evt-existing",
              extendedProperties: { private: { requestId: "req-1" } },
            },
          ],
        });
      }
      return res({}, true, 204);
    });
    const client = new RestGoogleCalendarClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    await client.deleteEvent(FRESH_TOKENS, "req-1");
    const deleteCall = fetchMock.mock.calls[1];
    expect((deleteCall[1] as RequestInit).method).toBe("DELETE");
    expect(deleteCall[0]).toContain("/events/evt-existing");
  });

  it("no-ops when no event matches (already absent)", async () => {
    const fetchMock = vi.fn(async () => res({ items: [] }));
    const client = new RestGoogleCalendarClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    await client.deleteEvent(FRESH_TOKENS, "req-1");
    // Only the list call — no DELETE issued.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a 410 Gone as success (already deleted)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return res({
          items: [
            {
              id: "evt-x",
              extendedProperties: { private: { requestId: "req-1" } },
            },
          ],
        });
      }
      return res({}, false, 410);
    });
    const client = new RestGoogleCalendarClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    await expect(
      client.deleteEvent(FRESH_TOKENS, "req-1"),
    ).resolves.toBeUndefined();
  });
});

describe("getGoogleCalendarClient", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("returns null when the integration is not configured (safe no-op)", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REDIRECT_URI;
    expect(getGoogleCalendarClient()).toBeNull();
  });

  it("returns a client when configured", () => {
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_REDIRECT_URI = "uri";
    expect(getGoogleCalendarClient()).toBeInstanceOf(RestGoogleCalendarClient);
  });
});
