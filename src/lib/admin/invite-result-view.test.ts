import { describe, it, expect } from "vitest";
import { inviteResultView, ownerInviteView } from "./invite-result-view";

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

describe("ownerInviteView (platform console)", () => {
  const url = "https://x/admin/invite/t";
  it("emailed with a url → the line AND the copy link", () => {
    expect(ownerInviteView({ emailed: true, url })).toEqual({ line: "Invite emailed.", url });
  });
  it("not emailed with a url → the copy link only", () => {
    expect(ownerInviteView({ emailed: false, url })).toEqual({ line: null, url });
  });
  it("emailed without a url → the line only", () => {
    expect(ownerInviteView({ emailed: true })).toEqual({ line: "Invite emailed.", url: null });
  });
  it("neither → says it was not emailed", () => {
    expect(ownerInviteView({ emailed: false })).toEqual({
      line: "Invite created but not emailed.",
      url: null,
    });
  });
});
