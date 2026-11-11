import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mintProdRefusal } from "./mint-guard";

const PROD = "postgresql://u:p@ep-withered-hill-pooler.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require";
const DEV = "postgresql://u:p@ep-patient-surf-123.us-east-1.aws.neon.tech/neondb";

describe("mintProdRefusal", () => {
  it("refuses the production host without --prod", () => {
    expect(mintProdRefusal(PROD, [])).toMatch(/production database/);
    expect(mintProdRefusal(PROD, ["--tech"])).toMatch(/--prod/);
  });

  it("matches the host case-insensitively", () => {
    expect(mintProdRefusal(PROD.replace("ep-withered-hill", "EP-Withered-Hill"), [])).not.toBeNull();
  });

  it("allows the production host with an explicit --prod", () => {
    expect(mintProdRefusal(PROD, ["--prod"])).toBeNull();
  });

  it("allows a dev host, an empty or a missing url", () => {
    expect(mintProdRefusal(DEV, [])).toBeNull();
    expect(mintProdRefusal("", [])).toBeNull();
    expect(mintProdRefusal(undefined, [])).toBeNull();
  });

  it("never echoes the url", () => {
    expect(mintProdRefusal(PROD, [])).not.toContain("u:p@");
  });

  it.each(["mint-admin-session.mjs", "mint-tech-session.mjs"])("%s calls the guard before connecting", (f) => {
    const src = readFileSync(join(process.cwd(), "scripts/agent", f), "utf8");
    const guard = src.indexOf("mintProdRefusal(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(src.indexOf("neon(process.env.DATABASE_URL)"));
  });
});
