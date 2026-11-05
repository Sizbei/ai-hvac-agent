import { describe, expect, it } from "vitest";
import { approvalBlocked, approvalButtonLabel, approvalStep, padVisible, unknownBanner, ZERO_TOTAL_COPY, type ApprovalInput } from "./approval-flow";

const base: ApprovalInput = { signatureFresh: false, signatureSent: "idle", finalizeSent: "idle", state: "draft" };
const step = (o: Partial<ApprovalInput>) => approvalStep({ ...base, ...o });

describe("approvalStep", () => {
  it("open and paid are done", () => {
    expect(step({ state: "open" })).toBe("done");
    expect(step({ state: "paid" })).toBe("done");
    expect(step({ state: "refunded" })).toBe("done");
  });

  it("finalize ok is done even before the refetch shows open", () => {
    expect(step({ signatureFresh: true, finalizeSent: "ok" })).toBe("done");
  });

  it("draft, no fresh signature, nothing captured → show_pad (idle and failed)", () => {
    expect(step({})).toBe("show_pad");
    expect(step({ signatureSent: "failed" })).toBe("show_pad");
  });

  it("draft + pad captured + signature idle/failed → send_signature", () => {
    expect(step({ captured: true })).toBe("send_signature");
    expect(step({ captured: true, signatureSent: "failed" })).toBe("send_signature");
  });

  it("a signature in flight stays on send_signature", () => {
    expect(step({ captured: true, signatureSent: "sent" })).toBe("send_signature");
  });

  it("draft + fresh signature → send_finalize", () => {
    expect(step({ signatureFresh: true })).toBe("send_finalize");
    expect(step({ signatureFresh: true, captured: true })).toBe("send_finalize");
  });

  it("draft + signature ok (refetch not caught up) → send_finalize", () => {
    expect(step({ captured: true, signatureSent: "ok" })).toBe("send_finalize");
  });

  it("finalize failed after the signature landed → retry only finalize, pad hidden", () => {
    const s = step({ captured: true, signatureSent: "ok", finalizeSent: "failed" });
    expect(s).toBe("send_finalize");
    expect(padVisible(s)).toBe(false);
    const fresh = step({ signatureFresh: true, finalizeSent: "failed" });
    expect(fresh).toBe("send_finalize");
    expect(padVisible(fresh)).toBe(false);
  });

  it("the pad shows only on show_pad", () => {
    expect(padVisible("show_pad")).toBe(true);
    expect(padVisible("send_signature")).toBe(false);
    expect(padVisible("done")).toBe(false);
  });

  it("$0 copy", () => {
    expect(ZERO_TOTAL_COPY).toBe("Nothing to collect. This closes the invoice at $0 and locks the lines.");
  });
});

describe("unknownBanner", () => {
  it("nothing unknown → null", () => {
    expect(unknownBanner([])).toBeNull();
  });
  it("an unknown signature opens Customer approval", () => {
    expect(unknownBanner(["signature"])).toEqual({
      action: "open_approval",
      text: "Your last signature may not have saved. Open Customer approval and try again.",
    });
  });
  it("any other unknown intent retries that kind (the first one)", () => {
    expect(unknownBanner(["add_line", "signature"])).toEqual({
      action: "retry",
      kind: "add_line",
      text: "Your last change may not have saved.",
    });
  });
});

describe("approvalBlocked", () => {
  it("only signature/finalize unknowns leave approval open", () => {
    expect(approvalBlocked([])).toBe(false);
    expect(approvalBlocked(["signature", "finalize"])).toBe(false);
    expect(approvalBlocked(["add_line"])).toBe(true);
    expect(approvalBlocked(["signature", "remove_line"])).toBe(true);
  });
});

describe("approvalButtonLabel", () => {
  it("Approve and finalize by default", () => {
    expect(approvalButtonLabel("send_signature", null)).toBe("Approve and finalize");
    expect(approvalButtonLabel("send_finalize", null)).toBe("Approve and finalize");
  });

  it("Try again after a failed signature on send_signature", () => {
    expect(approvalButtonLabel("send_signature", "signature")).toBe("Try again");
  });

  it("Try again after a failed finalize once the signature landed", () => {
    expect(approvalButtonLabel("send_finalize", "finalize")).toBe("Try again");
  });

  it("a stale failure from the other step does not relabel", () => {
    expect(approvalButtonLabel("send_finalize", "signature")).toBe("Approve and finalize");
    expect(approvalButtonLabel("send_signature", "finalize")).toBe("Approve and finalize");
  });
});
