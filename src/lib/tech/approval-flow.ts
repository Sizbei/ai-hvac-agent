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
    return { action: "open_approval", text: "Your last signature may not have saved. Open Customer approval and try again." };
  }
  return { action: "retry", kind: first, text: "Your last change may not have saved." };
}

/** Approval is offered only while no OTHER intent (a line add/remove…) is unknown. */
export function approvalBlocked(kinds: readonly IntentKind[]): boolean {
  return kinds.some((k) => k !== "signature" && k !== "finalize");
}
