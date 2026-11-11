import { describe, it, expect } from "vitest";
import { latencyExitCode, latencyRunPlan } from "./latency-run";

describe("latencyRunPlan (security M4)", () => {
  const local = { isLocal: true, prod: false, previewAs: "", envPreviewCookie: false };
  const remote = { ...local, isLocal: false };

  it("localhost runs as before, minting a preview cookie only when asked", () => {
    expect(latencyRunPlan(local)).toEqual({ ok: true, preview: null, warning: null });
    expect(latencyRunPlan({ ...local, previewAs: "u-1" })).toEqual({ ok: true, preview: "mint", warning: null });
  });

  it("refuses a non-local base without --prod", () => {
    const plan = latencyRunPlan(remote);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toContain("--prod");
    expect(latencyRunPlan({ ...remote, previewAs: "u-1", envPreviewCookie: true }).ok).toBe(false);
  });

  it("with --prod and --preview-as, measures read-only with the HVAC_PREVIEW cookie", () => {
    expect(latencyRunPlan({ ...remote, prod: true, previewAs: "u-1", envPreviewCookie: true })).toEqual({
      ok: true,
      preview: "env",
      warning: null,
    });
  });

  it("with --prod and --preview-as but no HVAC_PREVIEW, refuses (a dev cookie can't be minted for it)", () => {
    const plan = latencyRunPlan({ ...remote, prod: true, previewAs: "u-1" });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toContain("HVAC_PREVIEW");
  });

  it("with --prod alone, warns that page loads write onboarding stamps", () => {
    const plan = latencyRunPlan({ ...remote, prod: true });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.preview).toBeNull();
      expect(plan.warning).toMatch(/onboarding stamps/);
      expect(plan.warning).toContain("--preview-as");
    }
  });
});

describe("latencyExitCode (M3)", () => {
  it("is 0 when every page measured at least one first row", () => {
    expect(latencyExitCode([{ path: "/admin", frame: [1], firstRow: [2] }])).toBe(0);
  });

  it("is 1 when a page never measured (every run failed)", () => {
    expect(
      latencyExitCode([
        { path: "/admin", frame: [1], firstRow: [2] },
        { path: "/admin/requests", frame: [], firstRow: [] },
      ]),
    ).toBe(1);
  });

  it("is 1 when nothing was measured at all", () => {
    expect(latencyExitCode([])).toBe(1);
  });
});
