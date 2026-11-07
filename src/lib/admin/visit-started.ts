/**
 * "Started" (M2 spec §3.2): a live lead row en route, arrived, in progress or
 * completed, or on hold with a progress timestamp (a pause); a live helper row
 * en route, arrived, in progress or paused. Timestamps alone don't count; they
 * only tell a pause from an untouched on_hold. Status counts because the
 * trigger mirrors request status onto an untouched lead row (0050:147–159).
 * Pure `rowStarted` and its SQL twin `startedRowSql`; aliases are trusted
 * literals checked against a plain-identifier pattern.
 */
import { sql, type SQL } from "drizzle-orm";
import { STARTED_ASSIGNMENT_STATUSES } from "./request-status";

/** A helper is started only while working (or paused). */
export const WORKING_STATUSES = ["en_route", "arrived", "in_progress"] as const;

export interface StartedRowInput {
  readonly status: string;
  readonly isLead: boolean;
  readonly hasTimestamp: boolean;
}

export function rowStarted(row: StartedRowInput): boolean {
  if (row.status === "cancelled") return false;
  if (row.status === "on_hold") return row.hasTimestamp;
  const list: readonly string[] = row.isLead ? STARTED_ASSIGNMENT_STATUSES : WORKING_STATUSES;
  return list.includes(row.status);
}

const ALIAS = /^[a-z][a-z0-9_]*$/;
function alias(a: string): string {
  if (!ALIAS.test(a)) throw new Error(`bad SQL alias: ${a}`);
  return a;
}

/** Any of the four progress stamps on row `a`. Parenthesised: it holds OR. */
export function anyTimestampSql(a: string): SQL {
  return sql.raw(anyTimestampText(alias(a)));
}

/** SQL twin of rowStarted for assignment row `a`. */
export function startedRowSql(a: string): SQL {
  const x = alias(a);
  const working = WORKING_STATUSES.map((s) => `'${s}'::request_status`).join(", ");
  return sql.raw(
    `(${x}.status <> 'cancelled'::request_status AND (${x}.status IN (${working})` +
      ` OR (${x}.status = 'on_hold'::request_status AND ${anyTimestampText(x)})` +
      ` OR (${x}.is_lead AND ${x}.status = 'completed'::request_status)))`,
  );
}

function anyTimestampText(x: string): string {
  return `(${x}.en_route_at IS NOT NULL OR ${x}.arrived_at IS NOT NULL OR ${x}.started_at IS NOT NULL OR ${x}.completed_at IS NOT NULL)`;
}
