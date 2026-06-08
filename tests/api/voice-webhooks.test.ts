import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

// The voice routes touch the DB and the agent core; mock those so we exercise
// the webhook contract (signature gate + TwiML shape), not the agent.
const { selectResult, insertSpy, voiceReplyMock } = vi.hoisted(() => ({
  selectResult: { value: [] as unknown[] },
  insertSpy: vi.fn(),
  voiceReplyMock: vi.fn(),
}));

function thenable(value: unknown): unknown {
  const p: unknown = new Proxy(() => {}, {
    get(_t, prop) {
      if (prop === "then") return (r: (v: unknown) => void) => r(value);
      return () => p;
    },
    apply: () => p,
  });
  return p;
}

// server-only throws at import in a non-server env; stub it before mocks apply.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectResult.value),
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
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
}));
vi.mock("@/lib/db/schema", () => ({
  customerSessions: { token: "token", organizationId: "org" },
  organizationSettings: {},
  messages: {},
}));
vi.mock("@/lib/db/tenant", () => ({ withTenant: () => ({}) }));
vi.mock("@/lib/ai/voice-turn", () => ({ voiceReply: voiceReplyMock }));
vi.mock("@/lib/ai/compact-session", () => ({ compactSessionIfNeeded: vi.fn() }));
vi.mock("next/server", async (orig) => {
  const actual = await orig<typeof import("next/server")>();
  return { ...actual, after: (fn: () => void) => fn() };
});

const AUTH_TOKEN = "voice_test_token";

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

describe("voice webhooks", () => {
  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    selectResult.value = [];
    insertSpy.mockReset();
    voiceReplyMock.mockReset();
  });
  afterEach(() => {
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  it("/incoming rejects a request with no signature (403)", async () => {
    const { POST } = await import("@/app/api/voice/incoming/route");
    const url = "https://example.com/api/voice/incoming";
    const params = { CallSid: "CA1", From: "+15550000000" };
    const res = await POST(makeRequest(url, params, null) as never);
    expect(res.status).toBe(403);
  });

  it("/incoming accepts a correctly-signed request and returns a speech Gather", async () => {
    const { POST } = await import("@/app/api/voice/incoming/route");
    const url = "https://example.com/api/voice/incoming";
    const params = { CallSid: "CA2", From: "+15550000000" };
    const res = await POST(makeRequest(url, params, sign(url, params)) as never);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain('input="speech"');
    expect(xml).toContain('action="/api/voice/gather"');
    expect(insertSpy).toHaveBeenCalled();
  });

  it("/gather rejects an unsigned request (403)", async () => {
    const { POST } = await import("@/app/api/voice/gather/route");
    const url = "https://example.com/api/voice/gather";
    const params = { CallSid: "CA3", SpeechResult: "no heat" };
    const res = await POST(makeRequest(url, params, "wrong") as never);
    expect(res.status).toBe(403);
  });

  it("/gather runs the agent and speaks the reply, then gathers again", async () => {
    selectResult.value = [
      {
        id: "s1",
        organizationId: "o1",
        status: "chatting",
        turnCount: 1,
        maxTurns: 40,
        metadata: null,
        runningSummary: null,
      },
    ];
    voiceReplyMock.mockResolvedValue({
      reply: "How urgent is this?",
      endCall: false,
      nextState: "chatting",
    });

    const { POST } = await import("@/app/api/voice/gather/route");
    const url = "https://example.com/api/voice/gather";
    const params = { CallSid: "s1", SpeechResult: "my ac is broken" };
    const res = await POST(makeRequest(url, params, sign(url, params)) as never);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("How urgent is this?");
    expect(xml).toContain("<Gather");
    expect(voiceReplyMock).toHaveBeenCalled();
  });

  it("/gather hangs up when the agent ends the call (escalation)", async () => {
    selectResult.value = [
      {
        id: "s2",
        organizationId: "o1",
        status: "chatting",
        turnCount: 1,
        maxTurns: 40,
        metadata: null,
        runningSummary: null,
      },
    ];
    voiceReplyMock.mockResolvedValue({
      reply: "Please leave the building and call 911.",
      endCall: true,
      nextState: "escalated",
    });

    const { POST } = await import("@/app/api/voice/gather/route");
    const url = "https://example.com/api/voice/gather";
    const params = { CallSid: "s2", SpeechResult: "i smell gas" };
    const res = await POST(makeRequest(url, params, sign(url, params)) as never);
    const xml = await res.text();
    expect(xml).toContain("<Hangup/>");
    expect(xml).toContain("leave the building");
  });
});
