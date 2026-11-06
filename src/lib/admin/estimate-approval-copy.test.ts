import { describe, it, expect } from "vitest";
import { approvalLines, type ApprovalSegment } from "./estimate-approval-copy";

const when = () => "Nov 6, 2:05 PM";
const day = () => "Nov 6, 2026";
const plain = (lines: ApprovalSegment[][]) => lines.map((l) => l.map((s) => s.text).join(""));
const strong = (lines: ApprovalSegment[][]) => lines.flat().filter((s) => s.strong).map((s) => s.text);
const base = { signatureName: null, soldByName: null, markedSoldBy: null, signedAt: "x" };

describe("office approval line (spec §2)", () => {
  it("field: who typed the name, then 'Signed on site with <technician> · <time>'", () => {
    const l = approvalLines({ ...base, soldVia: "field", signatureName: "Pat Probe", soldByName: "Sam Tech" }, when, day);
    expect(plain(l)).toEqual(["Signed by Pat Probe.", "Signed on site with Sam Tech · Nov 6, 2:05 PM"]);
    expect(strong(l)).toEqual(["Pat Probe", "Sam Tech"]);
  });
  it("field with a deleted technician", () => {
    expect(plain(approvalLines({ ...base, soldVia: "field", signatureName: "Pat" }, when, day))[1])
      .toBe("Signed on site with a technician · Nov 6, 2:05 PM");
  });
  it("office: 'Marked sold by <admin name>' and no time", () => {
    const l = approvalLines({ ...base, soldVia: "office", signatureName: "(admin)", soldByName: "Raymond" }, when, day);
    expect(plain(l)).toEqual(["Marked sold by Raymond"]);
    expect(strong(l)).toEqual(["Raymond"]);
  });
  it("old office rows keep today's wording, name in bold", () => {
    const l = approvalLines({ ...base, soldVia: null, signatureName: "(admin)", markedSoldBy: "Ann" }, when, day);
    expect(plain(l)).toEqual(["Marked sold in the office by Ann on Nov 6, 2026."]);
    expect(strong(l)).toEqual(["Ann"]);
    expect(plain(approvalLines({ ...base, soldVia: null, signatureName: "(admin)" }, when, day))).toEqual(["Marked sold in the office on Nov 6, 2026."]);
  });
  it("portal and old customer rows as today", () => {
    const l = approvalLines({ ...base, soldVia: "portal", signatureName: "Pat" }, when, day);
    expect(plain(l)).toEqual(["Signed by Pat on Nov 6, 2026."]);
    expect(strong(l)).toEqual(["Pat"]);
    expect(plain(approvalLines({ ...base, soldVia: null }, when, day))).toEqual(["Signed by customer on Nov 6, 2026."]);
  });
});
