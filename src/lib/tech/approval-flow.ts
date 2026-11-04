/**
 * Pure step logic for the S40 "Customer approval" sheet (spec §7.3): the
 * request-level SIGNATURE goes first, then FINALIZE (which snapshots it onto
 * the invoice). Tests run in node.
 *
 * `captured` (additive to the brief's interface) disambiguates the brief's
 * "pad captured" rows: the pad's Blob is held by the sheet until it is sent.
 */
import type { TechInvoiceState } from "./invoice-view";

export type ApprovalStep = "show_pad" | "send_signature" | "send_finalize" | "done";
export type SendStatus = "idle" | "sent" | "ok" | "failed";

export interface ApprovalInput {
  readonly signatureFresh: boolean;
  readonly signatureSent: SendStatus;
  readonly finalizeSent: SendStatus;
  readonly state: TechInvoiceState;
  /** The pad's capture (Blob + name) is held, not yet landed. */
  readonly captured?: boolean;
}

export const ZERO_TOTAL_COPY = "Nothing to collect. This closes the invoice at $0 and locks the lines.";

/**
 * open/paid → done; draft + (signatureFresh || signature ok) → send_finalize
 * (also after a failed finalize: only finalize is retried, the pad stays
 * hidden); draft + captured → send_signature (idle, failed or in flight);
 * otherwise show_pad.
 */
export function approvalStep(i: ApprovalInput): ApprovalStep {
  if (i.state !== "draft" || i.finalizeSent === "ok") return "done";
  if (i.signatureFresh || i.signatureSent === "ok") return "send_finalize";
  if (i.captured) return "send_signature";
  return "show_pad";
}

/** The pad is drawn only before a capture; later steps show the captured image. */
export function padVisible(step: ApprovalStep): boolean {
  return step === "show_pad";
}
