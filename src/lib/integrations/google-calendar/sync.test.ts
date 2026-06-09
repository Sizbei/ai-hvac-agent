import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the connection store + client factory so sync never touches the DB or
// the network in these unit tests.
const getOrgGoogleTokens = vi.fn();
vi.mock("./connection-queries", () => ({
  getOrgGoogleTokens: (orgId: string) => getOrgGoogleTokens(orgId),
}));

const getGoogleCalendarClient = vi.fn();
vi.mock("./client", () => ({
  getGoogleCalendarClient: (f: unknown) => getGoogleCalendarClient(f),
}));

// Mock the DB module so importing sync.ts doesn't require DATABASE_URL.
vi.mock("@/lib/db", () => ({ db: {} }));

// Quiet the degraded-path logger so the expected warn doesn't clutter output.
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { syncRequestToCalendar, deleteRequestFromCalendar } from "./sync";

const ORG = "org-1";
const REQ = "req-1";

beforeEach(() => {
  getOrgGoogleTokens.mockReset();
  getGoogleCalendarClient.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("syncRequestToCalendar — safe no-op paths", () => {
  it("no-ops when the integration is not configured (null client)", async () => {
    getGoogleCalendarClient.mockReturnValue(null);
    await expect(
      syncRequestToCalendar(ORG, REQ),
    ).resolves.toBeUndefined();
    // Never even asks the DB for tokens — the client gate short-circuits first.
    expect(getOrgGoogleTokens).not.toHaveBeenCalled();
  });

  it("no-ops when the org is not connected (null tokens)", async () => {
    const upsertEvent = vi.fn();
    getGoogleCalendarClient.mockReturnValue({ upsertEvent });
    getOrgGoogleTokens.mockResolvedValue(null);

    await expect(
      syncRequestToCalendar(ORG, REQ),
    ).resolves.toBeUndefined();
    expect(upsertEvent).not.toHaveBeenCalled();
  });

  it("swallows a Google API error (degrades, never throws)", async () => {
    const upsertEvent = vi.fn().mockRejectedValue(new Error("Google 500"));
    getGoogleCalendarClient.mockReturnValue({ upsertEvent });
    getOrgGoogleTokens.mockResolvedValue({
      refreshToken: "r",
      accessToken: null,
      accessTokenExpiresAt: null,
      calendarId: "primary",
    });
    // loadRequestEventInput would query the mocked db ({}), throwing — which is
    // caught and degraded. The contract under test: it resolves, never rejects.
    await expect(
      syncRequestToCalendar(ORG, REQ),
    ).resolves.toBeUndefined();
  });
});

describe("deleteRequestFromCalendar — safe no-op paths", () => {
  it("no-ops when the integration is not configured (null client)", async () => {
    getGoogleCalendarClient.mockReturnValue(null);
    await expect(
      deleteRequestFromCalendar(ORG, REQ),
    ).resolves.toBeUndefined();
    expect(getOrgGoogleTokens).not.toHaveBeenCalled();
  });

  it("no-ops when the org is not connected (null tokens)", async () => {
    const deleteEvent = vi.fn();
    getGoogleCalendarClient.mockReturnValue({ deleteEvent });
    getOrgGoogleTokens.mockResolvedValue(null);
    await deleteRequestFromCalendar(ORG, REQ);
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it("calls deleteEvent with the request id as the idempotency key when connected", async () => {
    const deleteEvent = vi.fn().mockResolvedValue(undefined);
    getGoogleCalendarClient.mockReturnValue({ deleteEvent });
    getOrgGoogleTokens.mockResolvedValue({
      refreshToken: "r",
      accessToken: null,
      accessTokenExpiresAt: null,
      calendarId: "primary",
    });
    await deleteRequestFromCalendar(ORG, REQ);
    expect(deleteEvent).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: "primary" }),
      REQ,
    );
  });
});
