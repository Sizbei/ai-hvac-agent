/**
 * Pure: what the public estimate link shows once the estimate is no longer
 * open, so a customer reopening it sees a record of what they approved (option,
 * price, date, signer) instead of "already decided / nothing more to do".
 */

import { OFFICE_SIGNATURE } from "@/lib/tech/estimate-input";

export interface EstimateDecisionInput {
  readonly status: string;
  readonly soldOptionName: string | null;
  /** Pre-formatted price of the sold option (the page owns money formatting). */
  readonly soldTotal: string | null;
  /** Pre-formatted date the estimate was signed/marked sold. */
  readonly signedOn: string | null;
  readonly signatureName: string | null;
}

export interface EstimateDecisionCopy {
  readonly title: string;
  readonly body: string;
}

export function estimateDecisionCopy(input: EstimateDecisionInput): EstimateDecisionCopy {
  const { status, soldOptionName, soldTotal, signedOn, signatureName } = input;
  if (status === "sold") {
    const what =
      soldOptionName && soldTotal
        ? `${soldOptionName} for ${soldTotal}`
        : soldOptionName ?? soldTotal ?? "this estimate";
    const signer =
      signatureName && signatureName !== OFFICE_SIGNATURE ? ` Signed by ${signatureName}` : "";
    const when = signedOn ? `${signer ? " on" : " Approved on"} ${signedOn}` : "";
    const tail = signer || when ? `${signer}${when}.` : "";
    return {
      title: "Estimate approved",
      body: `You approved ${what}.${tail ? ` ${tail.trim()}` : ""} We'll be in touch to schedule the work.`,
    };
  }
  if (status === "expired") {
    return {
      title: "This estimate has expired",
      body: "Please contact us and we'll be happy to send you an updated quote.",
    };
  }
  return {
    title: "This estimate is closed",
    body: "It's no longer open for approval. Please contact us with any questions.",
  };
}

/**
 * Why "Approve & sign" is still disabled, shown under it (null once ready).
 * The button used to sit greyed out with no hint (round-2 UX P2-7).
 */
export function approveBlockedHint(
  optionChosen: boolean,
  signatureOk: boolean,
): string | null {
  if (!optionChosen && !signatureOk) return "Choose an option and type your name to approve.";
  if (!optionChosen) return "Choose an option to approve.";
  if (!signatureOk) return "Type your full name to approve.";
  return null;
}
