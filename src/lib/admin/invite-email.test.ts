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

const getOrgTimeZone = vi.fn();
vi.mock("./org-time-zone", () => ({
  getOrgTimeZone: (...a: unknown[]) => getOrgTimeZone(...a),
}));

import {
  buildInviteEmail,
  inviteLink,
  deliverInvite,
  INVITE_EMAIL_DAILY_CAP,
} from "./invite-email";

const TOKEN = "a".repeat(64);
const URL_ = `https://app.example.com/admin/invite/${TOKEN}`;
const EXPIRES = new Date("2026-11-14T15:00:00.000Z");
const ARGS = {
  orgName: "Spears Services",
  url: URL_,
  role: "admin" as const,
  expiresAt: EXPIRES,
  timeZone: "America/New_York",
};

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
  getOrgTimeZone.mockResolvedValue("America/Chicago");
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

  it("strips control characters from the subject", () => {
    expect(buildInviteEmail({ ...ARGS, orgName: "Acme\r\nBcc: x@y.com" }).subject).toBe(
      "You’re invited to Acme Bcc: x@y.com",
    );
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

  it("shows the expiry in the org's time zone, never UTC", () => {
    const eastern = buildInviteEmail(ARGS);
    expect(eastern.text).toMatch(/expires Nov 14, 2026, 10:00\sAM EST\./);
    expect(eastern.html).toMatch(/expires Nov 14, 2026, 10:00\sAM EST\./);
    expect(eastern.text).not.toContain("UTC");
    const central = buildInviteEmail({ ...ARGS, timeZone: "America/Chicago" });
    expect(central.text).toMatch(/expires Nov 14, 2026, 9:00\sAM CST\./);
  });

  it("an invalid stored zone falls back to the business zone instead of throwing", () => {
    const bad = buildInviteEmail({ ...ARGS, timeZone: "Not/A_Zone" });
    expect(bad).toEqual(buildInviteEmail(ARGS));
    expect(bad.text).toMatch(/expires Nov 14, 2026, 10:00\sAM EST\./);
  });

  it("asks the owner to set up their account instead of naming a role", () => {
    const owner = buildInviteEmail({ ...ARGS, ownerInvite: true });
    for (const body of [owner.text, owner.html]) {
      expect(body).toContain("to set up your account.");
      expect(body).not.toContain("as an admin");
    }
    expect(owner.html).toContain("<strong>Spears Services</strong> to set up your account.");
  });

  it("escapes the org name in the owner copy too", () => {
    const { html } = buildInviteEmail({ ...ARGS, ownerInvite: true, orgName: "<i>X</i>" });
    expect(html).toContain("&lt;i&gt;X&lt;/i&gt;");
    expect(html).not.toContain("<i>X</i>");
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
    expect(getOrgTimeZone).not.toHaveBeenCalled(); // the lookup runs inside after() too
    await (after.mock.calls[0][0] as () => Promise<void>)();
    expect(getOrgTimeZone).toHaveBeenCalledWith(BASE.organizationId);
    expect(sendEmail).toHaveBeenCalledWith({
      to: "chick@example.com",
      ...buildInviteEmail({ ...ARGS, timeZone: "America/Chicago" }),
    });
  });

  it("falls back to the business time zone when the org's can't be read", async () => {
    getOrgTimeZone.mockRejectedValue(new Error("db down"));
    deliverInvite(BASE);
    await (after.mock.calls[0][0] as () => Promise<void>)();
    expect(sendEmail).toHaveBeenCalledWith({
      to: "chick@example.com",
      ...buildInviteEmail({ ...ARGS, timeZone: "America/New_York" }),
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it("still sends, in the business zone, when the org's stored zone is invalid", async () => {
    getOrgTimeZone.mockResolvedValue("Mars/Olympus_Mons");
    deliverInvite(BASE);
    await (after.mock.calls[0][0] as () => Promise<void>)();
    expect(sendEmail).toHaveBeenCalledWith({
      to: "chick@example.com",
      ...buildInviteEmail({ ...ARGS, timeZone: "America/New_York" }),
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it("sends the owner copy for an owner invite", async () => {
    deliverInvite({ ...BASE, ownerInvite: true });
    await (after.mock.calls[0][0] as () => Promise<void>)();
    expect(sendEmail.mock.calls[0][0].text).toContain("to set up your account.");
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
