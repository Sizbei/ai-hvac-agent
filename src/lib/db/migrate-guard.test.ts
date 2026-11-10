import { describe, expect, it } from "vitest";
import { prodMigrationRefusal } from "./migrate-guard";

const PROD_URL = "postgresql://u:p@ep-withered-hill-a1b2c3-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require";
const DEV_URL = "postgresql://u:p@ep-quiet-dev-123456-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require";

describe("prodMigrationRefusal", () => {
  it("allows the prod host inside the production build", () => {
    expect(prodMigrationRefusal({ databaseUrl: PROD_URL, vercelEnv: "production" })).toBeNull();
  });

  it.each([undefined, "", "preview", "development"])("refuses the prod host when VERCEL_ENV is %j", (vercelEnv) => {
    expect(prodMigrationRefusal({ databaseUrl: PROD_URL, vercelEnv })).toBe(
      "Refusing to migrate: DATABASE_URL is the production database and VERCEL_ENV is not production.",
    );
  });

  it.each([undefined, "preview", "production"])("allows a non-prod host when VERCEL_ENV is %j", (vercelEnv) => {
    expect(prodMigrationRefusal({ databaseUrl: DEV_URL, vercelEnv })).toBeNull();
  });

  it("allows a missing URL (the migrator reports that itself)", () => {
    expect(prodMigrationRefusal({ databaseUrl: undefined, vercelEnv: undefined })).toBeNull();
  });

  it("refuses an unparseable URL that names the prod host", () => {
    expect(prodMigrationRefusal({ databaseUrl: "ep-withered-hill not a url", vercelEnv: undefined })).not.toBeNull();
  });

  it("only looks at the host, not the password or database name", () => {
    const url = "postgresql://u:ep-withered-hill@ep-quiet-dev-123456.neon.tech/ep-withered-hill";
    expect(prodMigrationRefusal({ databaseUrl: url, vercelEnv: undefined })).toBeNull();
  });

  it("never echoes the URL", () => {
    const reason = prodMigrationRefusal({ databaseUrl: PROD_URL, vercelEnv: undefined }) ?? "";
    expect(reason).not.toContain("neon.tech");
    expect(reason).not.toContain("u:p");
  });
});
