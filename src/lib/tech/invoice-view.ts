/**
 * The field invoice screen's GET contract (spec §6.2.1). TYPES ONLY: no
 * server-only, no db imports — the client (`import type`) and the server share
 * it. No cost field ever appears here: technicians see prices, never costs.
 * Timestamps are ISO strings.
 */
import type { InvoiceAction } from "@/lib/tech/invoice-actions";

export type TechInvoiceState = "draft" | "open" | "paid" | "refunded";

export type SignatureState = "none" | "present" | "erased" | "unavailable" | "estimate";

export interface TechInvoiceSignature {
  readonly state: SignatureState;
  readonly signedAt: string | null;
  readonly signatureName: string | null;
  /** Short-lived signed read URL; only when `state === "present"`. */
  readonly url: string | null;
  /** Draft only: the request's signature is at least as new as the invoice's last change. */
  readonly fresh: boolean;
}

export interface TechInvoiceLine {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly lineTotalCents: number;
}

export interface TechInvoicePayment {
  readonly id: string;
  readonly method: string;
  readonly checkNumber: string | null;
  readonly amountCents: number;
  readonly status: string;
  readonly createdAt: string | null;
}

export interface TechInvoice {
  readonly id: string;
  readonly state: TechInvoiceState;
  readonly subtotalCents: number;
  readonly taxCents: number;
  /** Drafts only (the rate the next total recompute uses); null once finalized. */
  readonly taxBps: number | null;
  readonly totalCents: number;
  readonly amountPaidCents: number;
  readonly balanceCents: number;
  readonly issuedAt: string | null;
  readonly updatedAt: string | null;
  readonly fromEstimate: boolean;
  readonly lines: readonly TechInvoiceLine[];
  readonly payments: readonly TechInvoicePayment[];
  readonly signature: TechInvoiceSignature;
}

/** What a helper (non-lead) technician sees of the invoice. */
export type TechInvoiceReduced = Pick<TechInvoice, "id" | "state" | "totalCents" | "balanceCents">;

export interface TechOtherOpenInvoice {
  readonly id: string;
  readonly totalCents: number;
  readonly balanceCents: number;
}

export interface TechInvoiceHistory {
  readonly id: string;
  readonly state: TechInvoiceState | "void";
  readonly totalCents: number;
}

export interface TechUnbilledMaterial {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

export interface TechInvoiceView {
  readonly invoice: TechInvoice | TechInvoiceReduced | null;
  readonly otherOpen: readonly TechOtherOpenInvoice[];
  readonly history: TechInvoiceHistory | null;
  readonly materialsNotOnInvoice: readonly TechUnbilledMaterial[];
  readonly pendingWrite: boolean;
  readonly customerHasPhone: boolean;
  readonly isLead: boolean;
  readonly onSite: boolean;
  readonly externalInvoice: boolean;
  readonly allowed: readonly InvoiceAction[];
}
