/**
 * Accounting provider SEAM (parity Stage 10 — QuickBooks / accounting export).
 *
 * The only surface the export route calls to decide HOW the journal is
 * serialized. A real QuickBooks Online adapter (OAuth: pushes a journal entry
 * via the QBO API) drops in behind this interface when QBO_CLIENT_ID/
 * QBO_CLIENT_SECRET are configured; until then getAccountingProvider() returns a
 * deterministic MOCK that serializes to a downloadable CSV/IIF file so the whole
 * export flow is buildable and testable WITHOUT live credentials (mirrors the
 * payments + financing seams).
 *
 * READ-ONLY: this seam never writes to money tables. It only formats already-
 * queried, period-scoped journal lines. Money is converted cents->dollars at the
 * export boundary (in accounting-export.ts), never here and never in the DB.
 */
import type { JournalLine } from "@/lib/admin/accounting-export";
import { buildCsv } from "@/lib/admin/accounting-export";

export interface AccountingProvider {
  /** "mock" | "quickbooks" — recorded in the audit log for traceability. */
  readonly name: string;
  /** File extension for the serialized export (e.g. "csv"). */
  readonly fileExtension: string;
  /** MIME type for the download response. */
  readonly contentType: string;
  /** Serialize a period journal to the provider's file format. */
  format(journal: readonly JournalLine[]): string;
}

/**
 * Deterministic provider used when no real accounting integration is configured.
 * Produces a QBO-importable CSV (a flat journal: one row per line). It never
 * talks to an external service — the operator downloads the file and imports it
 * into QuickBooks (or any ledger) manually.
 */
export class MockAccountingProvider implements AccountingProvider {
  readonly name = "mock";
  readonly fileExtension = "csv";
  readonly contentType = "text/csv";

  format(journal: readonly JournalLine[]): string {
    return buildCsv(journal);
  }
}

/**
 * Resolve the active accounting provider. Returns the live integration when
 * configured, else the mock. TODO(quickbooks): instantiate a
 * QuickBooksAccountingProvider (OAuth via QBO_CLIENT_ID/QBO_CLIENT_SECRET, reuse
 * the per-org encrypted-credential pattern) when the adapter lands.
 */
export function getAccountingProvider(): AccountingProvider {
  const qboClientId = process.env.QBO_CLIENT_ID?.trim();
  const qboClientSecret = process.env.QBO_CLIENT_SECRET?.trim();
  if (qboClientId && qboClientSecret) {
    // LOUD warning: credentials are present but the QuickBooks adapter isn't
    // built yet, so we're still producing the CSV export. Without this an
    // operator who sets QBO_CLIENT_ID would believe entries are syncing to
    // QuickBooks when they are not. Swap this for
    // `new QuickBooksAccountingProvider(...)` when the adapter lands.
    console.error(
      "[accounting] QBO_CLIENT_ID/QBO_CLIENT_SECRET are set but the QuickBooks adapter is not implemented — using MockAccountingProvider (CSV export only). NO DATA IS SYNCED TO QUICKBOOKS.",
    );
    return new MockAccountingProvider();
  }
  return new MockAccountingProvider();
}
