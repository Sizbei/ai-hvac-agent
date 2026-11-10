import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requiredEnvNames } from "@/lib/env-validation";
import { envCheck, migrationTagMismatch, parseVercelEnvLs } from "./env-check";

// Hand-made in the documented `vercel env ls` table layout (CLI 50); NOT
// captured from a real run — the CLI was signed out when this was written.
const FIXTURE = readFileSync(join(__dirname, "vercel-env-ls.fixture.txt"), "utf8");

describe("parseVercelEnvLs", () => {
  it("returns the name column of every table row", () => {
    expect(parseVercelEnvLs(FIXTURE)).toEqual([
      "DATABASE_URL",
      "AUTH_SECRET",
      "ENCRYPTION_KEY",
      "CRON_SECRET",
      "NEXT_PUBLIC_APP_URL",
      "PLATFORM_ADMIN_EMAILS",
      "PLATFORM_ORG_ID",
      "AI_API_KEY",
    ]);
  });

  it("ignores the banner, the found-for line and the header row", () => {
    const names = parseVercelEnvLs(FIXTURE);
    expect(names).not.toContain("name");
    expect(names).not.toContain("Vercel");
    expect(names).not.toContain(">");
  });

  it("returns an empty list when there is no table", () => {
    expect(parseVercelEnvLs("")).toEqual([]);
    expect(parseVercelEnvLs("Vercel CLI 50.1.3\n> No Environment Variables found for x/y [90ms]\n")).toEqual([]);
  });

  it("returns each name once", () => {
    const doubled = `${FIXTURE}\n name  value  environments  created\n DATABASE_URL  Encrypted  Preview  1d ago\n`;
    expect(parseVercelEnvLs(doubled).filter((n) => n === "DATABASE_URL")).toHaveLength(1);
  });
});

describe("envCheck", () => {
  const required = [...requiredEnvNames(), "PLATFORM_ADMIN_EMAILS", "PLATFORM_ORG_ID"];
  const forbidden = ["DEMO_MODE_ORG_IDS"];

  it("missing DEMO-free list passes", () => {
    const result = envCheck({ required, forbidden, present: parseVercelEnvLs(FIXTURE) });
    expect(result).toEqual({ missing: [], forbiddenPresent: [] });
  });

  it("DEMO_MODE_ORG_IDS present fails", () => {
    const present = [...parseVercelEnvLs(FIXTURE), "DEMO_MODE_ORG_IDS"];
    expect(envCheck({ required, forbidden, present }).forbiddenPresent).toEqual(["DEMO_MODE_ORG_IDS"]);
  });

  it("lists every required name that is absent, in required order", () => {
    const present = parseVercelEnvLs(FIXTURE).filter((n) => n !== "AUTH_SECRET" && n !== "PLATFORM_ORG_ID");
    expect(envCheck({ required, forbidden, present }).missing).toEqual(["AUTH_SECRET", "PLATFORM_ORG_ID"]);
  });

  it("treats an empty present list as everything missing", () => {
    expect(envCheck({ required, forbidden, present: [] }).missing).toEqual(required);
  });

  it("output contains no '='", () => {
    const result = envCheck({ required, forbidden, present: ["DEMO_MODE_ORG_IDS"] });
    const text = JSON.stringify(result);
    expect(text).not.toContain("=");
  });
});

describe("requiredEnvNames", () => {
  it("lists only the required variables", () => {
    expect(requiredEnvNames()).toEqual([
      "DATABASE_URL",
      "AUTH_SECRET",
      "ENCRYPTION_KEY",
      "CRON_SECRET",
      "NEXT_PUBLIC_APP_URL",
    ]);
  });
});

describe("migrationTagMismatch", () => {
  const files = ["0058_m3d_forms.sql", "0001_init.sql", "0059_golive.sql"];

  it("passes when the newest sql file is the last journal tag", () => {
    expect(migrationTagMismatch(files, ["0001_init", "0058_m3d_forms", "0059_golive"])).toBeNull();
  });

  it("fails when a sql file has no journal entry", () => {
    expect(migrationTagMismatch([...files, "0060_onboarding.sql"], ["0001_init", "0059_golive"])).toBe(
      "newest migration file 0060_onboarding is not the last journal entry (0059_golive)",
    );
  });

  it("fails when there are no migrations at all", () => {
    expect(migrationTagMismatch([], [])).toBe("no migrations found in drizzle/");
  });
});
