/**
 * Pure display helpers for /admin/operations (no I/O). Every card states what
 * its number measures and how many items stand behind it, so a long range with
 * one odd request reads as "1 request", not as a trend.
 */
import type { OperationsMetrics } from "./operations-metrics-types";

/** Adaptive duration formatter: seconds → the most readable unit. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const s = Math.abs(seconds);
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${(s / 3600).toFixed(1)} hrs`;
  return `${(s / 86400).toFixed(1)} days`;
}

/** "1 request" / "3 requests". */
export function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** "Response time": the definition, the sample, and time on site when known. */
export function responseSublabel(
  m: Pick<OperationsMetrics, "onSiteSeconds" | "samples">,
): string {
  const parts = [
    "Median from booking to a technician on site",
    countOf(m.samples.response, "request"),
  ];
  if (m.onSiteSeconds !== null) parts.push(`${formatDuration(m.onSiteSeconds)} avg on site`);
  return parts.join(" · ");
}

/** "Time to paid": the definition, the sample, invoices paid at the visit. */
export function timeToPaidSublabel(m: Pick<OperationsMetrics, "samples">): string {
  const parts = [
    "Median from invoice to final payment",
    countOf(m.samples.timeToPaid, "invoice"),
  ];
  if (m.samples.paidAtVisit > 0) parts.push(`${m.samples.paidAtVisit} paid at the visit, not counted`);
  parts.push("your invoices only, not FieldPulse/HCP");
  return parts.join(" · ");
}

/** "First response — dispatcher": the definition, the sample, auto-dispatch when it ran. */
export function dispatcherSublabel(
  m: Pick<OperationsMetrics, "samples" | "firstResponseSystemSeconds">,
): string {
  const parts = [
    "Median wait for a dispatcher to assign a new request",
    countOf(m.samples.firstResponseHuman, "request"),
  ];
  if (m.firstResponseSystemSeconds !== null) {
    parts.push(`auto-dispatch assigns in ${formatDuration(m.firstResponseSystemSeconds)} on average`);
  }
  return parts.join(" · ");
}

/** "Dispatch health" in owner words (no "commit rate", "preview", "overrides"). */
export function dispatchHealthSublabel(
  d: Pick<OperationsMetrics["dispatchHealth"], "real" | "shadow" | "overrides">,
): string {
  const parts = [
    "Share of autopilot decisions that assigned a technician, last 7 days",
    countOf(d.real.total + d.shadow.total, "decision"),
  ];
  if (d.shadow.total > 0) parts.push(`${d.shadow.total} suggested only`);
  parts.push(`${d.overrides} changed by a dispatcher`);
  return parts.join(" · ");
}

/**
 * "Requests booked": the booking rate in a unit that reads (18 in a year is
 * "0.3 / week avg", not "0.0 / day avg"), plus imported jobs in the window.
 */
export function bookedSublabel(booked: number, rangeDays: number, imported: number): string {
  const perDay = booked / Math.max(1, rangeDays);
  const rate = perDay >= 1 || booked === 0
    ? `${perDay.toFixed(1)} / day avg`
    : `${(perDay * 7).toFixed(1)} / week avg`;
  return `Booked here · ${rate}` + (imported > 0 ? ` · +${imported} imported` : "");
}
