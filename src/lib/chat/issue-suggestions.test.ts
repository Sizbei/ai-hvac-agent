import { describe, it, expect } from "vitest";
import { routeMessage } from "@/lib/ai/intent-router";
import { ISSUE_SUGGESTIONS } from "./issue-suggestions";

describe("ISSUE_SUGGESTIONS route deterministically (no model needed)", () => {
  for (const s of ISSUE_SUGGESTIONS) {
    it(`"${s.label}" starts an intake with an issue type`, () => {
      const v = routeMessage(s.message);
      expect(v.action).toBe("COLLECT_INFO");
      expect(v.issueType).toBeTruthy();
    });
  }
});
