/**
 * Pure step logic for the S40 "Customer approval" sheet (spec §7.3): the
 * request-level SIGNATURE goes first, then FINALIZE (which snapshots it onto
 * the invoice). Tests run in node.
 *
 * `captured` (additive to the brief's interface) disambiguates the brief's
 * "pad captured" rows: the pad's Blob is held by the sheet until it is sent.
 */
import type { TechInvoiceState } from "./invoice-view";
import type { IntentKind } from "./invoice-view-diff";

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

/** The one message for a signature that did not land (sheet, page banner, job page). */
export const SIGNATURE_DIDNT_SAVE = "The signature didn't save. Try again.";
/** The banner's text; its own "Try again" button completes the same message. */
export const SIGNATURE_DIDNT_SAVE_BANNER = "The signature didn't save.";

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

export type ApprovalFailure = "signature" | "finalize" | null;

/**
 * The approval button's label: "Try again" after a failed send of the step it
 * re-runs (the signature on send_signature, finalize on send_finalize once the
 * signature landed); otherwise "Approve and finalize".
 */
export function approvalButtonLabel(step: ApprovalStep, lastFailure: ApprovalFailure): string {
  if (step === "send_signature" && lastFailure === "signature") return "Try again";
  if (step === "send_finalize" && lastFailure === "finalize") return "Try again";
  return "Approve and finalize";
}

/**
 * "Customer not here? Finalize without signature" is offered while no
 * signature has landed for this approval (pad shown or a capture not yet sent).
 */
export function noSignatureOffered(step: ApprovalStep): boolean {
  return step === "show_pad" || step === "send_signature";
}

export const NO_SIGNATURE_PROMPT = "Customer not here?";
export const NO_SIGNATURE_ACTION = "Finalize without signature";

/** The pad is drawn only before a capture; later steps show the captured image. */
export function padVisible(step: ApprovalStep): boolean {
  return step === "show_pad";
}

export type UnknownBanner =
  | { readonly action: "open_approval"; readonly text: string }
  | { readonly action: "retry"; readonly kind: IntentKind; readonly text: string };

/**
 * The page's "may not have saved" banner. A signature body (a Blob) is held
 * only by the approval sheet, so its "Try again" opens that sheet; every other
 * kind re-sends its stored body with the same key.
 */
export function unknownBanner(kinds: readonly IntentKind[]): UnknownBanner | null {
  const first = kinds[0];
  if (first === undefined) return null;
  if (first === "signature") {
    return { action: "open_approval", text: SIGNATURE_DIDNT_SAVE_BANNER };
  }
  return { action: "retry", kind: first, text: "Your last change may not have saved." };
}

/** Approval is offered only while no OTHER intent (a line add/remove…) is unknown. */
export function approvalBlocked(kinds: readonly IntentKind[]): boolean {
  return kinds.some((k) => k !== "signature" && k !== "finalize");
}
