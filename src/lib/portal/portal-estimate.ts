/**
 * Pure: the amount and status a customer sees for one estimate in the portal.
 *
 * `estimates.total_cents` is the HEADLINE figure (the most expensive option,
 * set at creation and never changed on approval), so it is wrong once the
 * customer picks a cheaper option and ambiguous while several are open.
 * - sold: the sold option's own total, "Approved", and that option's name.
 * - open / declined / expired with options: the single option's total, or the
 *   low–high range with the option count.
 * - no option rows (e.g. a synced estimate): the stored total.
 */

export interface PortalEstimateOption {
  readonly id: string;
  readonly name: string;
  readonly totalCents: number;
}

export type PortalEstimateAmount =
  | { readonly kind: "single"; readonly cents: number }
  | { readonly kind: "range"; readonly minCents: number; readonly maxCents: number };

export interface PortalEstimateDisplay {
  readonly amount: PortalEstimateAmount;
  readonly statusLabel: string;
  /** The approved option's name (sold only), else null. */
  readonly optionName: string | null;
  /** How many options the range spans (range only), else null. */
  readonly optionCount: number | null;
}

const STATUS_LABEL: Readonly<Record<string, string>> = {
  open: "Open",
  sold: "Approved",
  dismissed: "Declined",
  expired: "Expired",
};

export function portalEstimateDisplay(input: {
  readonly status: string;
  readonly totalCents: number;
  readonly soldOptionId: string | null;
  readonly awaitingApproval: boolean;
  readonly options: readonly PortalEstimateOption[];
}): PortalEstimateDisplay {
  const { status, totalCents, soldOptionId, awaitingApproval, options } = input;
  const statusLabel =
    status === "open" && awaitingApproval
      ? "Awaiting your approval"
      : (STATUS_LABEL[status] ?? "Open");

  if (status === "sold") {
    const sold = soldOptionId ? options.find((o) => o.id === soldOptionId) : undefined;
    return {
      amount: { kind: "single", cents: sold ? sold.totalCents : totalCents },
      statusLabel,
      optionName: sold?.name ?? null,
      optionCount: null,
    };
  }

  if (options.length === 0) {
    return { amount: { kind: "single", cents: totalCents }, statusLabel, optionName: null, optionCount: null };
  }

  const totals = options.map((o) => o.totalCents);
  const minCents = Math.min(...totals);
  const maxCents = Math.max(...totals);
  if (options.length === 1 || minCents === maxCents) {
    return { amount: { kind: "single", cents: minCents }, statusLabel, optionName: null, optionCount: null };
  }
  return {
    amount: { kind: "range", minCents, maxCents },
    statusLabel,
    optionName: null,
    optionCount: options.length,
  };
}
