import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// after() throws outside a Next request scope; capture the callback instead.
const after = vi.fn();
vi.mock("next/server", () => ({ after: (cb: unknown) => after(cb) }));

const sendEmail = vi.fn();
vi.mock("@/lib/communication/resend-adapter", () => ({
  sendEmail: (...a: unknown[]) => sendEmail(...a),
}));

const logError = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: { error: (...a: unknown[]) => logError(...a) } }));

import {
  buildInviteEmail,
  inviteLink,
  deliverInvite,
  INVITE_EMAIL_DAILY_CAP,
} from "./invite-email";

const TOKEN = "a".repeat(64);
const URL_ = `https://app.example.com/admin/invite/${TOKEN}`;
const EXPIRES = new Date("2026-11-14T15:00:00.000Z");
const ARGS = { orgName: "Spears Services", url: URL_, role: "admin" as const, expiresAt: EXPIRES };

const ORIGINAL = {
  key: process.env.RESEND_API_KEY,
  app: process.env.NEXT_PUBLIC_APP_URL,
};
function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
});
afterEach(() => {
  restore("RESEND_API_KEY", ORIGINAL.key);
  restore("NEXT_PUBLIC_APP_URL", ORIGINAL.app);
});

describe("buildInviteEmail", () => {
  it("uses the org name in the subject with a typographic apostrophe", () => {
    expect(buildInviteEmail(ARGS).subject).toBe("You’re invited to Spears Services");
  });

  it("escapes the org name in the html", () => {
    const { html } = buildInviteEmail({ ...ARGS, orgName: "<b>X</b>" });
    expect(html).toContain("&lt;b&gt;X&lt;/b&gt;");
    expect(html).not.toContain("<b>X</b>");
  });

  it("escapes quotes and ampersands in the org name", () => {
    const { html } = buildInviteEmail({ ...ARGS, orgName: `A & "B"` });
    expect(html).toContain("A &amp; &quot;B&quot;");
  });

  it("carries the exact link, with no tracking params or click wording", () => {
    const { html, text } = buildInviteEmail(ARGS);
    expect(html).toContain(`href="${URL_}"`);
    expect(text).toContain(URL_);
    expect(html).not.toMatch(/utm_|click/i);
    expect(text).not.toMatch(/utm_|click/i);
  });

  it("names the role and the expiry", () => {
    const admin = buildInviteEmail(ARGS);
    expect(admin.text).toContain("as an admin");
    expect(admin.text).toContain("Nov 14, 2026");
    expect(buildInviteEmail({ ...ARGS, role: "technician" }).text).toContain("as a technician");
  });
});

describe("inviteLink", () => {
  it("is null without NEXT_PUBLIC_APP_URL", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(inviteLink(TOKEN)).toBeNull();
    process.env.NEXT_PUBLIC_APP_URL = "   ";
    expect(inviteLink(TOKEN)).toBeNull();
  });

  it("is null for a non-http(s) base", () => {
    process.env.NEXT_PUBLIC_APP_URL = "javascript:alert(1)";
    expect(inviteLink(TOKEN)).toBeNull();
    process.env.NEXT_PUBLIC_APP_URL = "not a url";
    expect(inviteLink(TOKEN)).toBeNull();
  });

  it("joins without a double slash", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com/";
    expect(inviteLink(TOKEN)).toBe(URL_);
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com//";
    expect(inviteLink(TOKEN)).toBe(URL_);
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    expect(inviteLink(TOKEN)).toBe(URL_);
  });
});

describe("deliverInvite", () => {
  const BASE = {
    organizationId: "11111111-1111-4111-8111-111111111111",
    email: "chick@example.com",
    orgName: "Spears Services",
    token: TOKEN,
    role: "admin" as const,
    expiresAt: EXPIRES,
    priorCount: 0,
  };

  it("schedules sendEmail in after() when Resend and the app URL are configured", async () => {
    expect(deliverInvite(BASE)).toEqual({ emailed: true });
    expect(after).toHaveBeenCalledTimes(1);
    expect(sendEmail).not.toHaveBeenCalled(); // only inside after()
    await (after.mock.calls[0][0] as () => Promise<void>)();
    expect(sendEmail).toHaveBeenCalledWith({
      to: "chick@example.com",
      ...buildInviteEmail({ orgName: "Spears Services", url: URL_, role: "admin", expiresAt: EXPIRES }),
    });
  });

  it("does not email without RESEND_API_KEY", () => {
    delete process.env.RESEND_API_KEY;
    expect(deliverInvite(BASE)).toEqual({ emailed: false });
    process.env.RESEND_API_KEY = "  ";
    expect(deliverInvite(BASE)).toEqual({ emailed: false });
    expect(after).not.toHaveBeenCalled();
  });

  it("does not email without a link", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(deliverInvite(BASE)).toEqual({ emailed: false });
    expect(after).not.toHaveBeenCalled();
  });

  it("emails the 20th invite of 24h and not the 21st", () => {
    expect(INVITE_EMAIL_DAILY_CAP).toBe(20);
    expect(deliverInvite({ ...BASE, priorCount: 19 })).toEqual({ emailed: true });
    expect(deliverInvite({ ...BASE, priorCount: 20 })).toEqual({ emailed: false });
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("logs a send failure with ids only — never the email, token or link", async () => {
    sendEmail.mockRejectedValue(new Error(`boom chick@example.com ${TOKEN}`));
    deliverInvite(BASE);
    await (after.mock.calls[0][0] as () => Promise<void>)();
    expect(logError).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logError.mock.calls[0]);
    expect(logged).toContain(BASE.organizationId);
    expect(logged).not.toContain("chick@example.com");
    expect(logged).not.toContain(TOKEN);
  });
});
