import { describe, expect, it } from "vitest";
import { approvalStep, padVisible, ZERO_TOTAL_COPY, type ApprovalInput } from "./approval-flow";

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
