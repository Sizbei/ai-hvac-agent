import { describe, it, expect } from "vitest";
import { inviteResultView } from "./invite-result-view";

describe("inviteResultView", () => {
  it("emailed → a confirmation line naming the address", () => {
    expect(inviteResultView({ emailed: true, email: "c@s.com" })).toEqual({
      kind: "emailed",
      line: "Invite emailed to c@s.com.",
    });
  });

  it("emailed without an address → the bare line (platform console)", () => {
    expect(inviteResultView({ emailed: true })).toEqual({ kind: "emailed", line: "Invite emailed." });
  });

  it("emailed wins even if a url slipped through", () => {
    expect(
      inviteResultView({ emailed: true, url: "https://x/admin/invite/t", email: "c@s.com" }).kind,
    ).toBe("emailed");
  });

  it("not emailed with a url → the copy link", () => {
    expect(
      inviteResultView({ emailed: false, url: "https://x/admin/invite/t", email: "c@s.com" }),
    ).toEqual({ kind: "link", url: "https://x/admin/invite/t" });
  });

  it("not emailed and no url → says so plainly", () => {
    expect(inviteResultView({ emailed: false, email: "c@s.com" })).toEqual({
      kind: "not_sent",
      line: "Invite created but not emailed.",
    });
    expect(inviteResultView({ emailed: false, url: "", email: "c@s.com" }).kind).toBe("not_sent");
  });
});
