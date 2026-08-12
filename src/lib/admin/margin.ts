/**
 * Stage 10 — job costing / margin visibility (ADMIN-ONLY).
 *
 * Margin = revenue minus snapshotted cost, both in integer cents.
 *   marginCents = revenueCents - costCents
 *   marginPct   = revenueCents > 0 ? (revenueCents - costCents) / revenueCents : 0
 *
 * marginPct is a RATIO (e.g. 0.4 = 40%), not cents — so it is the only value
 * here that is not an integer. Cents are never rounded. costCents is sensitive
 * internal data: callers MUST keep it out of public/customer-facing surfaces.
 */
export interface Margin {
  readonly marginCents: number;
  readonly marginPct: number;
}

export interface MarginRollup {
  readonly revenueCents: number;
  readonly costCents: number;
  readonly marginCents: number;
  readonly marginPct: number;
}

/** Margin for a single revenue/cost pair. Negative when cost exceeds revenue. */
export function computeMargin(revenueCents: number, costCents: number): Margin {
  const marginCents = revenueCents - costCents;
  const marginPct = revenueCents > 0 ? marginCents / revenueCents : 0;
  return { marginCents, marginPct };
}

/** A line whose revenue (lineTotalCents) and snapshotted cost roll up to a total. */
export interface MarginLine {
  readonly costCents: number;
  readonly lineTotalCents: number;
}

/**
 * Sum line revenue + cost, then compute the rolled-up margin over the set.
 *
 * `discountCents` is a header-level discount applied AFTER the line sum —
 * FieldPulse mirrors carry it in spillover, not on lines, so summing lines
 * alone overstates revenue (a fully-discounted invoice would show its whole
 * line sum as revenue at 100% margin). Revenue clamps at zero: a discount can
 * erase revenue, never mint negative revenue.
 */
export function rollUpMargin(
  lines: readonly MarginLine[],
  discountCents = 0,
): MarginRollup {
  const lineSumCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
  const revenueCents = Math.max(0, lineSumCents - discountCents);
  const costCents = lines.reduce((sum, l) => sum + l.costCents, 0);
  const { marginCents, marginPct } = computeMargin(revenueCents, costCents);
  return { revenueCents, costCents, marginCents, marginPct };
}

/**
 * Header discount from a FieldPulse spillover blob, in integer cents.
 * FP sends dollars as a string ("182.00"); anything missing, malformed, or
 * negative is 0 — a bad value must never inflate or invent a discount.
 */
export function fpDiscountCents(
  fieldpulseData: Record<string, unknown> | null | undefined,
): number {
  const raw = fieldpulseData?.["discount"];
  if (raw === null || raw === undefined || raw === "") return 0;
  const n = Number.parseFloat(String(raw));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

/** A material a tech actually used: snapshotted unit cost × quantity. */
export interface ActualMaterial {
  readonly quantity: number;
  readonly unitCostCents: number;
}

/**
 * ACTUAL materials cost for a job: sum of (unitCostCents × quantity) over the
 * materials the tech recorded on-site. This is the real cost incurred, distinct
 * from the estimate's snapshotted line cost — present BOTH on the invoice, never
 * silently overwrite the estimated figure. Pure (integer cents).
 */
export function rollUpActualMaterialsCost(
  materials: readonly ActualMaterial[],
): number {
  return materials.reduce((sum, m) => sum + m.unitCostCents * m.quantity, 0);
}

/** A closed time entry's snapshotted labor cost (already rounded at clock-out). */
export interface ActualLaborEntry {
  readonly laborCostCents: number | null;
}

/**
 * ACTUAL labor cost for a job: sum of the snapshotted laborCostCents over the
 * tech's CLOSED time entries. Open entries (NULL laborCostCents) contribute 0 —
 * a job that's still on the clock has no realized labor cost yet. This is the
 * real labor incurred; on the invoice the actual margin subtracts BOTH actual
 * materials AND this, distinct from the estimate. Pure (integer cents).
 */
export function rollUpActualLaborCost(
  entries: readonly ActualLaborEntry[],
): number {
  return entries.reduce((sum, e) => sum + (e.laborCostCents ?? 0), 0);
}
