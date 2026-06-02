/**
 * Read-side types for the admin audit-log viewer. The write side lives in
 * audit.ts (logAudit) and a handful of direct inserts (e.g. deleteCustomer).
 */

export interface AuditLogEntry {
  readonly id: string;
  readonly action: string;
  readonly entity: string;
  readonly entityId: string | null;
  /** Actor display name, or null for system/unauthenticated actions. */
  readonly actorName: string | null;
  readonly sessionId: string | null;
  /** Free-form JSON string; we only ever log field names, never PII values. */
  readonly details: string | null;
  readonly ipAddress: string | null;
  readonly createdAt: string;
}

export interface AuditLogFilters {
  /** Exact-match action filter (e.g. "customer_updated"). */
  readonly action?: string;
  /** Exact-match entity filter (e.g. "customers"). */
  readonly entity?: string;
  readonly page?: number;
  readonly limit?: number;
}

export interface AuditLogPage {
  readonly entries: readonly AuditLogEntry[];
  readonly total: number;
  /** The distinct action values present for this org — drives the filter UI. */
  readonly actions: readonly string[];
}
