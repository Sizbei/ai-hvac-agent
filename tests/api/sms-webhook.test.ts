import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

// The SMS route touches the DB and the agent core; mock those so we exercise the
// webhook contract (signature gate + messaging-TwiML shape), not the agent.
const { sessionRow, insertSpy, updateSpy, voiceReplyMock } = vi.hoisted(() => ({
  sessionRow: { value: [] as unknown[] },
  insertSpy: vi.fn(),
  updateSpy: vi.fn(),
  voiceReplyMock: vi.fn(),
}));

// server-only throws at import in a non-server env; stub it before mocks apply.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(sessionRow.value),
          orderBy: () => Promise.resolve([]),
        }),
        orderBy: () => Promise.resolve([]),
      }),
    }),
    insert: () => ({
      values: () => {
        insertSpy();
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    }),
    update: () => ({
      set: () => ({
        where: () => {
          updateSpy();
          return Promise.resolve();
        },
      }),
    }),
  },
}));
vi.mock("@/lib/db/schema", () => ({
  customerSessions: { token: "token", id: "id", organizationId: "org" },
  organizationSettings: { organizationId: "org" },
  messages: {},
}));
vi.mock("@/lib/db/tenant", () => ({ withTenant: () => ({}) }));
vi.mock("@/lib/ai/voice-turn", () => ({ voiceReply: voiceReplyMock }));
vi.mock("@/lib/ai/compact-session", () => ({ compactSessionIfNeeded: vi.fn() }));
vi.mock("next/server", async (orig) => {
  const actual = await orig<typeof import("next/server")>();
  return { ...actual, after: (fn: () => void) => fn() };
});

const AUTH_TOKEN = "sms_test_token";

function sign(url: string, params: Record<string, string>): string {
  const data =
    url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", AUTH_TOKEN).update(data, "utf8").digest("base64");
}

function makeRequest(
  url: string,
  params: Record<string, string>,
  signature: string | null,
): Request {
  const body = new URLSearchParams(params).toString();
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    host: "example.com",
    "x-forwarded-proto": "https",
  };
  if (signature !== null) headers["x-twilio-signature"] = signature;
  return new Request(url, { method: "POST", headers, body });
}

function chattingSession() {
  return {
    id: "s1",
    organizationId: "o1",
    status: "chatting",
    turnCount: 1,
    maxTurns: 40,
    metadata: null,
    runningSummary: null,
  };
}

const URL = "https://example.com/api/sms/incoming";

describe("sms webhook", () => {
  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    sessionRow.value = [];
    insertSpy.mockReset();
    updateSpy.mockReset();
    voiceReplyMock.mockReset();
  });
  afterEach(() => {
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  it("rejects a request with no signature (403)", async () => {
    const { POST } = await import("@/app/api/sms/incoming/route");
    const params = { From: "+15550000000", Body: "no heat" };
    const res = await POST(makeRequest(URL, params, null) as never);
    expect(res.status).toBe(403);
  });

  it("rejects a wrongly-signed request (403)", async () => {
    const { POST } = await import("@/app/api/sms/incoming/route");
    const params = { From: "+15550000000", Body: "no heat" };
    const res = await POST(makeRequest(URL, params, "wrong") as never);
    expect(res.status).toBe(403);
  });

  it("greets on a first message with no body and creates an sms session", async () => {
    sessionRow.value = []; // no existing session
    const { POST } = await import("@/app/api/sms/incoming/route");
    const params = { From: "+15550000001", Body: "" };
    const res = await POST(makeRequest(URL, params, sign(URL, params)) as never);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<Message>");
    expect(xml).toContain("HVAC assistant");
    expect(insertSpy).toHaveBeenCalled();
  });

  it("runs the agent on a message and replies with the agent's text", async () => {
    sessionRow.value = [chattingSession()];
    voiceReplyMock.mockResolvedValue({
      reply: "Got it — when did the AC stop working?",
      endCall: false,
      nextState: "chatting",
    });

    const { POST } = await import("@/app/api/sms/incoming/route");
    const params = { From: "+15550000002", Body: "my ac is broken" };
    const res = await POST(makeRequest(URL, params, sign(URL, params)) as never);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<Message>");
    expect(xml).toContain("when did the AC stop working");
    expect(voiceReplyMock).toHaveBeenCalled();
  });

  it("XML-escapes the reply so special characters stay well-formed", async () => {
    sessionRow.value = [chattingSession()];
    voiceReplyMock.mockResolvedValue({
      reply: "Heating & cooling <ok>?",
      endCall: false,
      nextState: "chatting",
    });

    const { POST } = await import("@/app/api/sms/incoming/route");
    const params = { From: "+15550000003", Body: "hi" };
    const res = await POST(makeRequest(URL, params, sign(URL, params)) as never);
    const xml = await res.text();
    expect(xml).toContain("Heating &amp; cooling &lt;ok&gt;?");
    expect(xml).not.toContain("<ok>");
  });

  it("nudges (no agent run) when an ongoing conversation gets an empty body", async () => {
    sessionRow.value = [chattingSession()];
    const { POST } = await import("@/app/api/sms/incoming/route");
    const params = { From: "+15550000004", Body: "" };
    const res = await POST(makeRequest(URL, params, sign(URL, params)) as never);
    expect(res.status).toBe(200);
    const xml = await res.text();
    // The reply text is XML-escaped, so the apostrophe renders as &apos;.
    expect(xml).toContain("didn&apos;t catch that");
    expect(voiceReplyMock).not.toHaveBeenCalled();
  });
});
