import { describe, expect, it } from "vitest";
import {
  SPEARS_FACTS,
  emptyKeyReport,
  isProdDatabaseUrl,
  prefillPatch,
} from "./settings-prefill";

const empty = { companyName: null, logoUrl: null, businessInfo: {}, timezone: null };

describe("prefillPatch", () => {
  it("fills every empty verified key", () => {
    const patch = prefillPatch(empty, SPEARS_FACTS);
    expect(patch.companyName).toBe("Spears Services, Inc.");
    expect(patch.timezone).toBe("America/New_York");
    expect(patch.businessInfo).toEqual({
      phone: "423-854-9505",
      serviceArea: "NE Tennessee, SW Virginia, Western North Carolina",
      website: "https://spearsservices.com",
    });
  });

  it("never overwrites a non-empty key", () => {
    const patch = prefillPatch(
      {
        companyName: "Chick's Name",
        logoUrl: null,
        businessInfo: { phone: "555-0100", serviceArea: "Elsewhere" },
        timezone: "America/Chicago",
      },
      SPEARS_FACTS,
    );
    expect(patch.companyName).toBeUndefined();
    expect(patch.timezone).toBeUndefined();
    expect(patch.businessInfo).toEqual({
      website: "https://spearsservices.com",
    });
  });

  it("treats null, empty and whitespace values as empty", () => {
    const patch = prefillPatch(
      { ...empty, companyName: "   ", businessInfo: { phone: "", serviceArea: null as never } },
      SPEARS_FACTS,
    );
    expect(patch.companyName).toBe("Spears Services, Inc.");
    expect(patch.businessInfo?.phone).toBe("423-854-9505");
    expect(patch.businessInfo?.serviceArea).toBeDefined();
  });

  it("returns an empty patch when nothing is empty", () => {
    const full = prefillPatch(empty, SPEARS_FACTS);
    const again = prefillPatch(
      {
        companyName: full.companyName!,
        logoUrl: "https://x.test/l.png",
        businessInfo: full.businessInfo!,
        timezone: full.timezone!,
      },
      SPEARS_FACTS,
    );
    expect(again).toEqual({});
  });

  it("never sets businessHours or logoUrl, even if a facts object carries them", () => {
    const rogue = { ...SPEARS_FACTS, businessHours: "M-F 7:30-4:30", logoUrl: "https://x.test/l.png" };
    const patch = prefillPatch(empty, rogue as never);
    expect(patch.businessInfo).not.toHaveProperty("businessHours");
    expect(patch).not.toHaveProperty("logoUrl");
    expect(SPEARS_FACTS).not.toHaveProperty("businessHours");
    expect(SPEARS_FACTS).not.toHaveProperty("logoUrl");
  });

  it("does not mutate its input", () => {
    const current = { ...empty, businessInfo: Object.freeze({}) as Record<string, string> };
    expect(() => prefillPatch(current, SPEARS_FACTS)).not.toThrow();
  });
});

describe("emptyKeyReport", () => {
  it("lists empty key names only, never values", () => {
    const r = emptyKeyReport({
      companyName: "Spears Services, Inc.",
      logoUrl: null,
      businessInfo: { phone: "423-854-9505" },
      timezone: null,
    });
    expect(r.empty).toEqual(
      expect.arrayContaining(["logo_url", "business_info.businessHours", "business_info.serviceArea"]),
    );
    expect(r.empty).not.toContain("company_name");
    expect(JSON.stringify(r)).not.toContain("423-854-9505");
  });

  it("always lists hours, logo and phone to confirm with Chick when unset", () => {
    const r = emptyKeyReport(empty);
    expect(r.confirmWithChick).toEqual(["business hours", "logo", "business phone"]);
  });

  it("drops phone from the confirm list once set", () => {
    const r = emptyKeyReport({ ...empty, businessInfo: { phone: "1" } });
    expect(r.confirmWithChick).toEqual(["business hours", "logo"]);
  });
});

describe("isProdDatabaseUrl", () => {
  it("refuses the prod host", () => {
    expect(isProdDatabaseUrl("postgresql://u:p@ep-withered-hill-pooler.c-8.aws.neon.tech/db")).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(isProdDatabaseUrl("postgresql://u:p@EP-Withered-Hill.neon.tech/db")).toBe(true);
  });
  it("allows the dev host", () => {
    expect(isProdDatabaseUrl("postgresql://u:p@ep-patient-surf-x.neon.tech/db")).toBe(false);
  });
  it("treats an empty url as unsafe-to-proceed elsewhere, not prod", () => {
    expect(isProdDatabaseUrl("")).toBe(false);
  });
});
