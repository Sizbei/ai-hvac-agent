/**
 * Pure presentation logic for the invoice detail view.
 *
 * Extracted from InvoiceDetailClient so the money-safety affordances — most
 * importantly that a read-only FSM-synced invoice NEVER exposes the native
 * take-payment control — are unit-testable in the repo's node test env (there is
 * no component-render harness). The component renders straight off this, so the
 * tested rule and the rendered rule cannot drift.
 */
export type SyncedSource = "fieldpulse" | "housecall" | null;

export interface InvoicePresentationInput {
  readonly state: string;
  readonly totalCents: number;
  readonly amountPaidCents: number;
  readonly syncedSource: SyncedSource;
}

export interface InvoicePresentation {
  /** totalCents - amountPaidCents (may be negative if over-collected upstream). */
  readonly balanceCents: number;
  /** True when this row is a read-only mirror of an FSM invoice. */
  readonly isSynced: boolean;
  /** Human label for the FSM source, or null for a native invoice. */
  readonly sourceLabel: "FieldPulse" | "Housecall Pro" | null;
  /** State + balance would allow a native charge (IGNORES source). */
  readonly isChargeable: boolean;
  /**
   * Whether the native take-payment control may be shown: chargeable AND not a
   * read-only synced mirror. THE money-safety affordance — a synced invoice is
   * billed in its FSM, so charging it here would double-charge.
   */
  readonly canTakePayment: boolean;
}

export function deriveInvoicePresentation(
  inv: InvoicePresentationInput,
): InvoicePresentation {
  const balanceCents = inv.totalCents - inv.amountPaidCents;
  const isSynced = inv.syncedSource !== null;
  const sourceLabel =
    inv.syncedSource === "fieldpulse"
      ? "FieldPulse"
      : inv.syncedSource === "housecall"
        ? "Housecall Pro"
        : null;
  const isChargeable =
    (inv.state === "open" || inv.state === "draft") && balanceCents > 0;
  const canTakePayment = isChargeable && !isSynced;
  return { balanceCents, isSynced, sourceLabel, isChargeable, canTakePayment };
}
