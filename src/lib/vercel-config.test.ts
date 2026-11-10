import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const config = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as {
  regions?: string[];
  crons: { path: string; schedule: string }[];
};

const EXPECTED_CRONS = [
  ["/api/cron/cleanup", "0 3 * * *"],
  ["/api/cron/webhook-cleanup", "0 4 * * *"],
  ["/api/cron/process-communications", "0 5 * * *"],
  ["/api/cron/booking-recovery", "0 6 * * *"],
  ["/api/cron/reconcile-payments", "0 7 * * *"],
  ["/api/cron/dunning", "0 8 * * *"],
  ["/api/cron/generate-membership-visits", "0 9 * * *"],
  ["/api/cron/sync-fieldpulse-availability", "0 10 * * *"],
  ["/api/cron/sync-fieldpulse-invoices", "0 11 * * *"],
  ["/api/cron/sync-housecall-invoices", "0 12 * * *"],
  ["/api/cron/delay-sweep", "0 13 * * *"],
  ["/api/cron/dispatch-digest", "0 12 * * 1"],
].map(([path, schedule]) => ({ path, schedule }));

describe("vercel.json", () => {
  it("pins the function region to iad1 only (next to Neon us-east-1)", () => {
    expect(config.regions).toEqual(["iad1"]);
  });

  it("keeps every existing cron entry unchanged", () => {
    expect(config.crons).toEqual(EXPECTED_CRONS);
  });
});
