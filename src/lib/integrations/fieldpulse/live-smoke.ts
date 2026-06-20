/**
 * FieldPulse LIVE smoke harness — validates the client against the REAL API.
 *
 *   npm run smoke:fieldpulse
 *
 * Reads the key from env (FIELDPULSE_API_KEY) and NEVER hardcodes or logs it.
 * Hits live endpoints and asserts the narrowers actually parse real records —
 * the check that was missing (unit mocks used inferred shapes and hid that the
 * read path was broken: numeric ids, dollar-string money, `.response` envelope).
 *
 * Key-gated + degrade-safe: with no key it prints "skipped" and exits 0, so it
 * never breaks an environment that lacks credentials. NOT part of the CI suite.
 *
 * Optional probes (set these env vars to a real id to exercise invoices):
 *   FIELDPULSE_SMOKE_INVOICE_ID, FIELDPULSE_SMOKE_JOB_ID
 */
import * as dotenv from "dotenv";
import { RestFieldpulseClient } from "./client";
import { FIELDPULSE_BASE_URL } from "./config";

dotenv.config({ path: ".env.local" });

async function main(): Promise<void> {
  const apiKey = process.env.FIELDPULSE_API_KEY?.trim();
  if (!apiKey) {
    console.log("smoke:fieldpulse — skipped (FIELDPULSE_API_KEY not set)");
    return;
  }
  const client = new RestFieldpulseClient({ apiKey, baseUrl: FIELDPULSE_BASE_URL });
  let failures = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  };

  // 1. Connect-time validation path (getAccountInfo → /users → company_id).
  try {
    const info = await client.getAccountInfo();
    check("getAccountInfo validates key + returns accountId", !!info.accountId, `accountId=${info.accountId}`);
  } catch (e) {
    check("getAccountInfo", false, e instanceof Error ? e.message : String(e));
  }

  // 2. User roster parses (envelope unwrap + numeric id coercion).
  try {
    const users = await client.listUsers();
    check("listUsers parses ≥1 real user", users.length > 0, `count=${users.length}, firstId=${users[0]?.id}`);
  } catch (e) {
    check("listUsers", false, e instanceof Error ? e.message : String(e));
  }

  // 3. Single invoice (money parse) — only if an id is provided.
  const invId = process.env.FIELDPULSE_SMOKE_INVOICE_ID?.trim();
  if (invId) {
    try {
      const inv = await client.getInvoice(invId);
      check(
        "getInvoice parses real invoice (cents money)",
        !!inv && typeof inv.totalCents === "number",
        inv
          ? `id=${inv.id} totalCents=${inv.totalCents} amountPaidCents=${inv.amountPaidCents} lineItems=${inv.lineItems?.length ?? 0}`
          : "null",
      );
    } catch (e) {
      check("getInvoice", false, e instanceof Error ? e.message : String(e));
    }
  } else {
    console.log("SKIP  getInvoice (set FIELDPULSE_SMOKE_INVOICE_ID to exercise)");
  }

  // 4. Per-job invoices (client-side job_id filter).
  const jobId = process.env.FIELDPULSE_SMOKE_JOB_ID?.trim();
  if (jobId) {
    try {
      const list = await client.listJobInvoices(jobId);
      const allMatch = list.every((i) => i.jobId === jobId);
      check("listJobInvoices filters to the job", allMatch, `count=${list.length}`);
    } catch (e) {
      check("listJobInvoices", false, e instanceof Error ? e.message : String(e));
    }
  } else {
    console.log("SKIP  listJobInvoices (set FIELDPULSE_SMOKE_JOB_ID to exercise)");
  }

  console.log(failures === 0 ? "\nALL LIVE CHECKS PASSED" : `\n${failures} LIVE CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("smoke:fieldpulse crashed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
