/**
 * GET /api/tech/jobs/[id]/estimates contract (M3c spec §6, plus requestStatus
 * and priorInvoicePaid — plan ruling 1). TYPES ONLY: shared by the server and
 * client components. Never a cost field, never the typed signature name.
 */
export type TechEstimateStatus = "open" | "sold" | "expired" | "declined";
export type EstimateBilling = "office" | "job" | "none";

export interface TechEstimateLine {
  readonly id: string;
  readonly pricebookItemId: string | null;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly lineTotalCents: number;
}

export interface TechEstimateOption {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly lines: readonly TechEstimateLine[];
}

export interface TechEstimate {
  readonly id: string;
  /** "Estimate · Nov 6 · 2 options" (creation day, business timezone). */
  readonly label: string;
  readonly status: TechEstimateStatus;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly signedAt: string | null;
  readonly soldOptionId: string | null;
  readonly soldVia: string | null;
  readonly soldByMe: boolean;
  readonly hasApprovalLink: boolean;
  readonly billing: EstimateBilling;
  readonly billingInvoiceId: string | null;
  readonly options: readonly TechEstimateOption[];
}

export interface TechJobInvoiceRef {
  readonly id: string;
  readonly state: "draft" | "open";
  readonly hasPayment: boolean;
}

export interface TechEstimatesView {
  readonly companyName: string | null;
  readonly customerDisplayName: string | null;
  readonly isLead: boolean;
  readonly canCreate: boolean;
  readonly createBlockedReason: string | null;
  readonly taxBps: number;
  readonly requestStatus: string;
  readonly hasOtherSold: boolean;
  /** The request's newest live native invoice. */
  readonly jobInvoice: TechJobInvoiceRef | null;
  /** A paid or refunded native invoice exists (a bill now starts a new invoice). */
  readonly priorInvoicePaid: boolean;
  readonly estimates: readonly TechEstimate[];
}
